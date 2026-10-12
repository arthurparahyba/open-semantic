import { randomUUID } from "node:crypto";

import { OperationError } from "./errors.js";
import { containsBinding, fingerprintOf, stableStringify, type Dispatcher } from "./dispatcher.js";
import type {
  BatchPlan,
  BatchResult,
  BatchStep,
  ConfirmationRequest,
  DomainEvent,
  Error as ContractError,
  OperationRequest,
  OperationResult1 as OperationResult,
} from "./generated/contracts.js";
import { contractValidator, describeErrors } from "./schemas.js";

const validatePlan = contractValidator("operation.schema.json#/$defs/BatchPlan");
const validateBatchResult = contractValidator("operation.schema.json#/$defs/BatchResult");

const RISK_ORDER: ConfirmationRequest["risk"][] = ["low", "medium", "high", "irreversible"];

export interface BatchExecutorOptions {
  dispatcher: Dispatcher;
  now?: () => Date;
  newId?: (prefix: string) => string;
  onEvent?: (event: DomainEvent) => void;
  confirmationTtlMs?: number;
}

export interface RunOptions {
  /** Chamado a cada passo concluído, com o resultado parcial (status "running"). */
  onProgress?: (result: BatchResult) => void;
}

interface PendingBatch {
  batchId: string;
  fingerprint: string;
  stepIds: string[];
  expiresAt: number;
}

/**
 * Executa um BatchPlan (decisão D3): valida antes de agir, pede todas as confirmações num único cartão,
 * resolve $bind, executa em ordem topológica e aplica a política de falha.
 * Ver docs/funcionalidades/06-conversa-agente-e-protocolo.md.
 *
 * Passos rodam um de cada vez, na ordem topológica estável (ordem de declaração entre passos prontos).
 * `confirmation: "per_step"` é aceito e, por enquanto, se comporta como "upfront".
 */
export class BatchExecutor {
  private readonly dispatcher: Dispatcher;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly confirmationTtlMs: number;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly cancelRequested = new Set<string>();

  constructor(private readonly options: BatchExecutorOptions) {
    this.dispatcher = options.dispatcher;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.confirmationTtlMs = options.confirmationTtlMs ?? 10 * 60_000;
  }

  /** Lança OperationError(INVALID_ARGUMENTS) se o plano não segue o contrato BatchPlan. */
  async run(raw: unknown, runOptions: RunOptions = {}): Promise<BatchResult> {
    if (!validatePlan(raw)) {
      throw new OperationError("INVALID_ARGUMENTS", `Lote fora do contrato: ${describeErrors(validatePlan.errors)}`, {
        argumentPath: validatePlan.errors?.[0]?.instancePath || "/",
      });
    }
    const plan = raw as BatchPlan;
    const policy = {
      onStepFailure: plan.policy.onStepFailure ?? "skip_dependents",
      validateFirst: plan.policy.validateFirst ?? true,
    };
    const steps = new Map(plan.steps.map((s) => [s.stepId, s]));
    this.emit(plan, "validating");

    const structural = this.checkStructure(plan);
    if (structural.size > 0) return this.finish(plan, "rejected", Object.fromEntries(structural));
    const order = topologicalOrder(plan.steps);

    // 1. Validação e autorização de todos os passos antes de qualquer efeito.
    const rejected: Record<string, OperationResult> = {};
    const needsConfirmation: { step: BatchStep; risk: ConfirmationRequest["risk"]; summary: string; reversible?: boolean }[] = [];
    for (const step of plan.steps) {
      const request = this.requestFor(plan, step);
      if (this.dispatcher.recorded(request.operationId)) continue; // reenvio: será replay
      const { error, decision } = await this.dispatcher.inspect(request);
      if (error) {
        if (policy.validateFirst) rejected[step.stepId] = this.stepResult(request.operationId, "rejected", error);
        continue;
      }
      if (decision?.decision === "deny") {
        rejected[step.stepId] = this.stepResult(request.operationId, "rejected", {
          code: "UNAUTHORIZED",
          message: decision.reason,
          retryable: false,
        });
      } else if (decision?.decision === "confirm") {
        needsConfirmation.push({
          step,
          risk: decision.risk,
          summary: decision.summary,
          ...(decision.reversible !== undefined && { reversible: decision.reversible }),
        });
      }
    }
    if (Object.keys(rejected).length > 0) return this.finish(plan, "rejected", rejected);

    // 2. Confirmação única para o lote (critério E5: nada roda antes da aprovação).
    const preapproved = new Set<string>();
    if (needsConfirmation.length > 0) {
      const tokens = new Set(needsConfirmation.map((n) => n.step.request.authorization.confirmationToken));
      const token = tokens.size === 1 ? [...tokens][0] : undefined;
      if (!token) return this.askConfirmation(plan, needsConfirmation);
      const pending = this.pending.get(token);
      const fingerprint = planFingerprint(plan);
      if (!pending || pending.batchId !== plan.batchId || pending.fingerprint !== fingerprint) {
        return this.rejectAll(plan, needsConfirmation.map((n) => n.step), {
          code: "UNAUTHORIZED",
          message: "Token de confirmação não corresponde a este lote. Peça a confirmação de novo.",
          retryable: false,
        });
      }
      this.pending.delete(token);
      if (pending.expiresAt < this.now().getTime()) {
        return this.rejectAll(plan, needsConfirmation.map((n) => n.step), {
          code: "CONFIRMATION_EXPIRED",
          message: "A confirmação expirou; peça de novo.",
          retryable: true,
        });
      }
      for (const n of needsConfirmation) preapproved.add(n.step.stepId);
    }

    // 3. Execução.
    this.emit(plan, "running");
    const results: Record<string, OperationResult> = {};
    let aborted = false;
    for (const stepId of order) {
      const step = steps.get(stepId)!;
      const request = this.requestFor(plan, step);
      if (this.cancelRequested.has(plan.batchId) || aborted) {
        results[stepId] = this.stepResult(request.operationId, "cancelled", {
          code: "CANCELLED",
          message: aborted ? "Lote interrompido depois de uma falha (abort_batch)." : "Lote cancelado pelo usuário.",
          retryable: true,
        });
        continue;
      }
      const failedDependency = (step.dependsOn ?? []).find((d) => results[d]?.status !== "succeeded");
      if (failedDependency) {
        results[stepId] = this.stepResult(request.operationId, "skipped", {
          code: "DEPENDENCY_FAILED",
          message: `Não executado porque o passo '${failedDependency}' não terminou com sucesso.`,
          retryable: true,
          details: { dependency: failedDependency },
        });
        continue;
      }
      let resolved: OperationRequest;
      try {
        resolved = resolveBindings(request, results);
      } catch (err) {
        results[stepId] = this.stepResult(request.operationId, "rejected", (err as OperationError).toContract());
      }
      if (!results[stepId]) {
        results[stepId] = await this.dispatcher.dispatch(resolved!, { preapproved: preapproved.has(stepId) });
      }
      if (results[stepId]!.status !== "succeeded" && policy.onStepFailure === "abort_batch") aborted = true;
      runOptions.onProgress?.({ batchId: plan.batchId, status: "running", steps: { ...results } });
    }
    this.cancelRequested.delete(plan.batchId);

    const statuses = Object.values(results).map((r) => r.status);
    const succeeded = statuses.filter((s) => s === "succeeded").length;
    const status: BatchResult["status"] = statuses.includes("cancelled") && !aborted
      ? "cancelled"
      : succeeded === statuses.length
        ? "completed"
        : succeeded === 0
          ? "failed"
          : "partially_completed";
    return this.finish(plan, status, results);
  }

  /** O usuário recusou o cartão: nada roda, cada passo que pedia confirmação fica `cancelled`. */
  decline(token: string, plan: BatchPlan): BatchResult {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    const stepIds = new Set(pending?.stepIds ?? []);
    const results: Record<string, OperationResult> = {};
    for (const step of plan.steps) {
      results[step.stepId] = this.stepResult(
        step.request.operationId,
        "cancelled",
        stepIds.has(step.stepId)
          ? { code: "CONFIRMATION_DECLINED", message: "O usuário recusou a confirmação.", retryable: false }
          : { code: "CANCELLED", message: "Lote não executado porque a confirmação foi recusada.", retryable: false },
      );
    }
    return this.finish(plan, "cancelled", results);
  }

  /** Passos em curso terminam; os pendentes viram `cancelled`. */
  cancel(batchId: string) {
    this.cancelRequested.add(batchId);
  }

  private askConfirmation(
    plan: BatchPlan,
    items: { step: BatchStep; risk: ConfirmationRequest["risk"]; summary: string; reversible?: boolean }[],
  ): BatchResult {
    const token = randomUUID();
    const expiresAt = this.now().getTime() + this.confirmationTtlMs;
    this.pending.set(token, {
      batchId: plan.batchId,
      fingerprint: planFingerprint(plan),
      stepIds: items.map((i) => i.step.stepId),
      expiresAt,
    });
    const steps: Record<string, OperationResult> = {};
    for (const item of items) {
      const confirmation: ConfirmationRequest = {
        token,
        risk: item.risk,
        summary: item.summary,
        expiresAt: new Date(expiresAt).toISOString(),
      };
      if (item.reversible !== undefined) confirmation.reversible = item.reversible;
      steps[item.step.stepId] = {
        operationId: item.step.request.operationId,
        status: "confirmation_required",
        confirmation,
        completedAt: this.now().toISOString(),
      };
    }
    const result = this.finish(plan, "awaiting_confirmation", steps);
    result.pendingConfirmations = items.map((i) => i.step.stepId);
    delete result.completedAt;
    return result;
  }

  private rejectAll(plan: BatchPlan, steps: BatchStep[], error: ContractError): BatchResult {
    return this.finish(
      plan,
      "rejected",
      Object.fromEntries(steps.map((s) => [s.stepId, this.stepResult(s.request.operationId, "rejected", error)])),
    );
  }

  /** Dependências existentes, DAG, ids únicos e $bind só de passos dos quais se depende. */
  private checkStructure(plan: BatchPlan): Map<string, OperationResult> {
    const problems = new Map<string, OperationResult>();
    const fail = (step: BatchStep, message: string, details?: Record<string, unknown>) => {
      if (problems.has(step.stepId)) return;
      problems.set(
        step.stepId,
        this.stepResult(step.request.operationId, "rejected", {
          code: "INVALID_ARGUMENTS",
          message,
          retryable: false,
          ...(details && { details }),
        }),
      );
    };
    const seenSteps = new Set<string>();
    const seenOps = new Set<string>();
    for (const step of plan.steps) {
      if (seenSteps.has(step.stepId)) fail(step, `stepId '${step.stepId}' repetido no lote.`);
      if (seenOps.has(step.request.operationId)) fail(step, `operationId '${step.request.operationId}' repetido no lote.`);
      seenSteps.add(step.stepId);
      seenOps.add(step.request.operationId);
    }
    const ids = new Set(plan.steps.map((s) => s.stepId));
    for (const step of plan.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!ids.has(dep)) fail(step, `'${step.stepId}' depende de um passo inexistente: '${dep}'.`, { dependency: dep });
      }
    }
    const cycle = findCycle(plan.steps);
    if (cycle) {
      for (const stepId of cycle) {
        fail(plan.steps.find((s) => s.stepId === stepId)!, `Ciclo de dependências: ${cycle.join(" → ")}.`, { cycle });
      }
      return problems;
    }
    const ancestors = ancestorsOf(plan.steps);
    for (const step of plan.steps) {
      for (const bound of bindingSteps(step.request)) {
        if (!ancestors.get(step.stepId)!.has(bound)) {
          fail(step, `'${step.stepId}' usa $bind de '${bound}' sem depender dele.`, { binding: bound });
        }
      }
    }
    return problems;
  }

  private requestFor(plan: BatchPlan, step: BatchStep): OperationRequest {
    return {
      ...step.request,
      batchId: plan.batchId,
      stepId: step.stepId,
      ...(plan.turnId && !step.request.turnId ? { turnId: plan.turnId } : {}),
    };
  }

  private stepResult(operationId: string, status: OperationResult["status"], error: ContractError): OperationResult {
    return { operationId, status, error, completedAt: this.now().toISOString() };
  }

  private finish(plan: BatchPlan, status: BatchResult["status"], steps: Record<string, OperationResult>): BatchResult {
    const result: BatchResult = { batchId: plan.batchId, status, steps, completedAt: this.now().toISOString() };
    if (!validateBatchResult(result)) {
      throw new Error(`BatchResult fora do contrato: ${describeErrors(validateBatchResult.errors)}`);
    }
    this.emit(plan, status);
    return result;
  }

  private emit(plan: BatchPlan, status: BatchResult["status"]) {
    this.options.onEvent?.({
      eventId: this.newId("evt"),
      type: "batch.status_changed",
      source: "orchestrator",
      payload: { batchId: plan.batchId, status, intent: plan.intent },
      at: this.now().toISOString(),
    });
  }
}

/** Identidade do lote para a confirmação: tudo menos os tokens. */
export function planFingerprint(plan: BatchPlan): string {
  const stripped = {
    ...plan,
    steps: plan.steps.map((s) => {
      const { confirmationToken: _token, ...authorization } = s.request.authorization;
      return { ...s, request: { ...s.request, authorization } };
    }),
  };
  return fingerprintOf({ operation: "batch.run", arguments: JSON.parse(stableStringify(stripped)) as Record<string, unknown> });
}

/** Ordem de execução: entre os passos prontos, sempre o primeiro declarado. */
export function topologicalOrder(steps: BatchStep[]): string[] {
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < steps.length) {
    const next = steps.find((s) => !done.has(s.stepId) && (s.dependsOn ?? []).every((d) => done.has(d)));
    if (!next) throw new Error("lote com ciclo");
    done.add(next.stepId);
    order.push(next.stepId);
  }
  return order;
}

function findCycle(steps: BatchStep[]): string[] | undefined {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done" || !byId.has(id)) return undefined;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const step of steps) {
    const cycle = visit(step.stepId);
    if (cycle) return cycle;
  }
  return undefined;
}

function ancestorsOf(steps: BatchStep[]): Map<string, Set<string>> {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const memo = new Map<string, Set<string>>();
  const of = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      set.add(dep);
      for (const a of of(dep)) set.add(a);
    }
    memo.set(id, set);
    return set;
  };
  for (const s of steps) of(s.stepId);
  return memo;
}

function bindingSteps(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(bindingSteps);
  if (value && typeof value === "object") {
    const bind = (value as { $bind?: { step?: unknown } }).$bind;
    if (bind && typeof bind.step === "string") return [bind.step];
    return Object.values(value).flatMap(bindingSteps);
  }
  return [];
}

/** Substitui cada {"$bind": {step, pointer}} pelo valor apontado no resultado do passo. */
export function resolveBindings(request: OperationRequest, results: Record<string, OperationResult>): OperationRequest {
  if (!containsBinding(request.arguments) && !containsBinding(request.targetId)) return request;
  const resolve = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => resolve(v, `${path}/${i}`));
    if (value && typeof value === "object") {
      const bind = (value as { $bind?: { step: string; pointer: string } }).$bind;
      if (bind) {
        const found = readPointer(results[bind.step], bind.pointer);
        if (found === undefined) {
          throw new OperationError(
            "INVALID_ARGUMENTS",
            `$bind '${bind.step}${bind.pointer}' não existe no resultado do passo.`,
            { argumentPath: path, details: { binding: bind } },
          );
        }
        return structuredClone(found);
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, `${path}/${k}`)]));
    }
    return value;
  };
  const out = { ...request, arguments: resolve(request.arguments, "/arguments") as Record<string, unknown> };
  if (request.targetId !== undefined) out.targetId = resolve(request.targetId, "/targetId") as string;
  return out;
}

function readPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
