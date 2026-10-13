import elkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInstance, ELKConstructorArguments } from "elkjs/lib/elk-api.js";

import type { DiagramLayout, DiagramModel, Rect, Size } from "@open-semantic/protocol";

/** Altura do cabeçalho do diagrama no canvas; as posições dos nós ficam abaixo dele. */
export const DIAGRAM_HEADER = 36;
export const DIAGRAM_PADDING = 24;
const NODE_HEIGHT = 56;

export type LayoutAlgorithm = DiagramLayout["algorithm"];
export type LayoutDirection = NonNullable<DiagramLayout["direction"]>;

// O pacote é CommonJS com tipos ESM: o construtor pode vir direto ou em `.default`, conforme o carregador.
type ElkCtor = new (args?: ELKConstructorArguments) => ElkInstance;
const ELK = ((elkBundled as unknown as { default?: ElkCtor }).default ?? elkBundled) as unknown as ElkCtor;
const elk = new ELK();

const ELK_DIRECTION: Record<LayoutDirection, string> = { LR: "RIGHT", RL: "LEFT", TB: "DOWN", BT: "UP" };

/** Largura do nó a partir do rótulo, para que o texto caiba sem medir fontes no processo principal. */
export function nodeSize(label: string): Size {
  return { width: Math.min(280, Math.max(120, Math.round(label.length * 8.5 + 48))), height: NODE_HEIGHT };
}

/**
 * Calcula o layout. Nós fixados pelo usuário (`pinned`) mantêm a posição anterior; os demais são
 * posicionados pelo algoritmo. Mudar o layout nunca altera nós, arestas ou o Open Semantic (V0.1 §3.3).
 */
export async function computeLayout(
  model: Pick<DiagramModel, "nodes" | "edges" | "layout">,
  options: { algorithm: LayoutAlgorithm; direction?: LayoutDirection; respectPinned?: boolean },
): Promise<DiagramLayout> {
  const pinned = new Set(options.respectPinned === false ? [] : (model.layout.pinned ?? []));
  const previous = model.layout.nodes;
  const sizes = new Map(model.nodes.map((n) => [n.id, previous[n.id]?.size ?? nodeSize(n.label)]));
  const placed: Record<string, Rect> = {};

  if (options.algorithm === "manual") {
    // Mantém o que existe; nós novos vão para a próxima linha livre.
    let x = DIAGRAM_PADDING;
    const bottom = Math.max(DIAGRAM_HEADER + DIAGRAM_PADDING, ...Object.values(previous).filter((r) => r !== undefined).map((r) => r.position.y + r.size.height + 32));
    for (const node of model.nodes) {
      const old = previous[node.id];
      if (old) placed[node.id] = old;
      else {
        placed[node.id] = { position: { x, y: bottom }, size: sizes.get(node.id)! };
        x += sizes.get(node.id)!.width + 32;
      }
    }
  } else if (options.algorithm === "grid") {
    const columns = Math.max(1, Math.ceil(Math.sqrt(model.nodes.length)));
    const cellW = Math.max(...[...sizes.values()].map((s) => s.width), 120) + 48;
    model.nodes.forEach((node, i) => {
      placed[node.id] = {
        position: { x: DIAGRAM_PADDING + (i % columns) * cellW, y: DIAGRAM_HEADER + DIAGRAM_PADDING + Math.floor(i / columns) * (NODE_HEIGHT + 48) },
        size: sizes.get(node.id)!,
      };
    });
  } else {
    const graph = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": options.algorithm === "force" ? "force" : "layered",
        "elk.direction": ELK_DIRECTION[options.direction ?? "LR"],
        "elk.spacing.nodeNode": "48",
        "elk.layered.spacing.nodeNodeBetweenLayers": "112",
        "elk.edgeRouting": "ORTHOGONAL",
      },
      children: model.nodes.map((n) => ({ id: n.id, width: sizes.get(n.id)!.width, height: sizes.get(n.id)!.height })),
      edges: model.edges.map((e) => ({ id: e.id, sources: [e.sourceNodeId], targets: [e.targetNodeId] })),
    });
    for (const child of graph.children ?? []) {
      placed[child.id] = {
        position: { x: Math.round((child.x ?? 0) + DIAGRAM_PADDING), y: Math.round((child.y ?? 0) + DIAGRAM_HEADER + DIAGRAM_PADDING) },
        size: sizes.get(child.id)!,
      };
    }
  }

  for (const id of pinned) if (previous[id] && placed[id]) placed[id] = previous[id]!;
  const layout: DiagramLayout = { algorithm: options.algorithm, nodes: placed, pinned: [...pinned].filter((id) => placed[id]) };
  if (options.direction ?? model.layout.direction) layout.direction = options.direction ?? model.layout.direction!;
  return layout;
}

/** Linhas da legenda no rodapé do diagrama, no máximo 4 (o resto fica no texto completo, ao passar o mouse). */
export const CAPTION_LINE = 17;
export function captionLines(caption: string | undefined, width: number): number {
  if (!caption) return 0;
  const perLine = Math.max(20, Math.floor((width - 2 * 12) / 6.6));
  return Math.min(4, Math.ceil(caption.length / perLine));
}

/** Tamanho do objeto no canvas: os nós e, quando há, a legenda embaixo deles. */
export function diagramSize(layout: DiagramLayout, caption?: string): Size {
  const size = contentSize(layout);
  const lines = captionLines(caption, size.width);
  return lines ? { width: size.width, height: size.height + lines * CAPTION_LINE + 30 } : size;
}

/** Tamanho que o objeto do diagrama precisa no canvas para mostrar todos os nós. */
export function contentSize(layout: DiagramLayout): Size {
  const rects = Object.values(layout.nodes).filter((r) => r !== undefined);
  if (rects.length === 0) return { width: 320, height: DIAGRAM_HEADER + 160 };
  const maxX = Math.max(...rects.map((r) => r.position.x + r.size.width));
  const maxY = Math.max(...rects.map((r) => r.position.y + r.size.height));
  return { width: Math.max(320, maxX + DIAGRAM_PADDING), height: Math.max(DIAGRAM_HEADER + 120, maxY + DIAGRAM_PADDING) };
}
