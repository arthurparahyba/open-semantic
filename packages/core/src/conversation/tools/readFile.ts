import { agentRead, locate, resolvePath } from "./project.js";
import type { ConversationTool } from "./tool.js";

const MAX_FILE_CHARS = 12_000;

export const readFile: ConversationTool = {
  name: "read_file",
  description: `Reads a text file of an open project. Long files are cut at ${MAX_FILE_CHARS} characters. Returns artifactId and contentHash (pass contentHash as expectedContentHash when writing the file).`,
  inputSchema: () => ({
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project root." },
      projectId: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const where = locate(ctx.snapshot(), input);
    ctx.note(`Leu ${where.path}`);
    const file = await resolvePath(ctx, where);
    const result = await agentRead(ctx, "project.read_file", { artifactId: file });
    const content = String(result.output?.content ?? "");
    const fingerprint = result.output?.fingerprint as { contentHash?: string } | undefined;
    const cut = content.length > MAX_FILE_CHARS;
    return {
      path: where.path,
      artifactId: file,
      ...(fingerprint?.contentHash ? { contentHash: fingerprint.contentHash } : {}),
      content: cut ? content.slice(0, MAX_FILE_CHARS) : content,
      ...(cut ? { truncatedAtChars: MAX_FILE_CHARS, totalChars: content.length } : {}),
    };
  },
};
