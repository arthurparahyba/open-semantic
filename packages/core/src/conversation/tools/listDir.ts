import { agentRead, locate, resolvePath } from "./project.js";
import type { ConversationTool } from "./tool.js";

const MAX_DIR_ENTRIES = 300;

export const listDir: ConversationTool = {
  name: "list_dir",
  description:
    "Lists one directory of an open project (not recursive). Path is relative to the project root; empty string for the root. Returns entries with path, kind and artifactId (artifactIds are what mods and file writes reference).",
  inputSchema: () => ({
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the project root, e.g. 'src' or ''." },
      projectId: { type: "string", description: "Only needed when more than one project is open." },
    },
    required: ["path"],
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const where = locate(ctx.snapshot(), input);
    ctx.note(`Olhou a pasta ${where.path || "raiz do projeto"}`);
    const dir = await resolvePath(ctx, where);
    const result = await agentRead(ctx, "project.list_dir", { artifactId: dir });
    const entries = (result.output?.entries ?? []) as { artifactId: string; path: string; kind: string }[];
    return {
      path: where.path || ".",
      entries: entries.slice(0, MAX_DIR_ENTRIES).map((e) => ({ path: e.path, kind: e.kind, artifactId: e.artifactId })),
      ...(entries.length > MAX_DIR_ENTRIES ? { truncated: entries.length - MAX_DIR_ENTRIES } : {}),
    };
  },
};
