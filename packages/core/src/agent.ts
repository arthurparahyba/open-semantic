// Ponte entre um agente (roteirizado no M2, de IA depois) e o executor de lotes:
// guarda lotes à espera de confirmação, aplica a decisão do usuário e narra o resultado efetivo.
import {
  type BatchExecutor,
  type BatchPlan,
  type BatchResult,
  type OperationResult,
  type WorkspaceSnapshot,
} from "@open-semantic/protocol";

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
  snapshot(): WorkspaceSnapshot;
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
  private readonly now: () => Date;

  constructor(private readonly options: AgentRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  list(): AgentActivity[] {
    return [...this.activities.values()];
  }

  /** Executa um lote do agente. Se precisar de confirmação, fica pendente até `respond`. */
  async run(plan: BatchPlan): Promise<BatchResult> {
    const labels = new Map(plan.steps.map((s) => [s.stepId, describeStep(s.request.operation, s.request.arguments, this.options.snapshot())]));
    const activity: AgentActivity = {
      batchId: plan.batchId,
      intent: plan.intent,
      status: "validating",
      startedAt: this.now().toISOString(),
      steps: plan.steps.map((s) => ({ stepId: s.stepId, operation: s.request.operation, label: labels.get(s.stepId)!, status: "pending" })),
    };
    this.publish(activity);
    return this.execute(plan, activity);
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

/** Descrição curta de um passo, no infinitivo ("criar a pasta backend/"). */
export function describeStep(operation: string, args: Record<string, unknown>, snapshot?: WorkspaceSnapshot): string {
  const a = args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const modTitle = (id: string) => snapshot?.mods.find((m) => m.id === id)?.title ?? id;
  const typeName: Record<string, string> = { explorer: "um Explorer", editor: "um Editor" };
  switch (operation) {
    case "project.create_dir":
      return `criar a pasta ${a.path}/`;
    case "semantic.upsert_observation":
      return `registrar ${a.entity?.name ?? "a entidade"} como conhecimento verificado`;
    case "semantic.upsert_inference": {
      const declared = new Map<string, string>((a.entities ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));
      const nameOf = (id: string) => declared.get(id) ?? snapshot?.semantic.entities.find((e) => e.id === id)?.name ?? id;
      const names = [
        ...(a.entities ?? []).map((e: { name: string }) => e.name),
        ...(a.relations ?? []).map((r: { sourceId: string; targetId: string }) => `${nameOf(r.sourceId)} → ${nameOf(r.targetId)}`),
      ];
      return `registrar como suposição: ${names.join(", ") || "inferência"}`;
    }
    case "region.create":
      return `criar a região “${a.title}”`;
    case "mod.create":
      return `abrir ${typeName[a.type] ?? `um mod ${a.type}`}${a.title ? ` “${a.title}”` : ""}`;
    case "mod.delete":
      return `remover “${modTitle(a.modId)}” do canvas`;
    case "diagram.create":
      return `montar o diagrama “${a.title}”`;
    case "diagram.apply_patch":
      return `alterar o diagrama ${a.diagramId}`;
    case "diagram.delete":
      return `excluir o diagrama ${a.diagramId}`;
    case "navigation.frame":
      return a.reason ? `mostrar na tela: ${a.reason}` : "enquadrar os objetos na tela";
    case "navigation.overview":
      return "mostrar o canvas inteiro";
    case "project.write_file":
      return "gravar alterações em um arquivo";
    default:
      return operation;
  }
}

/**
 * Narração do resultado efetivo. Só afirma o que terminou com `succeeded` (V0.1 §6: sem simular sucesso);
 * todo o resto aparece como não feito, com o motivo.
 */
export function summarizeBatch(plan: BatchPlan, result: BatchResult, activity?: AgentActivity): string {
  const label = (stepId: string) => {
    const known = activity?.steps.find((s) => s.stepId === stepId)?.label;
    if (known) return known;
    const step = plan.steps.find((s) => s.stepId === stepId)!;
    return describeStep(step.request.operation, step.request.arguments);
  };
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
  lines.push(...notes);
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
