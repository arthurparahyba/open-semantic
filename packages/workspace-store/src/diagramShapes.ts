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
