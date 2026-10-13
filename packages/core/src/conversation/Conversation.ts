// Conversa com um agente de IA dentro do app. O laço é nosso e não depende do provedor:
// o modelo só lê o workspace e pede mudanças em lotes, que passam pelo mesmo executor,
// pela mesma política de autorização e pelo mesmo cartão de confirmação do agente roteirizado.
import { randomUUID } from "node:crypto";

import { ProviderError, ZERO_USAGE, addUsage, promptTokens, type ChatMessage, type LlmProvider, type Usage } from "@open-semantic/llm";
import type { WorkspaceSnapshot } from "@open-semantic/protocol";

import { systemPrompt } from "../prompt.js";
import { ConversationBatches } from "./batches.js";
import { DEFAULT_LIMITS, TurnBudget, type TurnLimits } from "./budget.js";
import { Chat } from "./chat.js";
import { closeDangling, compactHistory } from "./history.js";
import { AgentTurn } from "./loop.js";
import { TOOLS, ToolRegistry, type ToolContext } from "./tools/index.js";
import { ConversationBusyError, type ConversationOptions, type ConversationView } from "./types.js";
import { Understanding } from "./understand.js";
import { ACCEPT_ALL_HINT, PLANNING_HINT, acceptsAll, asksForPlanning, planningLimits } from "./planning.js";
import { asksForExplanation, changedDiagrams, diagramRevisions, kindHint } from "./visualFirst.js";

/** Um pedido em andamento: o laço e as revisões dos diagramas de quando começou (para achar o que ele desenhou). */
interface Turn {
  agent: AgentTurn;
  diagramsBefore: Map<string, number>;
}

export class Conversation {
  private id: string;
  private history: ChatMessage[] = [];
  private usage: Usage = ZERO_USAGE;
  private costUsd = 0;
  private lastRequest: ConversationView["lastRequest"];
  private lastPromptTokens = 0;
  private abort: AbortController | undefined;
  private readonly chat: Chat;
  private readonly understanding: Understanding;
  private running: Promise<void> = Promise.resolve();
  private superseded = false;
  /** O último pedido que foi para o motor de contexto (para "todos" responder à pergunta rápida dele). */
  private asked: string | undefined;
  private readonly batches: ConversationBatches;
  private readonly limits: TurnLimits;
  private readonly newId: () => string;
  /** Prompt e ferramentas do modelo. Saem do catálogo de operações e não mudam com o app aberto (o cache do provedor vale). */
  private readonly system: string;
  private readonly tools: ToolRegistry;

  constructor(private readonly options: ConversationOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.newId = options.newId ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
    this.id = `conv_${this.newId()}`;
    this.chat = new Chat({ newId: this.newId, now: options.now ?? (() => new Date()), changed: () => this.emit() });
    this.understanding = new Understanding({ dispatcher: options.dispatcher, snapshot: options.snapshot, newId: this.newId, chat: this.chat });
    this.batches = new ConversationBatches(options.agent, this.chat, this.newId);
    const operations = options.dispatcher.agentOperations();
    this.system = systemPrompt(operations);
    this.tools = new ToolRegistry(TOOLS, operations.map((o) => o.operation));
  }

  view(): ConversationView {
    return {
      id: this.id,
      status: this.chat.status,
      entries: structuredClone(this.chat.entries),
      model: this.options.settings().model,
      usage: { ...this.usage },
      costUsd: this.costUsd,
      ...(this.lastRequest ? { lastRequest: structuredClone(this.lastRequest) } : {}),
    };
  }

  /** Começa uma conversa nova (o histórico antigo deixa de ser enviado, então o custo por pedido volta ao mínimo). */
  reset() {
    if (this.chat.status !== "idle") throw new ConversationBusyError("Espere o pedido atual terminar ou pare-o antes.");
    this.id = `conv_${this.newId()}`;
    this.history = [];
    this.chat.clear();
    this.usage = ZERO_USAGE;
    this.costUsd = 0;
    this.lastRequest = undefined;
    this.lastPromptTokens = 0;
    this.understanding.reset();
    this.emit();
  }

  /** Interrompe o pedido em andamento. Um lote esperando confirmação é recusado. */
  stop() {
    this.understanding.cancel();
    this.abort?.abort();
    this.batches.decline();
  }

  /** Resposta a uma opção do motor de contexto (pergunta rápida ou suposição). */
  choose(entryId: string, ref: string) {
    this.understanding.choose(entryId, ref);
  }

  /** Um pedido do usuário: roda o laço do agente até ele responder, travar num limite ou ser parado. */
  /** Aceita mensagem nova: conversa livre, ou só esperando uma pergunta rápida (que a mensagem descarta). */
  accepts(): boolean {
    return this.chat.status === "idle" || this.understanding.waiting;
  }

  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    let previous: string | undefined;
    if (this.chat.status !== "idle" && this.understanding.waiting) {
      previous = this.asked;
      // A pergunta rápida não trava nada: a mensagem nova descarta as opções e segue no lugar do pedido anterior.
      this.superseded = true;
      this.understanding.cancel();
      await this.running;
    }
    if (this.chat.status !== "idle") throw new ConversationBusyError("O agente ainda está trabalhando no pedido anterior.");
    this.chat.push({ kind: "user", text: message });
    const provider = this.options.provider();
    if (!provider) return this.chat.notice("Configure a chave da API do Claude para conversar com o agente.", "error");
    this.compactIfLong();
    const turn = this.startTurn(provider, message);
    let done!: () => void;
    this.running = new Promise((r) => (done = r));
    try {
      // Antes do modelo: do que a mensagem fala. O foco vai para lá, e só isso (com um mapa enxuto do resto)
      // vai junto do pedido, para o modelo não gastar uma chamada só para olhar nem ler o workspace inteiro.
      // "todos" respondendo à pergunta rápida: o pedido anterior continua, cobrindo todas as opções.
      const all = previous !== undefined && acceptsAll(message);
      const request = all ? previous! : message;
      const broad = all || asksForPlanning(request);
      this.asked = request;
      const workspace = await this.understanding.understand(request, { broad });
      if (!workspace) {
        if (!this.superseded) this.chat.notice("Pedido parado antes de ir para o modelo.", "info");
        return;
      }
      const hints = [
        all ? `${ACCEPT_ALL_HINT} Pedido anterior: "${previous}"` : undefined,
        asksForPlanning(request) ? PLANNING_HINT : asksForExplanation(request) ? kindHint(request) : undefined,
      ].filter(Boolean);
      this.history.push({ role: "user", text: `<workspace>\n${workspace}\n</workspace>\n\n${message}${hints.map((h) => `\n\n${h}`).join("")}` });
      await turn.agent.run();
    } catch (err) {
      this.fail(err);
    } finally {
      this.superseded = false;
      this.finish(turn);
      done();
    }
  }

  /** Quando a última chamada passou do limite de tokens, os pedidos anteriores são resumidos antes do próximo. */
  private compactIfLong() {
    if (this.lastPromptTokens <= this.limits.compactAboveTokens) return;
    const before = this.lastPromptTokens;
    this.history = compactHistory(this.history, this.tools.batchTools);
    this.lastPromptTokens = 0;
    this.chat.notice(
      `A conversa passou de ${Math.round(before / 1000)} mil tokens por chamada; resumi os pedidos anteriores (o que foi pedido, respondido e feito) para continuar barata.`,
      "info",
    );
  }

  private startTurn(provider: LlmProvider, message: string): Turn {
    const settings = this.options.settings();
    const model = provider.models.find((m) => m.id === settings.model) ?? provider.models.find((m) => m.id === provider.defaultModel)!;
    const abort = new AbortController();
    this.abort = abort;
    // Pedido amplo é um laço maior: plano, camada e um diagrama por seção.
    const limits = asksForPlanning(message) ? planningLimits(this.limits) : this.limits;
    const budget = new TurnBudget(limits, settings.maxCostPerRequestUsd);
    const agent = new AgentTurn({
      provider,
      model,
      system: this.system,
      tools: this.tools,
      toolContext: this.toolContext(budget),
      history: this.history,
      budget,
      maxOutputTokens: this.limits.maxOutputTokens,
      signal: abort.signal,
      explanation: asksForExplanation(message),
      chat: this.chat,
      onUsage: (usage, cost) => {
        this.lastPromptTokens = promptTokens(usage);
        this.usage = addUsage(this.usage, usage);
        this.costUsd += cost;
        this.lastRequest = budget.spend();
      },
    });
    // Visual first: o texto do modelo só aparece no fim, como legenda do que foi desenhado.
    const diagramsBefore = diagramRevisions(this.options.snapshot());
    this.lastRequest = budget.spend();
    this.chat.setStatus("thinking");
    return { agent, diagramsBefore };
  }

  private toolContext(budget: TurnBudget): ToolContext {
    return {
      dispatcher: this.options.dispatcher,
      snapshot: () => this.options.snapshot(),
      context: this.understanding.context,
      newId: this.newId,
      note: (text) => void this.chat.push({ kind: "tool", text }),
      runBatch: (input) => this.batches.run(input, budget),
    };
  }

  private fail(err: unknown) {
    closeDangling(this.history);
    if (err instanceof ProviderError && err.kind === "aborted") this.chat.notice("Pedido interrompido.", "info");
    else this.chat.notice(err instanceof Error ? err.message : String(err), "error");
  }

  /** Fim do pedido: a resposta entra no chat (o texto do modelo, ou a legenda do que ele desenhou) e a conversa fica livre. */
  private finish({ agent, diagramsBefore }: Turn) {
    this.abort = undefined;
    this.batches.settle();
    const snapshot = this.options.snapshot();
    this.answer(agent.answer, changedDiagrams(diagramsBefore, snapshot), snapshot);
    this.chat.setStatus("idle");
  }

  private answer(text: string, diagramIds: string[], snapshot: WorkspaceSnapshot) {
    if (!text && !diagramIds.length) return;
    const caption = diagramIds.map((id) => snapshot.diagrams.find((d) => d.id === id)?.caption).find(Boolean);
    this.chat.answer(text || caption || "", diagramIds);
  }

  private emit() {
    this.options.onChange?.(this.view());
  }
}
