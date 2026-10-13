import { summarizeWorkspace } from "../workspaceSummary.js";
import type { ConversationTool } from "./tool.js";

export const getWorkspace: ConversationTool = {
  name: "get_workspace",
  description:
    "Returns a compact summary of the whole workspace: projects, canvas regions, mods, diagrams and semantic entities/relations with their knowledge status. The <workspace> block in the user message already has what matters for the request; call this only when you need everything, or the state after your own changes.",
  inputSchema: () => ({ type: "object", properties: {}, additionalProperties: false }),
  run(_input, ctx) {
    ctx.note("Consultou o workspace");
    return summarizeWorkspace(ctx.snapshot());
  },
};
