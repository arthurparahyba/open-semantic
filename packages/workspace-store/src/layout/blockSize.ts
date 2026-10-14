// Tamanho de um bloco de explicação no canvas, estimado pelo texto (o canvas mostra o bloco nesse tamanho).
import type { Block, Size } from "@open-semantic/protocol";

export const BLOCK_WIDTH = { min: 320, default: 560, max: 960 } as const;
const PADDING = 16;
const CHAR = 7.4;
const LINE = 21;

/** A quebra por palavra desperdiça parte de cada linha; sem essa folga, listas e tabelas longas passavam da moldura. */
const WRAP = 1.15;

/** Linhas que um texto ocupa numa largura. */
const lines = (text: string | undefined, width: number) => (text ? Math.max(1, Math.ceil((text.length * CHAR * WRAP) / (width - 2 * PADDING))) : 0);

/** Altura do conteúdo, por tipo. */
function contentHeight(block: Pick<Block, "kind" | "title" | "text" | "items" | "columns" | "rows">, width: number): number {
  const titleLines = block.title ? Math.ceil((block.title.length * CHAR * 1.45) / (width - 2 * PADDING)) : 0;
  const title = titleLines * 30;
  const text = lines(block.text, width) * LINE;
  if (block.kind === "list") return title + text + (block.items ?? []).reduce((h, item) => h + lines(item, width - 24) * LINE + 4, 0);
  if (block.kind === "table") {
    const cols = Math.max(1, block.columns?.length ?? block.rows?.[0]?.length ?? 1);
    const rowHeight = (cells: string[]) => Math.max(1, ...cells.map((c) => lines(c, width / cols))) * LINE + 10;
    return title + text + rowHeight((block.columns ?? []) as string[]) + (block.rows ?? []).reduce((h: number, r) => h + rowHeight(r as string[]), 0);
  }
  return title + text;
}

/** Largura: a do objeto ao lado (para um título acompanhar o diagrama), dentro dos limites; altura pelo conteúdo. */
export function blockSize(block: Pick<Block, "kind" | "title" | "text" | "items" | "columns" | "rows">, besideWidth?: number): Size {
  const wanted = besideWidth ?? (block.kind === "table" ? 720 : BLOCK_WIDTH.default);
  const width = Math.round(Math.min(BLOCK_WIDTH.max, Math.max(BLOCK_WIDTH.min, wanted)));
  return { width, height: Math.round(contentHeight(block, width) + 2 * PADDING) };
}
