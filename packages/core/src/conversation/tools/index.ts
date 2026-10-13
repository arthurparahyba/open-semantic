// O registro das ferramentas do modelo. A ordem da lista é a ordem em que vão ao provedor (faz parte do prompt em cache).
import type { ToolCall, ToolResult, ToolSpec } from "@open-semantic/llm";

import { describeOperation } from "./describeOperation.js";
import { getWorkspace } from "./getWorkspace.js";
import { listDir } from "./listDir.js";
import { readFile } from "./readFile.js";
import { runBatch } from "./runBatch.js";
import { searchWorkspace } from "./searchWorkspace.js";
import { showDiagram } from "./showDiagram/tool.js";
import type { ConversationTool, ToolContext } from "./tool.js";

export type { ConversationTool, ToolContext } from "./tool.js";

/** A resposta visual e as leituras primeiro; por último as que dependem do catálogo de operações. */
export const TOOLS: ConversationTool[] = [showDiagram, getWorkspace, searchWorkspace, listDir, readFile, describeOperation, runBatch];

export class ToolRegistry {
  /** As ferramentas como vão ao modelo. */
  readonly specs: ToolSpec[];
  /** As que rodam lotes: a compactação do histórico guarda o resultado delas. */
  readonly batchTools: ReadonlySet<string>;
  private readonly byName: Map<string, ConversationTool>;

  /** `operations`: as que o catálogo abre ao agente (o enum de describe_operation e run_batch). */
  constructor(tools: ConversationTool[], operations: string[]) {
    this.specs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema(operations) }));
    this.batchTools = new Set(tools.filter((t) => t.runsBatch).map((t) => t.name));
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  /** Executa uma chamada do modelo. Um erro, ou uma ferramenta que não existe, volta ao modelo como resultado de erro. */
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.byName.get(call.name);
    if (!tool) return { callId: call.id, content: `Ferramenta desconhecida: ${call.name}`, isError: true };
    try {
      return { callId: call.id, content: JSON.stringify(await tool.run(call.input, ctx)) };
    } catch (err) {
      return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}
