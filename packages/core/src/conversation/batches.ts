// Os lotes que o modelo pede viram planos do agente: cartão no chat, confirmação do usuário quando precisa
// e, de volta ao modelo, o status real de cada passo.
import type { BatchPlan, BatchResult } from "@open-semantic/protocol";

import type { AgentRunner } from "../agent.js";
import type { TurnBudget } from "./budget.js";
import type { Chat } from "./chat.js";
import { CLAUDE_AGENT } from "./types.js";

export class ConversationBatches {
  /** Lote esperando a confirmação do usuário: o Parar o recusa. */
  private waiting: string | undefined;

  constructor(
    private readonly agent: AgentRunner,
    private readonly chat: Chat,
    private readonly newId: () => string,
  ) {}

  /** Parar: o lote que espera confirmação é recusado. */
  decline() {
    if (this.waiting) void this.agent.respond(this.waiting, false);
  }

  /** Fim do pedido: nenhum lote espera mais. */
  settle() {
    this.waiting = undefined;
  }

  /** Roda os passos que o modelo pediu (a entrada de run_batch) dentro do orçamento do pedido. */
  async run(input: Record<string, unknown>, budget: TurnBudget) {
    const steps = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : [];
    if (!steps.length) throw new Error("O lote precisa de pelo menos um passo.");
    budget.reserveBatch(steps.length);
    const plan = planOf(input, steps, this.newId());
    this.chat.push({ kind: "batch", batchId: plan.batchId });
    let result: BatchResult;
    try {
      result = await this.agent.run(plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { batchId: plan.batchId, status: "rejected", error: message, note: "Nenhum passo foi executado." };
    }
    if (result.status === "awaiting_confirmation") result = await this.confirm(plan.batchId, result);
    return describeResult(plan, result, this.agent.list().find((a) => a.batchId === plan.batchId)?.summary);
  }

  private async confirm(batchId: string, pending: BatchResult): Promise<BatchResult> {
    this.waiting = batchId;
    this.chat.setStatus("waiting_user");
    const result = await this.agent.settled(batchId, pending);
    this.waiting = undefined;
    this.chat.setStatus("working");
    return result;
  }
}

/** O plano do agente para os passos do modelo. Ids de operação são novos a cada lote. */
function planOf(input: Record<string, unknown>, steps: Record<string, unknown>[], run: string): BatchPlan {
  return {
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
}

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
