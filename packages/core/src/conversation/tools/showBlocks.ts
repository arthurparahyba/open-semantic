// show_blocks: títulos, textos, listas e tabelas soltos no canvas (docs/funcionalidades/13-layout-semantico.md).
// O texto de um diagrama vai no próprio show_diagram (heading, intro, notes); aqui ficam os blocos que não são de um diagrama só.
import { slug } from "../text.js";
import type { ConversationTool } from "./tool.js";

interface BlockCall {
  kind: string;
  title?: string;
  text?: string;
  annotates?: string;
  side?: "above" | "below";
  continues?: string;
  details?: string;
  [key: string]: unknown;
}

export const showBlocks: ConversationTool = {
  name: "show_blocks",
  description:
    "Puts explanation blocks on the canvas that are not a single diagram's text: a section heading that opens a new part of the explanation, a paragraph, a list (ordered for steps) or a table (e.g. a comparison). Say how each block relates to what is on the canvas: annotates (stuck to it, above or below), continues (below it, next step) or details (to its right). Blocks in one call are placed in order; a block may refer to an earlier one of the same call by its blockId. The app places them and frames them for the user. For a diagram's own heading, intro and notes, use show_diagram instead.",
  runsBatch: true,
  inputSchema: () => ({
    type: "object",
    required: ["blocks"],
    properties: {
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            blockId: { type: "string", description: "blk_ plus a readable name. Optional; the app makes one from the title." },
            kind: { enum: ["heading", "text", "list", "table"] },
            title: { type: "string", maxLength: 200, description: "Heading text (heading) or a small title for the block." },
            text: { type: "string", maxLength: 2000, description: "Paragraph (text) or the description under a heading." },
            items: { type: "array", maxItems: 30, items: { type: "string", maxLength: 400 } },
            ordered: { type: "boolean" },
            columns: { type: "array", maxItems: 8, items: { type: "string", maxLength: 100 } },
            rows: { type: "array", maxItems: 30, items: { type: "array", maxItems: 8, items: { type: "string", maxLength: 300 } } },
            annotates: { type: "string", description: "dgm_ or blk_ this block is stuck to." },
            side: { enum: ["above", "below"], description: "With annotates. Default: above." },
            continues: { type: "string", description: "dgm_ or blk_ this block follows; it goes below." },
            details: { type: "string", description: "dgm_ or blk_ this block expands; it goes to the right." },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const calls = (input.blocks ?? []) as BlockCall[];
    const blocks = calls.map((b) => toBlock(b, ctx.newId()));
    const ids = blocks.map((b) => b.blockId);
    return ctx.runBatch({
      intent: `Escrever ${blocks.length === 1 ? "um bloco" : `${blocks.length} blocos`} de explicação`,
      steps: [
        { id: "blocks", operation: "block.create", arguments: { blocks } },
        { id: "show", operation: "navigation.frame", arguments: { targets: { visualIds: ids }, intent: "focus", highlight: true, reason: "Blocos de explicação" }, dependsOn: ["blocks"] },
      ],
    });
  },
};

function toBlock({ blockId, annotates, side, continues, details, ...content }: BlockCall, unique: string): Record<string, unknown> & { blockId: string } {
  const id = typeof blockId === "string" && /^blk_[A-Za-z0-9_-]{3,64}$/.test(blockId) ? blockId : `blk_${slug(content.title ?? content.text ?? content.kind, 30) || "bloco"}_${unique.replace(/[^A-Za-z0-9]/g, "").slice(-6)}`;
  const arrangement = arrangementOf({ annotates, side, continues, details });
  return { blockId: id, ...content, ...(arrangement ? { arrangement } : {}) };
}

function arrangementOf({ annotates, side, continues, details }: Pick<BlockCall, "annotates" | "side" | "continues" | "details">): Record<string, unknown> | undefined {
  if (annotates) return { relation: "annotates", targetId: annotates, ...(side ? { side } : {}) };
  if (continues) return { relation: "continues", targetId: continues };
  if (details) return { relation: "details", targetId: details };
  return undefined;
}
