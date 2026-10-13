import type { ConversationTool } from "./tool.js";

export const runBatch: ConversationTool = {
  name: "run_batch",
  description:
    "Executes a batch of workspace operations in dependency order. This is the ONLY way to change anything (files, canvas, diagrams, semantic layer, camera). All steps are validated first; if any step needs the user's confirmation, the call waits until the user approves or declines on a card in the app. Returns the real status of every step: report to the user only what succeeded.",
  runsBatch: true,
  inputSchema: (operations) => ({
    type: "object",
    properties: {
      intent: { type: "string", description: "Short description of the batch in the user's language, shown on the card." },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$", description: "Step id, unique in the batch." },
            operation: { type: "string", enum: operations },
            arguments: {
              type: "object",
              description: 'Operation arguments. A value can be {"$bind": {"step": "<earlier step id>", "pointer": "/output/..."}} to use an earlier step\'s output; that step must be in dependsOn (directly or transitively).',
            },
            dependsOn: { type: "array", items: { type: "string" } },
          },
          required: ["id", "operation", "arguments"],
          additionalProperties: false,
        },
      },
      stopOnFailure: { type: "boolean", description: "true: cancel the remaining steps when one fails. Default false: only steps that depend on the failed one are skipped." },
    },
    required: ["intent", "steps"],
    additionalProperties: false,
  }),
  run: (input, ctx) => ctx.runBatch(input),
};
