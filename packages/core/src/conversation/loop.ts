// O laço de um pedido: chama o modelo, trata a parada e roda as ferramentas pedidas, até a resposta, um limite ou o Parar.
import { costOf, type ChatMessage, type Completion, type LlmProvider, type ModelInfo, type ToolCall, type ToolResult, type Usage } from "@open-semantic/llm";

import type { TurnBudget } from "./budget.js";
import type { Chat } from "./chat.js";
import { closePendingCalls } from "./history.js";
import type { ToolContext, ToolRegistry } from "./tools/index.js";
import { VISUAL_NUDGE } from "./visualFirst.js";

export interface TurnOptions {
  provider: LlmProvider;
  model: ModelInfo;
  system: string;
  tools: ToolRegistry;
  toolContext: ToolContext;
  /** O histórico da conversa; o pedido escreve nele. */
  history: ChatMessage[];
  budget: TurnBudget;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** O pedido é de entendimento de estrutura ou fluxo: a resposta é um diagrama (visual first). */
  explanation: boolean;
  chat: Chat;
  /** Cada chamada ao modelo, para os totais da conversa. */
  onUsage(usage: Usage, costUsd: number): void;
}

export class AgentTurn {
  /** O texto final do modelo: a resposta de uma pergunta pontual, ou a legenda do que foi desenhado. */
  answer = "";
  private nudged = false;

  constructor(private readonly o: TurnOptions) {}

  async run(): Promise<void> {
    while (await this.step());
  }

  /** Uma volta do laço. Devolve se o pedido continua. */
  private async step(): Promise<boolean> {
    const stop = this.o.budget.stopReason();
    if (stop) {
      this.o.chat.notice(stop, "limit");
      return false;
    }
    const completion = await this.complete();
    if (this.stopsAt(completion)) return false;
    if (!completion.toolCalls.length) return this.nudge();
    return this.runTools(completion.toolCalls);
  }

  private async complete(): Promise<Completion> {
    const { provider, model, history, budget } = this.o;
    const completion = await provider.complete({
      model: model.id,
      system: this.o.system,
      messages: history,
      tools: this.o.tools.specs,
      maxOutputTokens: this.o.maxOutputTokens,
      signal: this.o.signal,
    });
    const cost = costOf(completion.usage, model.pricing);
    budget.record(completion.usage, cost);
    this.o.onUsage(completion.usage, cost);
    history.push({ role: "assistant", text: completion.text, toolCalls: completion.toolCalls, raw: completion.raw, provider: provider.id });
    // Texto que acompanha chamadas de ferramenta ("vou olhar o repositório") não vira resposta.
    if (completion.text && (!completion.toolCalls.length || completion.stop === "refusal")) this.answer = completion.text;
    return completion;
  }

  /** Recusa, ou resposta cortada no meio de uma chamada de ferramenta: nada daquela resposta é executado. */
  private stopsAt(completion: Completion): boolean {
    if (completion.stop === "refusal") {
      closePendingCalls(this.o.history, completion.toolCalls, "O modelo recusou o pedido; nada foi executado.");
      this.o.chat.notice("O modelo recusou este pedido. Nada foi executado.", "error");
      return true;
    }
    if (completion.stop === "max_tokens" && completion.toolCalls.length) {
      // A entrada da ferramenta pode ter sido cortada no meio: não executa.
      closePendingCalls(this.o.history, completion.toolCalls, "Resposta cortada pelo limite de tamanho; a ferramenta não foi executada.");
      this.o.chat.notice("A resposta do modelo passou do tamanho máximo e foi cortada. Nada daquela resposta foi executado.", "limit");
      return true;
    }
    return false;
  }

  /**
   * Resposta só com texto. Uma vez por pedido, a explicação de estrutura ou fluxo respondida assim (sem nenhum lote)
   * volta ao modelo para ser desenhada; quem já mexeu no canvas (abriu um arquivo, apagou algo) não é cobrado.
   */
  private nudge(): boolean {
    if (!this.o.explanation || this.o.budget.ranBatch || this.nudged || this.o.signal.aborted) return false;
    this.nudged = true;
    this.o.history.push({ role: "user", text: VISUAL_NUDGE });
    return true;
  }

  private async runTools(calls: ToolCall[]): Promise<boolean> {
    const { chat, signal } = this.o;
    chat.setStatus("working");
    const results: ToolResult[] = [];
    for (const call of calls) {
      if (signal.aborted) results.push({ callId: call.id, content: "Interrompido pelo usuário; não executado.", isError: true });
      else results.push(await this.o.tools.run(call, this.o.toolContext));
    }
    this.o.history.push({ role: "tool", results });
    if (signal.aborted) {
      chat.notice("Pedido interrompido.", "info");
      return false;
    }
    chat.setStatus("thinking");
    return true;
  }
}
