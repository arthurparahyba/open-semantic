import type { DiagramLayout, Size } from "@open-semantic/protocol";

/** Altura do cabeçalho do diagrama no canvas; as posições dos nós ficam abaixo dele. */
export const DIAGRAM_HEADER = 36;
export const DIAGRAM_PADDING = 24;

/**
 * Tamanho que o objeto do diagrama precisa no canvas para mostrar todos os nós.
 * Vale para o diagrama criado agora e para o lido de `.open-semantic/`.
 */
export function contentSize(layout: DiagramLayout): Size {
  const rects = Object.values(layout.nodes).filter((r) => r !== undefined);
  if (rects.length === 0) return { width: 320, height: DIAGRAM_HEADER + 160 };
  const maxX = Math.max(...rects.map((r) => r.position.x + r.size.width));
  const maxY = Math.max(...rects.map((r) => r.position.y + r.size.height));
  return { width: Math.max(320, maxX + DIAGRAM_PADDING), height: Math.max(DIAGRAM_HEADER + 120, maxY + DIAGRAM_PADDING) };
}
