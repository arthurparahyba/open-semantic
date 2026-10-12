// Provedor roteirizado: devolve respostas prontas, lidas de um arquivo JSON a cada chamada.
// Serve aos testes de ponta a ponta (sem rede e sem custo); não é oferecido ao usuário.
import { readFile } from "node:fs/promises";

import { ANTHROPIC_MODELS } from "./anthropic.js";
import type { Completion, CompletionRequest, LlmProvider } from "./types.js";

export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly label = "Roteirizado (testes)";
  readonly models = ANTHROPIC_MODELS;
  readonly defaultModel = "claude-haiku-5-5";
  private calls = 0;

  /** `file`: JSON com uma lista de respostas parciais, consumidas em ordem. */
  constructor(private readonly file: string) {}

  async complete(request: CompletionRequest): Promise<Completion> {
    if (request.signal?.aborted) throw new Error("Pedido interrompido.");
    const steps = JSON.parse(await readFile(this.file, "utf8")) as Partial<Completion>[];
    const step = steps[this.calls++];
    if (!step) return { text: "(fim do roteiro)", toolCalls: [], stop: "end", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const toolCalls = step.toolCalls ?? [];
    return {
      text: step.text ?? "",
      toolCalls,
      stop: step.stop ?? (toolCalls.length ? "tool_use" : "end"),
      usage: step.usage ?? { inputTokens: 3_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
