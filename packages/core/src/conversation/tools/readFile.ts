import { agentRead, locate, resolvePath } from "./project.js";
import type { ConversationTool, ToolContext } from "./tool.js";

const MAX_FILE_CHARS = 12_000;
/** Vários arquivos numa chamada: cada um é cortado mais cedo, para a resposta não estourar. */
const MAX_BATCH = 8;
const MAX_BATCH_FILE_CHARS = 6_000;

export const readFile: ConversationTool = {
  name: "read_file",
  description: `Reads text files of an open project. Pass paths (up to ${MAX_BATCH}) to read several files in one call: prefer that to one call per file, since each call counts against the request's limit. Long files are cut at ${MAX_FILE_CHARS} characters (${MAX_BATCH_FILE_CHARS} each when reading several). Returns artifactId and contentHash for each (pass contentHash as expectedContentHash when writing the file).`,
  inputSchema: () => ({
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project root." },
      paths: { type: "array", items: { type: "string" }, maxItems: MAX_BATCH, description: "Several file paths to read at once." },
      projectId: { type: "string" },
    },
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String).slice(0, MAX_BATCH) : [];
    if (!paths.length) {
      if (typeof input.path !== "string") throw new Error("Informe path ou paths.");
      return readOne(ctx, input, input.path, MAX_FILE_CHARS);
    }
    const files = [];
    for (const path of paths) files.push(await readOne(ctx, input, path, MAX_BATCH_FILE_CHARS).catch((err: unknown) => ({ path, error: err instanceof Error ? err.message : String(err) })));
    return { files };
  },
};

async function readOne(ctx: ToolContext, input: Record<string, unknown>, path: string, max: number) {
  const where = locate(ctx.snapshot(), { ...input, path });
  ctx.note(`Leu ${where.path}`);
  const file = await resolvePath(ctx, where);
  const result = await agentRead(ctx, "project.read_file", { artifactId: file });
  const content = String(result.output?.content ?? "");
  ctx.reads.set(where.path, content);
  const fingerprint = result.output?.fingerprint as { contentHash?: string } | undefined;
  const cut = content.length > max;
  return {
    path: where.path,
    artifactId: file,
    ...(fingerprint?.contentHash ? { contentHash: fingerprint.contentHash } : {}),
    content: cut ? content.slice(0, max) : content,
    ...(cut ? { truncatedAtChars: max, totalChars: content.length } : {}),
  };
}
