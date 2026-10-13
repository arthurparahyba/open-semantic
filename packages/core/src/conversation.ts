// Conversa com um agente de IA dentro do app. O laço é nosso e não depende do provedor:
// o modelo só lê o workspace e pede mudanças em lotes, que passam pelo mesmo executor,
// pela mesma política de autorização e pelo mesmo cartão de confirmação do agente roteirizado.
import { randomUUID } from "node:crypto";

import {
  ProviderError,
  ZERO_USAGE,
  addUsage,
  costOf,
  promptTokens,
  type ChatMessage,
  type LlmProvider,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
  type Usage,
} from "@open-semantic/llm";
import type { AttentionPort, Clarification, TargetRef } from "@open-semantic/semantic-context";
import {
  OperationError,
  inlineContractRefs,
  type BatchPlan,
  type BatchResult,
  type Dispatcher,
  type OperationResult,
  type WorkspaceSnapshot,
} from "@open-semantic/protocol";

import type { AgentRunner } from "./agent.js";
import { WorkspaceContext, canvasAttention, topicReason } from "./context.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export const CLAUDE_AGENT = { kind: "agent" as const, id: "claude" };

/** Tetos de cada pedido do usuário. Protegem a conta de laços longos ou caros. */
export interface TurnLimits {
  /** Chamadas ao modelo por pedido. */
  maxModelCalls: number;
  /** Lotes de mudanças por pedido. */
  maxBatches: number;
  /** Passos somados de todos os lotes do pedido. */
  maxSteps: number;
  /** Tokens somados (prompt + resposta) de todas as chamadas do pedido. */
  maxTokens: number;
  /** Tamanho máximo de cada resposta do modelo. */
  maxOutputTokens: number;
  /**
   * Quando o prompt de uma chamada passa disto, os pedidos anteriores são compactados antes do próximo.
   * A meta é 40 mil por chamada (spec 08); o Haiku cobra mais acima de 100 mil.
   */
  compactAboveTokens: number;
}

export const DEFAULT_LIMITS: TurnLimits = {
  maxModelCalls: 12,
  maxBatches: 6,
  maxSteps: 60,
  maxTokens: 600_000,
  maxOutputTokens: 8_000,
  compactAboveTokens: 40_000,
};

export interface ConversationSettings {
  model: string;
  /** Teto de custo por pedido, em dólares. A conversa para antes da chamada que passaria dele. */
  maxCostPerRequestUsd: number;
}

export type ChatEntry =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "assistant"; text: string; at: string }
  /** Um lote de mudanças; a interface mostra o cartão do lote (passos, confirmação, resultado). */
  | { id: string; kind: "batch"; batchId: string; at: string }
  /** Leitura feita pelo agente (pasta, arquivo, workspace), para o usuário ver o que ele consultou. */
  | { id: string; kind: "tool"; text: string; at: string }
  | { id: string; kind: "notice"; text: string; tone: "info" | "limit" | "error"; at: string }
  /**
   * Do motor de contexto: a pergunta rápida quando a dúvida muda o foco (o pedido espera a resposta),
   * ou a suposição feita, que a pessoa pode trocar. A interface mostra as opções como botões.
   */
  | {
      id: string;
      kind: "choice";
      mode: "question" | "assumption";
      /** Termo normalizado da mensagem; a escolha vale para ele nos próximos pedidos. */
      term: string;
      text: string;
      options: { ref: string; label: string }[];
      chosen?: string;
      at: string;
    };

export interface ConversationView {
  id: string;
  status: "idle" | "thinking" | "working" | "waiting_user";
  entries: ChatEntry[];
  model: string;
  /** Soma da conversa inteira. */
  usage: Usage;
  costUsd: number;
  /** Só do último pedido. */
  lastRequest?: { usage: Usage; costUsd: number; modelCalls: number };
}

export interface ConversationOptions {
  /** Provedor configurado agora (undefined quando falta a chave). */
  provider(): LlmProvider | undefined;
  settings(): ConversationSettings;
  dispatcher: Dispatcher;
  agent: AgentRunner;
  snapshot(): WorkspaceSnapshot;
  onChange?: (view: ConversationView) => void;
  limits?: Partial<TurnLimits>;
  now?: () => Date;
  newId?: () => string;
}

export class ConversationBusyError extends Error {}

const MAX_FILE_CHARS = 12_000;
const MAX_DIR_ENTRIES = 300;

export class Conversation {
  private id: string;
  private history: ChatMessage[] = [];
  private entries: ChatEntry[] = [];
  private status: ConversationView["status"] = "idle";
  private usage: Usage = ZERO_USAGE;
  private costUsd = 0;
  private lastRequest: ConversationView["lastRequest"];
  private abort: AbortController | undefined;
  private waitingBatch: string | undefined;
  private lastPromptTokens = 0;
  /** Unidades dos últimos assuntos, da mais recente para a mais antiga. */
  private recent: string[] = [];
  private asking: { entryId: string; resolve: (ref: TargetRef | undefined) => void } | undefined;
  private readonly context: WorkspaceContext;
  private readonly attention: AttentionPort;
  private readonly limits: TurnLimits;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: ConversationOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
    this.id = `conv_${this.newId()}`;
    this.context = new WorkspaceContext(options.snapshot);
    this.attention = canvasAttention({
      dispatcher: options.dispatcher,
      snapshot: options.snapshot,
      actor: CLAUDE_AGENT,
      newId: this.newId,
      ask: (question) => this.ask(question),
    });
  }

  view(): ConversationView {
    return {
      id: this.id,
      status: this.status,
      entries: structuredClone(this.entries),
      model: this.options.settings().model,
      usage: { ...this.usage },
      costUsd: this.costUsd,
      ...(this.lastRequest ? { lastRequest: structuredClone(this.lastRequest) } : {}),
    };
  }

  /** Começa uma conversa nova (o histórico antigo deixa de ser enviado, então o custo por pedido volta ao mínimo). */
  reset() {
    if (this.status !== "idle") throw new ConversationBusyError("Espere o pedido atual terminar ou pare-o antes.");
    this.id = `conv_${this.newId()}`;
    this.history = [];
    this.entries = [];
    this.usage = ZERO_USAGE;
    this.costUsd = 0;
    this.lastRequest = undefined;
    this.lastPromptTokens = 0;
    this.recent = [];
    this.emit();
  }

  /** Interrompe o pedido em andamento. Um lote esperando confirmação é recusado. */
  stop() {
    this.asking?.resolve(undefined);
    this.abort?.abort();
    if (this.waitingBatch) void this.options.agent.respond(this.waitingBatch, false);
  }

  /**
   * Resposta a uma opção do motor de contexto. Na pergunta rápida, o pedido que esperava continua.
   * Numa suposição, a escolha passa a ser o assunto mais recente (os próximos pedidos partem dela)
   * e o foco vai para ela. Nenhuma das duas vira regra fixa: "o back-end" do portal não é o do app mobile.
   */
  choose(entryId: string, ref: string) {
    const entry = this.entries.find((e): e is Extract<ChatEntry, { kind: "choice" }> => e.id === entryId && e.kind === "choice");
    if (!entry || !entry.options.some((o) => o.ref === ref)) throw new Error("Opção desconhecida.");
    if (entry.mode === "question" && this.asking?.entryId !== entryId) throw new Error("Essa pergunta já foi respondida.");
    entry.chosen = ref;
    if (entry.mode === "question") {
      this.asking!.resolve(ref);
      return;
    }
    const label = entry.options.find((o) => o.ref === ref)!.label;
    entry.text = entry.text.replace(/ é .*\.$/, ` é ${label}.`);
    this.recent = [ref, ...this.recent.filter((u) => u !== ref)];
    this.emit();
    void Promise.resolve(this.attention.focus(ref, [{ ref, level: "primary" }], `Assunto: ${label}`)).catch(() => {});
  }

  /** Um pedido do usuário: roda o laço do agente até ele responder, travar num limite ou ser parado. */
  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    if (this.status !== "idle") throw new ConversationBusyError("O agente ainda está trabalhando no pedido anterior.");
    this.push({ kind: "user", text: message });

    const provider = this.options.provider();
    if (!provider) {
      this.notice("Configure a chave da API do Claude para conversar com o agente.", "error");
      return;
    }
    const settings = this.options.settings();
    const model = provider.models.find((m) => m.id === settings.model) ?? provider.models.find((m) => m.id === provider.defaultModel)!;

    if (this.lastPromptTokens > this.limits.compactAboveTokens) {
      const before = this.lastPromptTokens;
      this.history = compactHistory(this.history);
      this.lastPromptTokens = 0;
      this.notice(
        `A conversa passou de ${Math.round(before / 1000)} mil tokens por chamada; resumi os pedidos anteriores (o que foi pedido, respondido e feito) para continuar barata.`,
        "info",
      );
    }

    const abort = new AbortController();
    this.abort = abort;
    const turn = { usage: ZERO_USAGE, costUsd: 0, modelCalls: 0, batches: 0, steps: 0 };
    this.lastRequest = { usage: turn.usage, costUsd: 0, modelCalls: 0 };
    this.setStatus("thinking");

    try {
      // Antes do modelo: do que a mensagem fala. O foco vai para lá, e só isso (com um mapa enxuto do resto)
      // vai junto do pedido, para o modelo não gastar uma chamada só para olhar nem ler o workspace inteiro.
      const workspace = await this.understand(message);
      if (!workspace) {
        this.notice("Pedido parado antes de ir para o modelo.", "info");
        return;
      }
      this.history.push({ role: "user", text: `<workspace>\n${workspace}\n</workspace>\n\n${message}` });

      for (;;) {
        const stop = this.limitReached(turn, settings);
        if (stop) {
          this.notice(stop, "limit");
          break;
        }
        const completion = await provider.complete({
          model: model.id,
          system: SYSTEM_PROMPT,
          messages: this.history,
          tools: TOOLS,
          maxOutputTokens: this.limits.maxOutputTokens,
          signal: abort.signal,
        });
        const cost = costOf(completion.usage, model.pricing);
        this.lastPromptTokens = promptTokens(completion.usage);
        turn.usage = addUsage(turn.usage, completion.usage);
        turn.costUsd += cost;
        turn.modelCalls += 1;
        this.usage = addUsage(this.usage, completion.usage);
        this.costUsd += cost;
        this.lastRequest = { usage: turn.usage, costUsd: turn.costUsd, modelCalls: turn.modelCalls };

        this.history.push({ role: "assistant", text: completion.text, toolCalls: completion.toolCalls, raw: completion.raw, provider: provider.id });
        if (completion.text) this.push({ kind: "assistant", text: completion.text });

        if (completion.stop === "refusal") {
          this.closePendingCalls(completion.toolCalls, "O modelo recusou o pedido; nada foi executado.");
          this.notice("O modelo recusou este pedido. Nada foi executado.", "error");
          break;
        }
        if (completion.stop === "max_tokens" && completion.toolCalls.length) {
          // A entrada da ferramenta pode ter sido cortada no meio: não executa.
          this.closePendingCalls(completion.toolCalls, "Resposta cortada pelo limite de tamanho; a ferramenta não foi executada.");
          this.notice("A resposta do modelo passou do tamanho máximo e foi cortada. Nada daquela resposta foi executado.", "limit");
          break;
        }
        if (!completion.toolCalls.length) break;

        this.setStatus("working");
        const results: ToolResult[] = [];
        for (const call of completion.toolCalls) {
          if (abort.signal.aborted) {
            results.push({ callId: call.id, content: "Interrompido pelo usuário; não executado.", isError: true });
            continue;
          }
          results.push(await this.runTool(call, turn));
        }
        this.history.push({ role: "tool", results });
        if (abort.signal.aborted) {
          this.notice("Pedido interrompido.", "info");
          break;
        }
        this.setStatus("thinking");
      }
    } catch (err) {
      this.closeDangling();
      if (err instanceof ProviderError && err.kind === "aborted") this.notice("Pedido interrompido.", "info");
      else this.notice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.abort = undefined;
      this.waitingBatch = undefined;
      this.setStatus("idle");
    }
  }

  /** Analisa a mensagem, pergunta se precisar, leva o foco ao assunto e monta o bloco <workspace>. */
  private async understand(message: string): Promise<string | undefined> {
    const snapshot = this.context.sync();
    const engine = this.context.engine;
    const choices: Record<string, string> = {};
    const input = () => ({ text: message, focus: { visibleIds: snapshot.navigation.focus.targetIds ?? [] }, recent: this.recent, choices });
    let relevance = engine.analyze(input());
    if (relevance.question) {
      const answer = await this.attention.ask(relevance.question);
      if (!answer) return undefined;
      choices[relevance.question.term] = answer;
      this.setStatus("thinking");
      relevance = engine.analyze(input());
    }
    for (const a of relevance.assumptions.slice(0, 2)) {
      this.push({
        kind: "choice",
        mode: "assumption",
        term: a.term,
        text: `Supus que ${a.said} é ${engine.describe(a.chosen)}.`,
        options: [a.chosen, ...a.alternatives].slice(0, 6).map((ref) => ({ ref, label: engine.describe(ref) })),
        chosen: a.chosen,
      });
    }
    if (relevance.primaryTarget) {
      try {
        await this.attention.focus(relevance.primaryTarget, relevance.emphasis, topicReason(relevance, engine));
      } catch {
        // O foco ajuda, mas não pode derrubar o pedido.
      }
    }
    const main = relevance.topics[0];
    if (main) this.recent = [...main.unitIds, ...this.recent.filter((u) => !main.unitIds.includes(u))].slice(0, 8);
    const pack = await engine.buildContext({ relevance, content: this.context.content(snapshot) });
    return `${JSON.stringify(workspaceHeader(snapshot))}\n\n${pack.text}`;
  }

  /** Pergunta rápida no chat: o pedido espera a escolha (ou o Parar). */
  private ask(question: Clarification): Promise<TargetRef | undefined> {
    this.push({ kind: "choice", mode: "question", term: question.term, text: question.text, options: question.options });
    const entryId = this.entries[this.entries.length - 1]!.id;
    this.setStatus("waiting_user");
    return new Promise((resolve) => {
      this.asking = {
        entryId,
        resolve: (ref) => {
          this.asking = undefined;
          resolve(ref);
        },
      };
    });
  }

  private limitReached(turn: { usage: Usage; costUsd: number; modelCalls: number }, settings: ConversationSettings): string | undefined {
    const tokens = promptTokens(turn.usage) + turn.usage.outputTokens;
    if (turn.modelCalls >= this.limits.maxModelCalls)
      return `Parei: este pedido chegou ao limite de ${this.limits.maxModelCalls} chamadas ao modelo. Peça para continuar se quiser.`;
    if (tokens >= this.limits.maxTokens)
      return `Parei: este pedido chegou ao limite de ${this.limits.maxTokens.toLocaleString("pt-BR")} tokens. Peça para continuar se quiser.`;
    if (turn.costUsd >= settings.maxCostPerRequestUsd)
      return `Parei: este pedido chegou ao teto de custo de US$ ${settings.maxCostPerRequestUsd.toFixed(2)}. Peça para continuar se quiser.`;
    return undefined;
  }

  // ----- ferramentas -----

  private async runTool(call: ToolCall, turn: { batches: number; steps: number }): Promise<ToolResult> {
    const ok = (value: unknown): ToolResult => ({ callId: call.id, content: JSON.stringify(value) });
    const fail = (message: string): ToolResult => ({ callId: call.id, content: message, isError: true });
    try {
      switch (call.name) {
        case "get_workspace":
          this.push({ kind: "tool", text: "Consultou o workspace" });
          return ok(summarizeWorkspace(this.options.snapshot()));
        case "search_workspace": {
          const query = String(call.input.query ?? "").trim();
          if (!query) return fail("Informe o que buscar.");
          this.push({ kind: "tool", text: `Buscou "${query.slice(0, 60)}" no workspace` });
          this.context.sync();
          return ok({ query, results: this.context.engine.search(query, 15) });
        }
        case "describe_operation": {
          const operation = String(call.input.operation ?? "");
          const schema = this.options.dispatcher.argumentsSchema(operation);
          if (!this.options.dispatcher.operations().includes(operation)) return fail(`Operação desconhecida: ${operation}. Conhecidas: ${AGENT_OPERATIONS.join(", ")}`);
          return ok({ operation, arguments: schema ? inlineContractRefs(schema) : { type: "object" } });
        }
        case "list_dir": {
          const { projectId, rootId, path } = this.locate(call.input);
          this.push({ kind: "tool", text: `Olhou a pasta ${path || "raiz do projeto"}` });
          const dir = await this.resolve(projectId, rootId, path);
          const result = await this.read("project.list_dir", { artifactId: dir });
          const entries = (result.output?.entries ?? []) as { artifactId: string; path: string; kind: string }[];
          return ok({
            path: path || ".",
            entries: entries.slice(0, MAX_DIR_ENTRIES).map((e) => ({ path: e.path, kind: e.kind, artifactId: e.artifactId })),
            ...(entries.length > MAX_DIR_ENTRIES ? { truncated: entries.length - MAX_DIR_ENTRIES } : {}),
          });
        }
        case "read_file": {
          const { projectId, rootId, path } = this.locate(call.input);
          this.push({ kind: "tool", text: `Leu ${path}` });
          const file = await this.resolve(projectId, rootId, path);
          const result = await this.read("project.read_file", { artifactId: file });
          const content = String(result.output?.content ?? "");
          const fingerprint = result.output?.fingerprint as { contentHash?: string } | undefined;
          return ok({
            path,
            artifactId: file,
            ...(fingerprint?.contentHash ? { contentHash: fingerprint.contentHash } : {}),
            content: content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content,
            ...(content.length > MAX_FILE_CHARS ? { truncatedAtChars: MAX_FILE_CHARS, totalChars: content.length } : {}),
          });
        }
        case "run_batch":
          return ok(await this.runBatch(call.input, turn));
        default:
          return fail(`Ferramenta desconhecida: ${call.name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private locate(input: Record<string, unknown>) {
    const snapshot = this.options.snapshot();
    const project = input.projectId ? snapshot.projects.find((p) => p.id === input.projectId) : activeProject(snapshot);
    if (!project) throw new Error(input.projectId ? `Projeto ${String(input.projectId)} não existe.` : "Nenhuma pasta de projeto aberta.");
    // Tira só "./" e "." sozinho: ".github" e ".env" são nomes, não "pasta atual".
    const path = String(input.path ?? "")
      .trim()
      .replace(/^(?:\.(?:\/|$))+/, "")
      .replace(/\/+$/, "");
    return { projectId: project.id, rootId: project.roots[0].id, path, rootRef: project.rootRef };
  }

  private async resolve(projectId: string, rootId: string, path: string): Promise<string> {
    if (!path) {
      const project = this.options.snapshot().projects.find((p) => p.id === projectId)!;
      return project.rootRef;
    }
    const result = await this.read("project.resolve", { projectId, rootId, path });
    return (result.output?.artifact as { id: string }).id;
  }

  /** Leitura pelo protocolo, assinada pelo agente: fica no histórico de ações como qualquer outra operação. */
  private async read(operation: string, args: Record<string, unknown>): Promise<OperationResult> {
    const result = await this.options.dispatcher.dispatch({
      operationId: `act_${this.newId()}`,
      operation,
      arguments: args,
      authorization: { actor: CLAUDE_AGENT },
    });
    if (result.status !== "succeeded") throw new Error(result.error?.message ?? `${operation} falhou`);
    return result;
  }

  private async runBatch(input: Record<string, unknown>, turn: { batches: number; steps: number }) {
    const steps = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : [];
    if (!steps.length) throw new Error("O lote precisa de pelo menos um passo.");
    if (turn.batches >= this.limits.maxBatches)
      throw new Error(`Limite de ${this.limits.maxBatches} lotes por pedido atingido. Responda ao usuário com o que já foi feito.`);
    if (turn.steps + steps.length > this.limits.maxSteps)
      throw new Error(`Limite de ${this.limits.maxSteps} passos por pedido: restam ${this.limits.maxSteps - turn.steps}. Divida ou reduza o lote.`);
    turn.batches += 1;
    turn.steps += steps.length;

    const run = this.newId();
    const plan: BatchPlan = {
      batchId: `bat_${run}`,
      intent: String(input.intent ?? "Mudanças pedidas na conversa").slice(0, 200),
      policy: {
        onStepFailure: input.stopOnFailure === true ? "abort_batch" : "skip_dependents",
        validateFirst: true,
        confirmation: "upfront",
      },
      steps: steps.map((step, i) => ({
        stepId: String(step.id ?? `s${i + 1}`),
        ...(Array.isArray(step.dependsOn) && step.dependsOn.length ? { dependsOn: step.dependsOn.map(String) } : {}),
        request: {
          operationId: `act_${run}_${String(i + 1).padStart(3, "0")}`,
          operation: String(step.operation ?? ""),
          arguments: (step.arguments ?? {}) as Record<string, unknown>,
          authorization: { actor: CLAUDE_AGENT },
        },
      })) as BatchPlan["steps"],
    };

    this.push({ kind: "batch", batchId: plan.batchId });
    let result: BatchResult;
    try {
      result = await this.options.agent.run(plan);
    } catch (err) {
      const message = err instanceof OperationError ? err.message : err instanceof Error ? err.message : String(err);
      return { batchId: plan.batchId, status: "rejected", error: message, note: "Nenhum passo foi executado." };
    }
    if (result.status === "awaiting_confirmation") {
      this.waitingBatch = plan.batchId;
      this.setStatus("waiting_user");
      result = await this.options.agent.settled(plan.batchId, result);
      this.waitingBatch = undefined;
      this.setStatus("working");
    }
    return describeResult(plan, result, this.options.agent.list().find((a) => a.batchId === plan.batchId)?.summary);
  }

  /** Toda chamada de ferramenta precisa de resposta antes da próxima mensagem, ou a API recusa o histórico. */
  private closePendingCalls(calls: ToolCall[], reason: string) {
    if (calls.length) this.history.push({ role: "tool", results: calls.map((c) => ({ callId: c.id, content: reason, isError: true })) });
  }

  private closeDangling() {
    const last = this.history[this.history.length - 1];
    if (last?.role === "assistant" && last.toolCalls.length) this.closePendingCalls(last.toolCalls, "Interrompido; não executado.");
  }

  // ----- estado para a interface -----

  private push(entry: DistributiveOmit<ChatEntry, "id" | "at">) {
    this.entries.push({ ...entry, id: `ent_${this.newId()}`, at: this.now().toISOString() } as ChatEntry);
    this.emit();
  }

  private notice(text: string, tone: "info" | "limit" | "error") {
    this.push({ kind: "notice", text, tone });
  }

  private setStatus(status: ConversationView["status"]) {
    this.status = status;
    this.emit();
  }

  private emit() {
    this.options.onChange?.(this.view());
  }
}

/**
 * Compacta os pedidos anteriores sem chamar o modelo: fica o que o usuário pediu, o que o agente respondeu
 * e o resultado real de cada lote. Saem o resumo do workspace daquela hora, as leituras de arquivo e pasta
 * e os detalhes das chamadas de ferramenta (o agente consulta de novo se precisar).
 */
export function compactHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let user: string | undefined;
  let replies: string[] = [];
  let facts: string[] = [];
  const toolNames = new Map<string, string>();
  const flush = () => {
    if (user === undefined) return;
    out.push({ role: "user", text: user });
    const parts = [...replies];
    if (facts.length) parts.push(`[Resultado dos lotes]\n${facts.join("\n")}`);
    out.push({ role: "assistant", text: parts.join("\n\n") || "(sem resposta)", toolCalls: [] });
  };
  for (const m of history) {
    if (m.role === "user") {
      flush();
      user = m.text.replace(/^<workspace>[\s\S]*?<\/workspace>\s*/, "");
      replies = [];
      facts = [];
    } else if (m.role === "assistant") {
      if (m.text) replies.push(m.text);
      for (const c of m.toolCalls) toolNames.set(c.id, c.name);
    } else {
      for (const r of m.results) {
        if (toolNames.get(r.callId) !== "run_batch") continue;
        try {
          const parsed = JSON.parse(r.content) as { status?: string; summaryShownToUser?: string; error?: string; intent?: string };
          facts.push(parsed.summaryShownToUser ?? `Lote ${parsed.status ?? "?"}${parsed.error ? `: ${parsed.error}` : ""}`);
        } catch {
          facts.push(`Lote não executado: ${r.content.slice(0, 200)}`);
        }
      }
    }
  }
  flush();
  return out;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** O que volta para o modelo depois de um lote: o status real de cada passo. Nunca afirma o que não aconteceu. */
function describeResult(plan: BatchPlan, result: BatchResult, summary: string | undefined) {
  return {
    batchId: plan.batchId,
    status: result.status,
    steps: plan.steps.map((s) => {
      const r = result.steps[s.stepId];
      return {
        id: s.stepId,
        operation: s.request.operation,
        status: r?.status ?? "not_run",
        ...(r?.error ? { error: { code: r.error.code, message: r.error.message, ...(r.error.argumentPath ? { argumentPath: r.error.argumentPath } : {}) } } : {}),
        ...(r?.output ? { output: compact(r.output) } : {}),
      };
    }),
    ...(summary ? { summaryShownToUser: summary } : {}),
  };
}

function compact(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : value;
}

/** Operações que o agente de IA pode usar nos lotes (as demais são da interface). */
export const AGENT_OPERATIONS = [
  "workspace.add_project",
  "workspace.clone_repository",
  "project.create_dir",
  "project.write_file",
  "semantic.upsert_observation",
  "semantic.upsert_inference",
  "region.create",
  "region.update",
  "region.delete",
  "mod.create",
  "mod.configure",
  "mod.delete",
  "canvas.place",
  "diagram.create",
  "diagram.apply_patch",
  "diagram.layout",
  "diagram.anchor",
  "diagram.delete",
  "navigation.frame",
  "navigation.overview",
];

/** Projeto em que o agente trabalha quando o pedido não diz outro: o último que o usuário abriu. */
export function activeProject(snapshot: WorkspaceSnapshot) {
  const id = snapshot.workspace.activeProjectId;
  return (id ? snapshot.projects.find((p) => p.id === id) : undefined) ?? snapshot.projects[snapshot.projects.length - 1];
}

/** Cabeçalho do bloco <workspace>: o que o modelo precisa para agir em qualquer pedido. O resto vem do motor de contexto. */
export function workspaceHeader(snapshot: WorkspaceSnapshot) {
  const active = activeProject(snapshot);
  return {
    ...(active ? { activeProjectId: active.id } : {}),
    projects: snapshot.projects.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.location.kind === "local" ? { folder: p.location.rootPath } : {}),
      roots: p.roots.map((r) => ({ id: r.id, path: r.path })),
      rootArtifactId: p.rootRef,
    })),
    cameraControl: snapshot.navigation.control?.mode ?? "agent_allowed",
  };
}

/** Resumo enxuto do workspace para o modelo (sem conteúdo de arquivos). */
export function summarizeWorkspace(snapshot: WorkspaceSnapshot) {
  const regionOf = new Map(snapshot.canvas.objects.map((o) => [o.id, o.regionId]));
  const limit = <T>(list: T[], n: number) => list.slice(0, n);
  const active = activeProject(snapshot);
  return {
    ...(active ? { activeProjectId: active.id } : {}),
    projects: snapshot.projects.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.location.kind === "local" ? { folder: p.location.rootPath } : {}),
      roots: p.roots.map((r) => ({ id: r.id, path: r.path })),
      rootArtifactId: p.rootRef,
    })),
    regions: snapshot.canvas.regions.map((r) => ({
      id: r.id,
      title: r.title,
      objects: snapshot.canvas.objects.filter((o) => o.regionId === r.id).map((o) => o.id),
      ...(r.semanticEntityIds?.length ? { semanticEntityIds: r.semanticEntityIds } : {}),
    })),
    mods: snapshot.mods.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      ...(regionOf.get(m.id) ? { regionId: regionOf.get(m.id) } : {}),
      ...(typeof m.config.rootRef === "string" ? { rootRef: m.config.rootRef } : {}),
      ...(typeof m.config.artifactId === "string" ? { artifactId: m.config.artifactId } : {}),
    })),
    diagrams: snapshot.diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      ...(d.anchorIds ? { anchorIds: d.anchorIds } : {}),
      ...(regionOf.get(d.id) ? { regionId: regionOf.get(d.id) } : {}),
      nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind, ...(n.semanticEntityId ? { semanticEntityId: n.semanticEntityId } : {}) })),
      edges: d.edges.map((e) => ({ id: e.id, from: e.sourceNodeId, to: e.targetNodeId, ...(e.label ? { label: e.label } : {}) })),
    })),
    semantic: {
      entities: limit(snapshot.semantic.entities, 200).map((e) => ({ id: e.id, kind: e.kind, name: e.name, status: e.status })),
      relations: limit(snapshot.semantic.relations, 200).map((r) => ({ id: r.id, type: r.type, from: r.sourceId, to: r.targetId, status: r.status })),
    },
    cameraControl: snapshot.navigation.control?.mode ?? "agent_allowed",
  };
}

const TOOLS: ToolSpec[] = [
  {
    name: "get_workspace",
    description:
      "Returns a compact summary of the whole workspace: projects, canvas regions, mods, diagrams and semantic entities/relations with their knowledge status. The <workspace> block in the user message already has what matters for the request; call this only when you need everything, or the state after your own changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_workspace",
    description:
      "Searches the whole workspace (units, diagrams, nodes, edges, mods, regions) by words, in any language the user writes. Returns the best matches with ids and their context units. Use it when the <workspace> block does not show what the user mentions.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for, e.g. 'api de pagamentos antifraude'." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description:
      "Lists one directory of an open project (not recursive). Path is relative to the project root; empty string for the root. Returns entries with path, kind and artifactId (artifactIds are what mods and file writes reference).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the project root, e.g. 'src' or ''." },
        projectId: { type: "string", description: "Only needed when more than one project is open." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: `Reads a text file of an open project. Long files are cut at ${MAX_FILE_CHARS} characters. Returns artifactId and contentHash (pass contentHash as expectedContentHash when writing the file).`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        projectId: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_operation",
    description: "Returns the exact JSON Schema of an operation's arguments. Use it before the first use of an operation whose arguments you are not sure about.",
    inputSchema: {
      type: "object",
      properties: { operation: { type: "string", enum: AGENT_OPERATIONS } },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "run_batch",
    description:
      "Executes a batch of workspace operations in dependency order. This is the ONLY way to change anything (files, canvas, diagrams, semantic layer, camera). All steps are validated first; if any step needs the user's confirmation, the call waits until the user approves or declines on a card in the app. Returns the real status of every step: report to the user only what succeeded.",
    inputSchema: {
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
              operation: { type: "string", enum: AGENT_OPERATIONS },
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
    },
  },
];
