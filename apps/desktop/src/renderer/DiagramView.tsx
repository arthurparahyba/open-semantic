import { useState } from "react";

import type { CanvasObject, DiagramModel, KnowledgeStatus, Point, Rect, WorkspaceSnapshot } from "@open-semantic/protocol";

import { BPMN_ROW, ER_ROW, ER_TITLE, bpmnCellTop, bpmnHasLanes, FIRST_MESSAGE, LANE_GUTTER, LANE_PAD, MESSAGE_STEP, NODE_HEIGHT, WIRE_TITLE, bpmnShape, columnsOf, isReply, layerOf, layerOrder, messageOrder } from "@open-semantic/workspace-store/diagramShapes";

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
  const wire = diagram.kind === "wireframe";
  const fixed = FIXED_KINDS.has(diagram.kind);
  const sequence = diagram.kind === "sequence";
  const hasInferred =
    diagram.nodes.some((n) => nodeQuality(n.semanticEntityId) === "inferred") ||
    diagram.edges.some((e) => edgeQuality(e.semanticRelationId) === "inferred");
  const marks = marksIn(diagram);

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
        {diagram.kind === "bpmn" && bpmnHasLanes(diagram.nodes) && <BpmnLanes diagram={diagram} width={object.size.width} />}
        {wire
          ? null
          : sequence
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
              // Ida e volta entre os mesmos dois nós: os rótulos ficavam um em cima do outro.
              const reverse = (e: typeof edge) => e.sourceNodeId > e.targetNodeId && diagram.edges.some((o) => o.sourceNodeId === e.targetNodeId && o.targetNodeId === e.sourceNodeId);
              const nthOut = (e: typeof edge) => diagram.edges.filter((o) => o.sourceNodeId === e.sourceNodeId).indexOf(e);
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
                  {diagram.kind === "bpmn" ? (
                    <path d={bpmnRoute(a, b, nthOut(edge)).d} fill="none" markerEnd={`url(#arrow-${diagram.id})`} />
                  ) : tree ? (
                    <path d={elbow(a, b)} fill="none" />
                  ) : (
                    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#arrow-${diagram.id})`} />
                  )}
                  {edge.label && (
                    <text x={diagram.kind === "bpmn" ? bpmnRoute(a, b, nthOut(edge)).label.x : mid.x} y={diagram.kind === "bpmn" ? bpmnRoute(a, b, nthOut(edge)).label.y : mid.y - 6 + (reverse(edge) ? 16 : 0)} textAnchor="middle" className="diagram-edge-label">
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
          if (wire) return <WireNode key={node.id} node={node} rect={rect} quality={quality} highlighted={highlightIds.has(node.id)} container={diagram.nodes.some((n) => n.attributes?.parent === node.id)} />;
          if (drawsShape(diagram.kind, node.kind)) {
            return <ShapedNode key={node.id} diagramKind={diagram.kind} node={node} rect={rect} quality={quality} highlighted={highlightIds.has(node.id)} onPointerDown={onNodePointerDown(node.id)} />;
          }
          return (
            <g
              key={node.id}
              className={`diagram-node q-${quality}${markClass(node)}${highlightIds.has(node.id) ? " is-highlighted" : ""}`}
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
      {(hasInferred || marks.length > 0 || diagram.caption) && (
        <footer className={`diagram-footer${diagram.caption ? " with-caption" : ""}`}>
          {hasInferred && (
            <div className="diagram-legend" aria-hidden>
              <span className="legend-solid" /> verificado <span className="legend-dashed" /> inferido
            </div>
          )}
          <MarkLegend marks={marks} />
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

/** Marcas da especificação (diferença em relação à base) e da implementação (status dos critérios), doc 16. */
const MARK_ORDER = ["novo", "muda", "remove", "pendente", "passou", "falhou"] as const;
const MARK_LABEL: Record<(typeof MARK_ORDER)[number], string> = { novo: "novo", muda: "muda", remove: "sai", pendente: "pendente", passou: "passou", falhou: "falhou" };
const markClass = (node: DiagramModel["nodes"][number]) => {
  const mark = node.attributes?.mark;
  return typeof mark === "string" && (MARK_ORDER as readonly string[]).includes(mark) ? ` m-${mark}` : "";
};

const marksIn = (diagram: DiagramModel) => MARK_ORDER.filter((m) => diagram.nodes.some((n) => n.attributes?.mark === m));

function MarkLegend({ marks }: { marks: readonly (typeof MARK_ORDER)[number][] }) {
  if (!marks.length) return null;
  return (
    <div className="diagram-legend diagram-marks" aria-hidden>
      {marks.map((m) => (
        <span key={m} className={`legend-mark m-${m}`}>
          {MARK_LABEL[m]}
        </span>
      ))}
    </div>
  );
}

/** Nós que não são caixas: tabelas do er, eventos e decisões do bpmn. */
const drawsShape = (diagramKind: DiagramModel["kind"], nodeKind: string) => diagramKind === "er" || (diagramKind === "bpmn" && bpmnShape(nodeKind) !== "task");

function ShapedNode({ diagramKind, node, rect, quality, highlighted, onPointerDown }: { diagramKind: DiagramModel["kind"]; node: DiagramModel["nodes"][number]; rect: Rect; quality: Quality; highlighted: boolean; onPointerDown: (event: React.PointerEvent) => void }) {
  return (
    <g className={`diagram-node q-${quality}${markClass(node)}${highlighted ? " is-highlighted" : ""}`} data-node-id={node.id} transform={`translate(${rect.position.x}, ${rect.position.y})`} onPointerDown={onPointerDown}>
      <title>{`${node.label} · ${node.kind} · ${QUALITY_LABEL[quality]}`}</title>
      {diagramKind === "er" ? <ErTable label={node.label} columns={columnsOf(node)} width={rect.size.width} height={rect.size.height} /> : <BpmnSymbol kind={node.kind} label={node.label} size={rect.size.width} />}
    </g>
  );
}

/** Evento do BPMN (círculo; o fim tem borda grossa) ou decisão (losango), com o rótulo embaixo. */
function BpmnSymbol({ kind, label, size }: { kind: string; label: string; size: number }) {
  const r = size / 2;
  const end = kind === "end" || kind === "fim";
  return (
    <>
      {bpmnShape(kind) === "event" ? (
        <circle cx={r} cy={r} r={r - 1} className={`bpmn-event${end ? " is-end" : ""}`} />
      ) : (
        <polygon points={`${r},1 ${size - 1},${r} ${r},${size - 1} 1,${r}`} className="bpmn-gateway" />
      )}
      <text x={r} y={size + 14} textAnchor="middle" className="diagram-edge-label">
        {label}
      </text>
    </>
  );
}

/** Tabela do diagrama er: nome no topo e uma coluna por linha (chaves em destaque). */
function ErTable({ label, columns, width, height }: { label: string; columns: string[]; width: number; height: number }) {
  return (
    <>
      <rect width={width} height={height} rx={6} />
      <line x1={0} y1={ER_TITLE} x2={width} y2={ER_TITLE} className="er-divider" />
      <text x={10} y={ER_TITLE - 10} className="diagram-node-label er-title">
        {label}
      </text>
      {columns.map((c, i) => (
        <text key={i} x={10} y={ER_TITLE + 15 + i * ER_ROW} className={`er-column${/\b(PK|FK)\b/.test(c) ? " is-key" : ""}`}>
          {c}
        </text>
      ))}
    </>
  );
}

/** Mensagem de erro da tela: vermelha sempre, mesmo marcada como novo (a marca fica só na borda). */
const ERROR_KINDS = new Set(["error", "erro", "alert", "alerta", "validation", "validacao"]);
const isErrorMessage = (node: DiagramModel["nodes"][number]) =>
  ERROR_KINDS.has(node.kind) || (["text", "label", "message", "hint"].includes(node.kind) && /\b(erro|inv[aá]lid|obrigat[oó]ri|deve ser|n[aã]o pode)/i.test(node.label));

/**
 * Um elemento da tela no wireframe: contêiner com o nome no topo, ou o elemento desenhado pelo tipo
 * (botão, campo, imagem, texto, lista). O tracejado do inferido vale aqui como nos outros tipos.
 */
function WireNode({ node, rect, quality, highlighted, container }: { node: DiagramModel["nodes"][number]; rect: Rect; quality: Quality; highlighted: boolean; container: boolean }) {
  const { width: w, height: h } = rect.size;
  const kind = node.kind;
  const max = Math.max(4, Math.floor((w - 16) / 7));
  const error = !container && isErrorMessage(node);
  return (
    <g className={`diagram-node wire-node wire-${container ? "box" : kind} q-${quality}${markClass(node)}${error ? " is-error" : ""}${highlighted ? " is-highlighted" : ""}`} data-node-id={node.id} data-wire-kind={kind} transform={`translate(${rect.position.x}, ${rect.position.y})`}>
      <title>{`${node.label} · ${kind} · ${QUALITY_LABEL[quality]}`}</title>
      <rect width={w} height={h} rx={kind === "button" ? 8 : container ? 6 : 4} />
      {container ? (
        <text x={10} y={WIRE_TITLE - 4} className="wire-title">
          {truncate(node.label, max)}
        </text>
      ) : (
        <WireContent kind={kind} label={node.label} width={w} height={h} max={max} />
      )}
    </g>
  );
}

const PICTURE = new Set(["image", "avatar", "icon"]);
const ROWS = new Set(["list", "table", "grid"]);
const CENTERED = new Set(["button", "tab"]);
const PLACEHOLDER = new Set(["input", "search", "select"]);

/** O miolo de um elemento da tela: imagem com X, lista com linhas, botão centrado, campo com o texto de exemplo. */
function WireContent({ kind, label, width: w, height: h, max }: { kind: string; label: string; width: number; height: number; max: number }) {
  if (PICTURE.has(kind)) {
    return (
      <>
        <line x1={0} y1={0} x2={w} y2={h} className="wire-cross" />
        <line x1={w} y1={0} x2={0} y2={h} className="wire-cross" />
        {kind === "image" && (
          <text x={w / 2} y={h - 8} textAnchor="middle" className="wire-label">
            {truncate(label, max)}
          </text>
        )}
      </>
    );
  }
  if (ROWS.has(kind)) {
    return (
      <>
        <text x={10} y={20} className="wire-label">
          {truncate(label, max)}
        </text>
        {[1, 2, 3].map((i) => (
          <line key={i} x1={10} x2={w - 10} y1={20 + i * 22} y2={20 + i * 22} className="wire-cross" />
        ))}
      </>
    );
  }
  const centered = CENTERED.has(kind);
  return (
    <text x={centered ? w / 2 : 10} y={h / 2 + 4} textAnchor={centered ? "middle" : "start"} className={`wire-label${PLACEHOLDER.has(kind) ? " is-placeholder" : ""}`}>
      {truncate(`${label}${kind === "select" ? " ▾" : ""}`, max)}
    </text>
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

/** Tipos com posição dada pela gramática (sem arraste de nós). */
const FIXED_KINDS = new Set<DiagramModel["kind"]>(["layers", "sequence", "bpmn", "wireframe"]);

/** Raias do BPMN: uma faixa por ator, da primeira à última célula dos seus elementos, com o nome à esquerda. */
function BpmnLanes({ diagram, width }: { diagram: DiagramModel; width: number }) {
  return (
    <g className="diagram-lanes">
      {layerOrder(diagram.nodes).map((lane) => {
        const rects = diagram.nodes.filter((n) => layerOf(n) === lane).flatMap((n) => diagram.layout.nodes[n.id] ?? []);
        if (!rects.length) return null;
        const top = Math.min(...rects.map(bpmnCellTop));
        const bottom = Math.max(...rects.map((r) => bpmnCellTop(r) + BPMN_ROW));
        return (
          <g key={lane} className="diagram-lane bpmn-lane" data-layer={lane}>
            <rect x={12} y={top} width={Math.max(0, width - 24)} height={bottom - top} rx={4} />
            <text x={24} y={(top + bottom) / 2 + 4} className="diagram-lane-label">
              {truncate(lane || "outros", Math.floor(LANE_GUTTER / 8))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Seta do BPMN em ângulos retos: para a frente, sai pela direita e entra pela esquerda; voltando no fluxo,
 * desce, passa por baixo das células e sobe até o elemento. O rótulo fica no primeiro trecho.
 */
/**
 * `nth`: a ordem desta seta entre as que saem do mesmo elemento. As saídas de uma decisão (sim/não) começavam no
 * mesmo ponto e os rótulos se fundiam: o rótulo vai para o trecho que chega no destino, e as voltas descem em
 * faixas diferentes.
 */
function bpmnRoute(a: Rect, b: Rect, nth = 0): { d: string; label: Point } {
  const ay = a.position.y + a.size.height / 2;
  const by = b.position.y + b.size.height / 2;
  const x1 = a.position.x + a.size.width;
  const x2 = b.position.x;
  if (x2 > x1) {
    const mx = Math.round((x1 + x2) / 2);
    const label = Math.abs(by - ay) > 4 ? { x: (mx + x2) / 2, y: by - 6 } : { x: (x1 + mx) / 2, y: ay - 6 };
    return { d: `M ${x1} ${ay} H ${mx} V ${by} H ${x2 - 2}`, label };
  }
  const acx = a.position.x + a.size.width / 2;
  const bcx = b.position.x + b.size.width / 2;
  const below = Math.max(bpmnCellTop(a), bpmnCellTop(b)) + BPMN_ROW - 6 - nth * 12;
  return {
    d: `M ${acx} ${a.position.y + a.size.height} V ${below} H ${bcx} V ${b.position.y + b.size.height + 2}`,
    label: { x: (acx + bcx) / 2 + nth * 24, y: below - 4 },
  };
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
