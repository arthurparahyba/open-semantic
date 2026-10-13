import { useState } from "react";

import type { CanvasObject, DiagramModel, KnowledgeStatus, Point, Rect, WorkspaceSnapshot } from "@open-semantic/protocol";

import { FIRST_MESSAGE, LANE_GUTTER, LANE_PAD, MESSAGE_STEP, NODE_HEIGHT, isReply, layerOf, layerOrder, messageOrder } from "@open-semantic/workspace-store/diagramShapes";

import { run } from "./client.js";

interface Props {
  diagram: DiagramModel;
  object: CanvasObject;
  snapshot: WorkspaceSnapshot;
  zoom: number;
  highlighted: boolean;
  highlightIds: ReadonlySet<string>;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onResizePointerDown(event: React.PointerEvent): void;
  onFocus(): void;
  onError(message: string): void;
}

type Quality = KnowledgeStatus | "broken" | "none";

const QUALITY_LABEL: Record<Quality, string> = {
  verified: "verificado",
  inferred: "inferido (suposição)",
  pending: "pendente",
  stale: "desatualizado",
  invalid: "inválido",
  rejected: "rejeitado",
  broken: "vínculo quebrado",
  none: "sem vínculo",
};

/**
 * Diagrama no canvas. A qualidade (verificado, inferido, desatualizado) não fica no diagrama:
 * é lida do Open Semantic na hora de desenhar (docs/funcionalidades/03-diagram-engine.md).
 */
export function DiagramView({ diagram, object, snapshot, zoom, highlighted, highlightIds, onHeaderPointerDown, onResizePointerDown, onFocus, onError }: Props) {
  const [drag, setDrag] = useState<{ nodeId: string; start: Point; origin: Point; position: Point } | null>(null);
  const entities = new Map(snapshot.semantic.entities.map((e) => [e.id, e]));
  const relations = new Map(snapshot.semantic.relations.map((r) => [r.id, r]));

  const nodeQuality = (id?: string): Quality => (id ? (entities.get(id)?.status ?? "broken") : "none");
  const edgeQuality = (id?: string): Quality => (id ? (relations.get(id)?.status ?? "broken") : "none");

  const rectOf = (nodeId: string): Rect | undefined => {
    const rect = diagram.layout.nodes[nodeId];
    if (!rect) return undefined;
    return drag?.nodeId === nodeId ? { ...rect, position: drag.position } : rect;
  };

  const remove = async () => {
    if (!window.confirm(`Excluir o diagrama “${diagram.title}”? O Open Semantic e os arquivos não mudam.`)) return;
    const result = await run("diagram.delete", { diagramId: diagram.id });
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível excluir o diagrama.");
  };

  const onNodePointerDown = (nodeId: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    const origin = diagram.layout.nodes[nodeId]!.position;
    setDrag({ nodeId, start: { x: event.clientX, y: event.clientY }, origin, position: origin });
  };
  const onNodePointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    setDrag({
      ...drag,
      position: {
        x: Math.round(drag.origin.x + (event.clientX - drag.start.x) / zoom),
        y: Math.round(Math.max(40, drag.origin.y + (event.clientY - drag.start.y) / zoom)),
      },
    });
  };
  const onNodePointerUp = async () => {
    if (!drag) return;
    const { nodeId, position, origin } = drag;
    if (position.x === origin.x && position.y === origin.y) {
      setDrag(null);
      return;
    }
    const result = await run("diagram.move_node", { diagramId: diagram.id, nodeId, position });
    setDrag(null);
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível mover o nó.");
  };

  // Faixas e sequência têm posições fixas pela gramática; árvore e caixas e setas aceitam arraste.
  const fixed = diagram.kind === "layers" || diagram.kind === "sequence";
  const sequence = diagram.kind === "sequence";
  const hasInferred =
    diagram.nodes.some((n) => nodeQuality(n.semanticEntityId) === "inferred") ||
    diagram.edges.some((e) => edgeQuality(e.semanticRelationId) === "inferred");

  return (
    <section className={`mod diagram${highlighted ? " is-highlighted" : ""}`} data-testid="diagram" data-diagram-id={diagram.id}>
      <header className="mod-header diagram-header" onPointerDown={onHeaderPointerDown} onDoubleClick={onFocus} title="Arraste para mover · duplo clique para enquadrar">
        <span className="mod-icon" aria-hidden>
          ◇
        </span>
        <span className="mod-title">{diagram.title}</span>
        <span className="mod-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={onFocus} title="Enquadrar" aria-label="Enquadrar">
            ⤢
          </button>
          <button type="button" onClick={() => void remove()} title="Excluir diagrama" aria-label="Excluir">
            ×
          </button>
        </span>
      </header>
      <svg className="diagram-svg" width={object.size.width} height={object.size.height} onPointerMove={onNodePointerMove} onPointerUp={() => void onNodePointerUp()}>
        <defs>
          <marker id={`arrow-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="diagram-arrow" />
          </marker>
        </defs>
        {diagram.kind === "layers" && <Lanes diagram={diagram} width={object.size.width} />}
        {sequence
          ? messageOrder(diagram.edges).map((edge, i) => {
              const a = rectOf(edge.sourceNodeId);
              const b = rectOf(edge.targetNodeId);
              if (!a || !b) return null;
              const quality = isReply(edge) ? "none" : edgeQuality(edge.semanticRelationId);
              const y = a.position.y + FIRST_MESSAGE + i * MESSAGE_STEP;
              const x1 = a.position.x + a.size.width / 2;
              const x2 = b.position.x + b.size.width / 2;
              const self = edge.sourceNodeId === edge.targetNodeId;
              return (
                <g key={edge.id} className={`diagram-edge diagram-message q-${quality}${isReply(edge) ? " is-reply" : ""}${highlightIds.has(edge.id) ? " is-highlighted" : ""}`} data-edge-id={edge.id}>
                  <title>{`${i + 1}. ${edge.label ?? "mensagem"}`}</title>
                  {self ? (
                    <path d={`M ${x1} ${y - 8} h 28 v 16 h -26`} fill="none" markerEnd={`url(#arrow-${diagram.id})`} />
                  ) : (
                    <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -2 : 2)} y2={y} markerEnd={`url(#arrow-${diagram.id})`} />
                  )}
                  <text x={self ? x1 + 34 : (x1 + x2) / 2} y={y - 6} textAnchor={self ? "start" : "middle"} className="diagram-edge-label">
                    {`${i + 1}. ${edge.label ?? ""}`}
                  </text>
                </g>
              );
            })
          : diagram.edges.map((edge) => {
              const a = rectOf(edge.sourceNodeId);
              const b = rectOf(edge.targetNodeId);
              if (!a || !b) return null;
              const [from, to] = connect(a, b);
              const quality = edgeQuality(edge.semanticRelationId);
              const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
              const tree = diagram.kind === "tree";
              return (
                <g key={edge.id} className={`diagram-edge q-${quality}${highlightIds.has(edge.id) ? " is-highlighted" : ""}`} data-edge-id={edge.id}>
                  <title>{`${edge.label ?? "relação"} · ${QUALITY_LABEL[quality]}`}</title>
                  {tree ? (
                    <path d={elbow(a, b)} fill="none" />
                  ) : (
                    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#arrow-${diagram.id})`} />
                  )}
                  {edge.label && (
                    <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="diagram-edge-label">
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}
        {diagram.nodes.map((node) => {
          const rect = rectOf(node.id);
          if (!rect) return null;
          const quality = nodeQuality(node.semanticEntityId);
          const pinned = diagram.layout.pinned?.includes(node.id);
          return (
            <g
              key={node.id}
              className={`diagram-node q-${quality}${highlightIds.has(node.id) ? " is-highlighted" : ""}`}
              data-node-id={node.id}
              transform={`translate(${rect.position.x}, ${rect.position.y})`}
              onPointerDown={fixed ? undefined : onNodePointerDown(node.id)}
            >
              <title>{`${node.label} · ${node.kind} · ${QUALITY_LABEL[quality]}${pinned ? " · fixado" : ""}`}</title>
              {sequence && <line className="diagram-lifeline" x1={rect.size.width / 2} y1={NODE_HEIGHT} x2={rect.size.width / 2} y2={rect.size.height} />}
              <rect width={rect.size.width} height={sequence ? NODE_HEIGHT : rect.size.height} rx={node.kind === "data_store" ? 18 : 8} />
              <text x={rect.size.width / 2} y={(sequence ? NODE_HEIGHT : rect.size.height) / 2 - 2} textAnchor="middle" className="diagram-node-label">
                {node.label}
              </text>
              <text x={rect.size.width / 2} y={(sequence ? NODE_HEIGHT : rect.size.height) / 2 + 14} textAnchor="middle" className="diagram-node-kind">
                {quality === "inferred" ? "inferido" : quality === "stale" ? "desatualizado" : quality === "broken" ? "vínculo quebrado" : node.kind}
              </text>
            </g>
          );
        })}
      </svg>
      {(hasInferred || diagram.caption) && (
        <footer className={`diagram-footer${diagram.caption ? " with-caption" : ""}`}>
          {hasInferred && (
            <div className="diagram-legend" aria-hidden>
              <span className="legend-solid" /> verificado <span className="legend-dashed" /> inferido
            </div>
          )}
          {diagram.caption && (
            <p className="diagram-caption" data-testid="diagram-caption" title={diagram.caption}>
              {diagram.caption}
            </p>
          )}
        </footer>
      )}
      {object.placedBy === "agent" && <span className="mod-origin">criado pelo agente</span>}
      <div className="mod-resize" onPointerDown={onResizePointerDown} aria-hidden />
    </section>
  );
}

/** As faixas de um diagrama de camadas, com o nome à esquerda, atrás dos nós. */
function Lanes({ diagram, width }: { diagram: DiagramModel; width: number }) {
  return (
    <g className="diagram-lanes">
      {layerOrder(diagram.nodes).map((layer) => {
        const tops = diagram.nodes.filter((n) => layerOf(n) === layer).flatMap((n) => diagram.layout.nodes[n.id]?.position.y ?? []);
        if (!tops.length) return null;
        const y = Math.min(...tops) - LANE_PAD;
        return (
          <g key={layer} className="diagram-lane" data-layer={layer}>
            <rect x={12} y={y} width={Math.max(0, width - 24)} height={NODE_HEIGHT + 2 * LANE_PAD} rx={10} />
            <text x={24} y={y + LANE_PAD + NODE_HEIGHT / 2 + 4} className="diagram-lane-label">
              {truncate(layer || "outros", Math.floor(LANE_GUTTER / 8))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Ligação de árvore: desce do pai, anda na horizontal e desce até o filho. */
function elbow(parent: Rect, child: Rect): string {
  const x1 = parent.position.x + parent.size.width / 2;
  const y1 = parent.position.y + parent.size.height;
  const x2 = child.position.x + child.size.width / 2;
  const y2 = child.position.y;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`;
}

/** Pontos nas bordas dos dois retângulos, na linha entre os centros. */
function connect(a: Rect, b: Rect): [Point, Point] {
  const ca = { x: a.position.x + a.size.width / 2, y: a.position.y + a.size.height / 2 };
  const cb = { x: b.position.x + b.size.width / 2, y: b.position.y + b.size.height / 2 };
  return [edgePoint(a, ca, cb), edgePoint(b, cb, ca)];
}

function edgePoint(rect: Rect, from: Point, toward: Point): Point {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const sx = dx === 0 ? Infinity : rect.size.width / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : rect.size.height / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: from.x + dx * s, y: from.y + dy * s };
}
