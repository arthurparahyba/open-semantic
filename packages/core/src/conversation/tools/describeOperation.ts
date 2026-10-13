import { inlineContractRefs } from "@open-semantic/protocol";

import type { ConversationTool } from "./tool.js";

export const describeOperation: ConversationTool = {
  name: "describe_operation",
  description: "Returns the exact JSON Schema of an operation's arguments. Use it before the first use of an operation whose arguments you are not sure about.",
  inputSchema: (operations) => ({
    type: "object",
    properties: { operation: { type: "string", enum: operations } },
    required: ["operation"],
    additionalProperties: false,
  }),
  run(input, { dispatcher }) {
    const operation = String(input.operation ?? "");
    if (!dispatcher.operations().includes(operation)) {
      throw new Error(`Operação desconhecida: ${operation}. Conhecidas: ${dispatcher.agentOperations().map((o) => o.operation).join(", ")}`);
    }
    const schema = dispatcher.argumentsSchema(operation);
    return { operation, arguments: schema ? inlineContractRefs(schema) : { type: "object" } };
  },
};
