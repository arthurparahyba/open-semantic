// A forma dos diagramas de faixas e de sequência: o layout e a interface leem daqui (docs/funcionalidades/12-tipos-de-diagrama.md).
import type { DiagramEdge, DiagramNode } from "@open-semantic/protocol";

/** Altura das caixas dos nós. */
export const NODE_HEIGHT = 56;

/** Largura da coluna com o nome da camada, à esquerda das faixas. */
export const LANE_GUTTER = 150;
export const LANE_GAP = 20;
export const LANE_PAD = 12;

/** A camada de um nó (attributes.layer), ou "" quando não tem. */
export function layerOf(node: Pick<DiagramNode, "attributes">): string {
  const layer = node.attributes?.layer;
  return typeof layer === "string" ? layer : "";
}

/** As camadas na ordem em que aparecem (de cima para baixo). */
export function layerOrder(nodes: Pick<DiagramNode, "attributes">[]): string[] {
  return [...new Set(nodes.map(layerOf))];
}

/** Distância entre mensagens e onde começa a primeira, abaixo do topo da caixa do participante. */
export const MESSAGE_STEP = 44;
export const FIRST_MESSAGE = NODE_HEIGHT + 36;

/** A ordem das mensagens: attributes.order, e a posição na lista para desempatar. */
export function messageOrder<E extends Pick<DiagramEdge, "attributes">>(edges: E[]): E[] {
  const order = (e: E, i: number) => (typeof e.attributes?.order === "number" ? e.attributes.order : i);
  return edges.map((e, i) => [e, order(e, i), i] as const).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([e]) => e);
}

/** Mensagem de retorno (desenhada tracejada). */
export const isReply = (edge: Pick<DiagramEdge, "attributes">) => edge.attributes?.reply === true;

// Wireframe: a tela com seus elementos, uns dentro dos outros (attributes.parent).

/** Margem interna de um contêiner, altura do nome dele no topo e espaço entre elementos. */
export const WIRE_PAD = 10;
export const WIRE_TITLE = 20;
export const WIRE_GAP = 8;

/** O contêiner de um elemento (attributes.parent), ou undefined na raiz. */
export function parentOf(node: Pick<DiagramNode, "attributes">): string | undefined {
  const parent = node.attributes?.parent;
  return typeof parent === "string" ? parent : undefined;
}

/** Contêineres que põem os filhos lado a lado; os outros empilham de cima para baixo. */
const ROW_KINDS = new Set(["row", "header", "toolbar", "nav", "navbar", "tabs", "footer", "split"]);
export const isRow = (kind: string) => ROW_KINDS.has(kind);

/** Tamanho de um elemento sem filhos, pelo tipo: botão e campo são baixos; imagem, lista e tabela, altos. */
type LeafShape = { min: number; height: number; fixed?: number };
const LEAF: Record<string, LeafShape> = {};
const shape = (kinds: string[], s: LeafShape) => kinds.forEach((k) => (LEAF[k] = s));
shape(["button", "link", "tab"], { min: 72, height: 32 });
shape(["input", "search", "select", "checkbox"], { min: 180, height: 32 });
shape(["text", "label"], { min: 80, height: 24 });
shape(["title"], { min: 80, height: 30 });
shape(["image"], { min: 160, height: 100, fixed: 160 });
shape(["icon", "avatar"], { min: 36, height: 36, fixed: 36 });
shape(["list", "table", "grid", "chart", "canvas", "editor"], { min: 220, height: 120 });

export function wireLeafSize(kind: string, label: string): { width: number; height: number } {
  const s = LEAF[kind] ?? { min: 120, height: 48 };
  return { width: s.fixed ?? Math.max(s.min, Math.round(label.length * 7.5) + 32), height: s.height };
}
