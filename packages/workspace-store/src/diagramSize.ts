import type { DiagramLayout, Size } from "@open-semantic/protocol";

/** Altura do cabeçalho do diagrama no canvas; as posições dos nós ficam abaixo dele. */
export const DIAGRAM_HEADER = 36;
export const DIAGRAM_PADDING = 24;

/** Linhas da legenda no rodapé do diagrama, no máximo 4 (o resto fica no texto completo, ao passar o mouse). */
export const CAPTION_LINE = 17;
export function captionLines(caption: string | undefined, width: number): number {
  if (!caption) return 0;
  const perLine = Math.max(20, Math.floor((width - 2 * 12) / 6.6));
  return Math.min(4, Math.ceil(caption.length / perLine));
}

/**
 * Tamanho do objeto no canvas: os nós e, quando há, a legenda embaixo deles.
 * Vale para o diagrama criado agora e para o lido de `.open-semantic/`.
 */
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
