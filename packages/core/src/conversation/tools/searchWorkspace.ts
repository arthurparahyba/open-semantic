import type { ConversationTool } from "./tool.js";

export const searchWorkspace: ConversationTool = {
  name: "search_workspace",
  description:
    "Searches the whole workspace (units, diagrams, nodes, edges, mods, regions) by words, in any language the user writes. Returns the best matches with ids and their context units. Use it when the <workspace> block does not show what the user mentions.",
  inputSchema: () => ({
    type: "object",
    properties: { query: { type: "string", description: "Words to look for, e.g. 'api de pagamentos antifraude'." } },
    required: ["query"],
    additionalProperties: false,
  }),
  run(input, ctx) {
    const query = String(input.query ?? "").trim();
    if (!query) throw new Error("Informe o que buscar.");
    ctx.note(`Buscou "${query.slice(0, 60)}" no workspace`);
    ctx.context.sync();
    return { query, results: ctx.context.engine.search(query, 15) };
  },
};
