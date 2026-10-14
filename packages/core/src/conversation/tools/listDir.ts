import { agentRead, locate, resolvePath } from "./project.js";
import type { ConversationTool } from "./tool.js";

const MAX_DIR_ENTRIES = 300;
const MAX_DEPTH = 4;
/** Pastas que só têm dependências ou saída de build: não ajudam a entender o projeto. */
const SKIP = new Set([".git", "node_modules", "target", "build", "dist", "out", ".gradle", ".idea", ".mvn", ".vscode", "coverage", "__pycache__"]);

type Entry = { artifactId: string; path: string; kind: string };

export const listDir: ConversationTool = {
  name: "list_dir",
  description:
    "Lists a directory of an open project. Path is relative to the project root; empty string for the root. With depth > 1 it also lists the subdirectories (up to 4 levels, skipping .git, node_modules and build output), so one call shows the whole layout of a small project: prefer that to one call per folder. Returns entries with path, kind and artifactId (artifactIds are what mods and file writes reference).",
  inputSchema: () => ({
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the project root, e.g. 'src' or ''." },
      depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH, description: "Levels to list. Default 1." },
      projectId: { type: "string", description: "Only needed when more than one project is open." },
    },
    required: ["path"],
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const where = locate(ctx.snapshot(), input);
    ctx.note(`Olhou a pasta ${where.path || "raiz do projeto"}`);
    const depth = Math.min(MAX_DEPTH, Math.max(1, Number(input.depth ?? 1) || 1));
    const entries: Entry[] = [];
    let truncated = 0;
    const walk = async (artifactId: string, level: number) => {
      const result = await agentRead(ctx, "project.list_dir", { artifactId });
      for (const e of (result.output?.entries ?? []) as Entry[]) {
        if (entries.length >= MAX_DIR_ENTRIES) {
          truncated++;
          continue;
        }
        entries.push(e);
        const name = e.path.split("/").pop() ?? "";
        if (e.kind === "directory" && level < depth && !SKIP.has(name)) await walk(e.artifactId, level + 1);
      }
    };
    await walk(await resolvePath(ctx, where), 1);
    return {
      path: where.path || ".",
      entries: entries.map((e) => ({ path: e.path, kind: e.kind, artifactId: e.artifactId })),
      ...(truncated ? { truncated } : {}),
    };
  },
};
