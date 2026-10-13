// Ponte entre um agente (roteirizado ou de IA) e o executor de lotes:
// guarda lotes à espera de confirmação, aplica a decisão do usuário e narra o resultado efetivo.
import type { BatchExecutor, BatchPlan, BatchResult, OperationResult } from "@open-semantic/protocol";

export interface ActivityStep {
  stepId: string;
  operation: string;
  /** O que o passo pretende fazer, em linguagem do usuário. */
  label: string;
  status: OperationResult["status"] | "pending";
  error?: string;
  output?: Record<string, unknown>;
}

/** O que a interface mostra de cada lote do agente. Nunca inclui o token de confirmação. */
export interface AgentActivity {
  batchId: string;
  intent: string;
  status: BatchResult["status"];
  startedAt: string;
  steps: ActivityStep[];
  confirmation?: { risk: string; items: { stepId: string; summary: string }[] };
  /** Narração do resultado efetivo (só afirma o que terminou com sucesso). */
  summary?: string;
}

export interface AgentRunnerOptions {
  executor: BatchExecutor;
  /** O passo em linguagem do usuário, para o cartão do lote e o resumo. Vem do catálogo de operações (Dispatcher.describe). */
  describe(operation: string, args: Record<string, unknown>): string;
  now?: () => Date;
  onActivity?: (activity: AgentActivity) => void;
}

interface Pending {
  plan: BatchPlan;
  token: string;
  stepIds: string[];
}

export class AgentRunner {
  private readonly activities = new Map<string, AgentActivity>();
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Map<string, ((result: BatchResult) => void)[]>();
  private readonly now: () => Date;

  constructor(private readonly options: AgentRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  list(): AgentActivity[] {
    return [...this.activities.values()];
  }

  /** Executa um lote do agente. Se precisar de confirmação, fica pendente até `respond`. */
  async run(plan: BatchPlan): Promise<BatchResult> {
    const activity: AgentActivity = {
      batchId: plan.batchId,
      intent: plan.intent,
      status: "validating",
      startedAt: this.now().toISOString(),
      steps: plan.steps.map((s) => ({
        stepId: s.stepId,
        operation: s.request.operation,
        label: this.options.describe(s.request.operation, s.request.arguments),
        status: "pending",
      })),
    };
    this.publish(activity);
    return this.execute(plan, activity);
  }

  /** Há um lote esperando a confirmação do usuário. */
  isPending(batchId: string): boolean {
    return this.pending.has(batchId);
  }

  /**
   * Resolve quando o lote termina de verdade: na hora, se já terminou; senão, depois que o usuário
   * responder ao cartão de confirmação e o lote rodar (ou for recusado).
   */
  settled(batchId: string, current: BatchResult): Promise<BatchResult> {
    if (current.status !== "awaiting_confirmation" || !this.pending.has(batchId)) return Promise.resolve(current);
    return new Promise((resolve) => this.waiters.set(batchId, [...(this.waiters.get(batchId) ?? []), resolve]));
  }

  /** Resposta do usuário ao cartão de confirmação. */
  async respond(batchId: string, approve: boolean): Promise<BatchResult | undefined> {
    const pending = this.pending.get(batchId);
    const activity = this.activities.get(batchId);
    if (!pending || !activity) return undefined;
    this.pending.delete(batchId);
    delete activity.confirmation;
    if (!approve) {
      const result = this.options.executor.decline(pending.token, pending.plan);
      this.apply(activity, result, pending.plan);
      return result;
    }
    const approved = structuredClone(pending.plan);
    for (const step of approved.steps) {
      if (pending.stepIds.includes(step.stepId)) step.request.authorization.confirmationToken = pending.token;
    }
    return this.execute(approved, activity);
  }

  private async execute(plan: BatchPlan, activity: AgentActivity): Promise<BatchResult> {
    let result: BatchResult;
    try {
      result = await this.options.executor.run(plan, {
        onProgress: (partial) => this.apply(activity, partial, plan, false),
      });
    } catch (err) {
      activity.status = "rejected";
      activity.summary = `Não executei nada: ${err instanceof Error ? err.message : String(err)}`;
      this.publish(activity);
      const waiting = this.waiters.get(plan.batchId) ?? [];
      this.waiters.delete(plan.batchId);
      for (const resolve of waiting) resolve({ batchId: plan.batchId, status: "rejected", steps: {} });
      throw err;
    }
    if (result.status === "awaiting_confirmation") {
      const stepIds = result.pendingConfirmations ?? [];
      const first = result.steps[stepIds[0]!]!.confirmation!;
      this.pending.set(plan.batchId, { plan, token: first.token, stepIds });
      activity.confirmation = {
        risk: highestRisk(stepIds.map((id) => result.steps[id]!.confirmation!.risk)),
        items: stepIds.map((id) => ({ stepId: id, summary: result.steps[id]!.confirmation!.summary })),
      };
    }
    this.apply(activity, result, plan);
    return result;
  }

  private apply(activity: AgentActivity, result: BatchResult, plan: BatchPlan, final = true) {
    activity.status = result.status;
    for (const step of activity.steps) {
      const r = result.steps[step.stepId];
      if (!r) continue;
      step.status = r.status;
      if (r.error) step.error = r.error.message;
      else delete step.error;
      if (r.output) step.output = r.output;
    }
    if (final && result.status !== "awaiting_confirmation") activity.summary = summarizeBatch(plan, result, activity);
    this.publish(activity);
    if (final && result.status !== "awaiting_confirmation") {
      const waiting = this.waiters.get(plan.batchId) ?? [];
      this.waiters.delete(plan.batchId);
      for (const resolve of waiting) resolve(result);
    }
  }

  private publish(activity: AgentActivity) {
    this.activities.set(activity.batchId, activity);
    // Mantém só os lotes mais recentes na memória.
    while (this.activities.size > 30) this.activities.delete(this.activities.keys().next().value!);
    this.options.onActivity?.(structuredClone(activity));
  }
}

function highestRisk(risks: string[]): string {
  const order = ["low", "medium", "high", "irreversible"];
  return risks.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "low");
}

/**
 * Narração do resultado efetivo. Só afirma o que terminou com `succeeded` (V0.1 §6: sem simular sucesso);
 * todo o resto aparece como não feito, com o motivo.
 */
export function summarizeBatch(plan: BatchPlan, result: BatchResult, activity: AgentActivity): string {
  const label = (stepId: string) => activity.steps.find((s) => s.stepId === stepId)?.label ?? stepId;
  const done: string[] = [];
  const notDone: string[] = [];
  const notes: string[] = [];
  for (const step of plan.steps) {
    const r = result.steps[step.stepId];
    if (!r) continue;
    if (r.status === "succeeded") {
      const output = (r.output ?? {}) as { deferred?: boolean; unchanged?: boolean; reason?: string };
      if (step.request.operation.startsWith("navigation.") && output.deferred) {
        notes.push(`Não movi a câmera porque você estava usando o canvas; deixei a sugestão “${output.reason ?? "ver"}” para quando quiser.`);
        continue;
      }
      const unchanged = r.changes?.length && r.changes.every((c) => c.change === "unchanged");
      done.push(unchanged && !step.request.operation.startsWith("navigation.") ? `${label(step.stepId)} (já estava assim)` : label(step.stepId));
      if (step.request.operation === "semantic.upsert_inference") {
        notes.push("O que registrei como suposição continua marcado como inferido até haver evidência no projeto.");
      }
    } else if (r.status !== "confirmation_required") {
      notDone.push(`${label(step.stepId)}: ${reasonOf(r)}`);
    }
  }
  const lines: string[] = [];
  if (result.status === "rejected") lines.push("Não executei nada: o plano tinha problemas.");
  if (result.status === "cancelled" && done.length === 0) lines.push("Não executei nada.");
  if (done.length) lines.push(`Feito: ${done.join("; ")}.`);
  if (notDone.length) lines.push(`Não feito: ${notDone.join("; ")}.`);
  lines.push(...new Set(notes));
  return lines.join("\n");
}

function reasonOf(r: OperationResult): string {
  switch (r.status) {
    case "skipped":
      return "pulado porque um passo anterior não deu certo";
    case "cancelled":
      return r.error?.code === "CONFIRMATION_DECLINED" ? "você recusou" : "cancelado";
    default:
      return r.error?.message ?? r.status;
  }
}
