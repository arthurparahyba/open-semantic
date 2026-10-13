import elkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInstance, ELKConstructorArguments } from "elkjs/lib/elk-api.js";

import type { DiagramLayout, DiagramModel, Rect, Size } from "@open-semantic/protocol";
import { DIAGRAM_HEADER, DIAGRAM_PADDING } from "@open-semantic/workspace-store";
import {
  FIRST_MESSAGE,
  LANE_GAP,
  LANE_GUTTER,
  LANE_PAD,
  MESSAGE_STEP,
  NODE_HEIGHT,
  WIRE_GAP,
  WIRE_PAD,
  WIRE_TITLE,
  isRow,
  layerOf,
  layerOrder,
  parentOf,
  wireLeafSize,
} from "@open-semantic/workspace-store/diagramShapes";

export { CAPTION_LINE, DIAGRAM_HEADER, DIAGRAM_PADDING, captionLines, contentSize, diagramSize } from "@open-semantic/workspace-store";

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
  // Faixas, sequência e árvore têm forma fixa: a posição sai da gramática, não do arraste.
  const structured = STRUCTURED.has(options.algorithm);
  const pinned = new Set(options.respectPinned === false || structured ? [] : (model.layout.pinned ?? []));
  const previous = model.layout.nodes;
  const sizes = new Map(model.nodes.map((n) => [n.id, (!structured && previous[n.id]?.size) || nodeSize(n.label)]));
  const own = FIXED_LAYOUTS[options.algorithm];
  const placed = own ? own(model, sizes) : await elkLayout(model, sizes, options.algorithm, options.direction);

  for (const id of pinned) if (previous[id] && placed[id]) placed[id] = previous[id]!;
  const layout: DiagramLayout = { algorithm: options.algorithm, nodes: placed, pinned: [...pinned].filter((id) => placed[id]) };
  if (options.direction ?? model.layout.direction) layout.direction = options.direction ?? model.layout.direction!;
  return layout;
}

type Model = Pick<DiagramModel, "nodes" | "edges" | "layout">;
/** Layouts calculados aqui; os demais vão para o ELK. */
const FIXED_LAYOUTS: Partial<Record<LayoutAlgorithm, (model: Model, sizes: Map<string, Size>) => Record<string, Rect>>> = {
  lanes,
  sequence,
  wireframe: (model) => wireframe(model),
  manual,
  grid,
};

const STRUCTURED = new Set<LayoutAlgorithm>(["lanes", "sequence", "tree", "wireframe"]);

/** Camadas empilhadas de cima para baixo; os nós de cada camada lado a lado, dentro da faixa. */
function lanes(model: Pick<DiagramModel, "nodes">, sizes: Map<string, Size>): Record<string, Rect> {
  const placed: Record<string, Rect> = {};
  let y = DIAGRAM_HEADER + DIAGRAM_PADDING;
  for (const layer of layerOrder(model.nodes)) {
    let x = DIAGRAM_PADDING + LANE_GUTTER;
    for (const node of model.nodes.filter((n) => layerOf(n) === layer)) {
      const size = sizes.get(node.id)!;
      placed[node.id] = { position: { x, y: y + LANE_PAD }, size };
      x += size.width + 32;
    }
    y += NODE_HEIGHT + 2 * LANE_PAD + LANE_GAP;
  }
  return placed;
}

/**
 * Participantes lado a lado; o retângulo de cada um desce pela linha de vida até a última mensagem,
 * para que o tamanho do diagrama saia dos nós como nos outros tipos.
 */
function sequence(model: Pick<DiagramModel, "nodes" | "edges">, sizes: Map<string, Size>): Record<string, Rect> {
  const placed: Record<string, Rect> = {};
  const height = FIRST_MESSAGE + Math.max(1, model.edges.length) * MESSAGE_STEP;
  // Colunas largas o bastante para o rótulo da mensagem mais longa.
  const longest = Math.max(0, ...model.edges.map((e) => (e.label ?? "").length));
  const gap = Math.max(48, Math.round(longest * 7) - 100);
  let x = DIAGRAM_PADDING;
  for (const node of model.nodes) {
    const size = sizes.get(node.id)!;
    placed[node.id] = { position: { x, y: DIAGRAM_HEADER + DIAGRAM_PADDING }, size: { width: size.width, height } };
    x += size.width + gap;
  }
  return placed;
}

const WIDE = new Set(["list", "table", "grid", "chart", "canvas", "editor"]);

/**
 * A tela: cada contêiner envolve os filhos, empilhados ou lado a lado (isRow). Contêineres filhos esticam
 * até a largura (ou a altura, numa linha) do pai, como numa tela de verdade; botões e campos mantêm o tamanho.
 */
function wireframe(model: Pick<DiagramModel, "nodes">): Record<string, Rect> {
  const ids = new Set(model.nodes.map((n) => n.id));
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const children = new Map<string | undefined, string[]>();
  for (const n of model.nodes) {
    const parent = parentOf(n);
    const key = parent && ids.has(parent) && parent !== n.id ? parent : undefined;
    children.set(key, [...(children.get(key) ?? []), n.id]);
  }
  const measured = new Map<string, Size>();
  const measure = (id: string, seen: Set<string>): Size => {
    const node = byId.get(id)!;
    const kids = seen.has(id) ? [] : (children.get(id) ?? []);
    let size: Size;
    if (!kids.length) size = wireLeafSize(node.kind, node.label);
    else {
      const inner = kids.map((k) => measure(k, new Set([...seen, id])));
      const titleWidth = Math.round(node.label.length * 7.5) + 2 * WIRE_PAD;
      size = isRow(node.kind)
        ? {
            width: Math.max(titleWidth, 2 * WIRE_PAD + inner.reduce((a, s) => a + s.width, 0) + WIRE_GAP * (kids.length - 1)),
            height: WIRE_TITLE + 2 * WIRE_PAD + Math.max(...inner.map((s) => s.height)),
          }
        : {
            width: Math.max(titleWidth, 2 * WIRE_PAD + Math.max(...inner.map((s) => s.width))),
            height: WIRE_TITLE + 2 * WIRE_PAD + inner.reduce((a, s) => a + s.height, 0) + WIRE_GAP * (kids.length - 1),
          };
    }
    measured.set(id, size);
    return size;
  };
  const placed: Record<string, Rect> = {};
  const stretches = (id: string) => (children.get(id) ?? []).length > 0;
  // Tabelas, listas e editores ocupam a largura toda da coluna, como numa tela de verdade.
  const wide = (id: string) => stretches(id) || WIDE.has(byId.get(id)!.kind);
  const place = (id: string, x: number, y: number, size: Size) => {
    placed[id] = { position: { x, y }, size };
    const node = byId.get(id)!;
    const kids = children.get(id) ?? [];
    let cx = x + WIRE_PAD;
    let cy = y + WIRE_TITLE + WIRE_PAD;
    const innerW = size.width - 2 * WIRE_PAD;
    const innerH = size.height - WIRE_TITLE - 2 * WIRE_PAD;
    // A sobra vai para o último contêiner: a altura numa coluna (o conteúdo abaixo do topo), a largura numa linha
    // (o conteúdo ao lado do menu).
    const row = isRow(node.kind);
    const lastBox = [...kids].reverse().find(stretches);
    const used = kids.reduce((a, k) => a + (row ? measured.get(k)!.width : measured.get(k)!.height), 0) + WIRE_GAP * Math.max(0, kids.length - 1);
    for (const k of kids) {
      const m = measured.get(k)!;
      if (row) {
        const extra = k === lastBox ? Math.max(0, innerW - used) : 0;
        place(k, cx, cy, { width: m.width + extra, height: stretches(k) ? innerH : m.height });
        cx += m.width + extra + WIRE_GAP;
      } else {
        const extra = k === lastBox ? Math.max(0, innerH - used) : 0;
        place(k, cx, cy, { width: wide(k) ? innerW : m.width, height: m.height + extra });
        cy += m.height + extra + WIRE_GAP;
      }
    }
  };
  let y = DIAGRAM_HEADER + DIAGRAM_PADDING;
  for (const root of children.get(undefined) ?? []) {
    const size = measure(root, new Set());
    place(root, DIAGRAM_PADDING, y, size);
    y += size.height + 24;
  }
  return placed;
}

/** Mantém o que existe; nós novos vão para a próxima linha livre. */
function manual(model: Pick<DiagramModel, "nodes" | "layout">, sizes: Map<string, Size>): Record<string, Rect> {
  const placed: Record<string, Rect> = {};
  const previous = model.layout.nodes;
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
  return placed;
}

function grid(model: Pick<DiagramModel, "nodes">, sizes: Map<string, Size>): Record<string, Rect> {
  const placed: Record<string, Rect> = {};
  const columns = Math.max(1, Math.ceil(Math.sqrt(model.nodes.length)));
  const cellW = Math.max(...[...sizes.values()].map((s) => s.width), 120) + 48;
  model.nodes.forEach((node, i) => {
    placed[node.id] = {
      position: { x: DIAGRAM_PADDING + (i % columns) * cellW, y: DIAGRAM_HEADER + DIAGRAM_PADDING + Math.floor(i / columns) * (NODE_HEIGHT + 48) },
      size: sizes.get(node.id)!,
    };
  });
  return placed;
}

/** Camadas do ELK (layered), força ou árvore (mrtree, sempre de cima para baixo). */
async function elkLayout(
  model: Pick<DiagramModel, "nodes" | "edges">,
  sizes: Map<string, Size>,
  algorithm: LayoutAlgorithm,
  direction: LayoutDirection | undefined,
): Promise<Record<string, Rect>> {
  const placed: Record<string, Rect> = {};
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm === "force" ? "force" : algorithm === "tree" ? "mrtree" : "layered",
      "elk.direction": ELK_DIRECTION[algorithm === "tree" ? "TB" : (direction ?? "LR")],
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
  return placed;
}
