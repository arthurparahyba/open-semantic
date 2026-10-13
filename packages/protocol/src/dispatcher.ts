import { createHash, randomUUID } from "node:crypto";

import { pointerFields, toContractError } from "./errors.js";
import type {
  ActionRecord,
  Change,
  ConfirmationRequest,
  DomainEvent,
  Error as ContractError,
  OperationRequest,
  OperationResult1 as OperationResult,
  Precondition,
} from "./generated/contracts.js";
import { compileWithContracts, contractValidator, describeErrors, primaryError } from "./schemas.js";
import { pruneExpired } from "./tokens.js";

export type Args = Record<string, unknown>;

export interface HandlerContext {
  request: OperationRequest;
  now(): Date;
}

export interface HandlerOutcome {
  output?: Args;
  changes: Change[];
  workspaceRevision?: number;
  undo?: ActionRecord["undo"];
}

/** Uma operação registrada. O módulo dono implementa; o Dispatcher valida, autoriza, registra e garante idempotência. */
export interface OperationHandler {
  /** Nome no formato modulo.acao, por exemplo "mod.create". */
  operation: string;
  /** JSON Schema dos argumentos. Pode usar {"$ref": "https://schemas.open-semantic.invalid/v0.2/..."}. */
  argumentsSchema?: object;
  /** Verificações que dependem do estado (referências existem, transição é válida). Lançar aqui → `rejected`. */
  check?(args: Args, ctx: HandlerContext): void | Promise<void>;
  /** Executa. Lançar aqui → `failed`. */
  handle(args: Args, ctx: HandlerContext): HandlerOutcome | Promise<HandlerOutcome>;
  /** Remove conteúdo de arquivo ou segredos antes de gravar no histórico. */
  redact?(args: Args): Args;
  /**
   * Só consulta: não muda o workspace nem arquivos (registrar o artefato consultado não conta).
   * O resultado não fica guardado para replay: repetir o mesmo operationId consulta de novo.
   */
  readOnly?: boolean;
}

export type AuthorizationDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "confirm"; risk: ConfirmationRequest["risk"]; summary: string; reversible?: boolean };

export type AuthorizationPolicy = (
  request: OperationRequest,
  handler: OperationHandler,
) => AuthorizationDecision | Promise<AuthorizationDecision>;

export type PreconditionOutcome =
  | { ok: true }
  | { ok: false; message: string; code?: "PRECONDITION_FAILED" | "REVISION_CONFLICT" | "EXTERNAL_CHANGE_CONFLICT" };

export type PreconditionEvaluator = (
  precondition: Precondition,
  request: OperationRequest,
) => PreconditionOutcome | Promise<PreconditionOutcome>;

export interface IdempotencyEntry {
  fingerprint: string;
  /** Ausente nas leituras: o reenvio consulta de novo, mas com outros argumentos ainda dá IDEMPOTENCY_MISMATCH. */
  result?: OperationResult;
}

export interface IdempotencyStore {
  get(operationId: string): IdempotencyEntry | undefined;
  set(operationId: string, entry: IdempotencyEntry): void;
}

export interface ActionLog {
  append(record: ActionRecord): void;
}

export interface DispatcherOptions {
  /** Padrão: permite tudo. A política real (V0.2 §6 de 06-conversa-agente-e-protocolo) entra no M2. */
  policy?: AuthorizationPolicy;
  /** Sem avaliador, qualquer requisição com pré-condições é rejeitada: melhor recusar do que ignorar. */
  evaluatePrecondition?: PreconditionEvaluator;
  idempotency?: IdempotencyStore;
  actionLog?: ActionLog;
  onEvent?: (event: DomainEvent) => void;
  now?: () => Date;
  newId?: (prefix: string) => string;
  confirmationTtlMs?: number;
  /** Confere cada OperationResult contra o schema antes de devolver. Ligado por padrão. */
  validateResults?: boolean;
}

/** Guarda os resultados mais recentes: reenvios acontecem logo depois do original, não horas depois. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  constructor(private readonly limit = 1_000) {}
  get(id: string) {
    return this.entries.get(id);
  }
  set(id: string, entry: IdempotencyEntry) {
    this.entries.delete(id);
    this.entries.set(id, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }
}

export class MemoryActionLog implements ActionLog {
  readonly records: ActionRecord[] = [];
  append(record: ActionRecord) {
    this.records.push(record);
  }
}

interface PendingConfirmation {
  operationId: string;
  fingerprint: string;
  expiresAt: number;
}

interface RegisteredHandler {
  handler: OperationHandler;
  validateArgs?: ReturnType<typeof compileWithContracts>;
}

const validateRequest = contractValidator("operation.schema.json#/$defs/OperationRequest");
const validateResult = contractValidator("operation.schema.json#/$defs/OperationResult");
const OPERATION_ID = /^act_[A-Za-z0-9_-]{3,64}$/;

/** Ponto único por onde o agente (e a interface) pedem mudanças. Ver docs/funcionalidades/06-conversa-agente-e-protocolo.md. */
export class Dispatcher {
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<OperationResult> }>();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly policy: AuthorizationPolicy;
  private readonly idempotency: IdempotencyStore;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly confirmationTtlMs: number;
  private readonly validateResults: boolean;

  constructor(private readonly options: DispatcherOptions = {}) {
    this.policy = options.policy ?? (() => ({ decision: "allow" }));
    this.idempotency = options.idempotency ?? new MemoryIdempotencyStore();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.confirmationTtlMs = options.confirmationTtlMs ?? 5 * 60_000;
    this.validateResults = options.validateResults ?? true;
  }

  register(handler: OperationHandler): this {
    if (!/^(workspace|canvas|region|mod|diagram|semantic|navigation|project)\.[a-z_]+$/.test(handler.operation)) {
      throw new Error(`nome de operação inválido: ${handler.operation}`);
    }
    if (this.handlers.has(handler.operation)) throw new Error(`operação já registrada: ${handler.operation}`);
    const entry: RegisteredHandler = { handler };
    if (handler.argumentsSchema) entry.validateArgs = compileWithContracts(handler.argumentsSchema);
    this.handlers.set(handler.operation, entry);
    return this;
  }

  /** Já existe resultado guardado para este operationId (reenvio será um replay). */
  recorded(operationId: string): boolean {
    return this.idempotency.get(operationId)?.result !== undefined;
  }

  operations(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** JSON Schema dos argumentos de uma operação (pode citar os contratos por $ref). */
  argumentsSchema(operation: string): object | undefined {
    return this.handlers.get(operation)?.handler.argumentsSchema;
  }

  /**
   * Checagem sem efeitos usada pelo executor de lotes antes de executar qualquer passo:
   * forma da requisição, operação conhecida, argumentos (quando não há $bind pendente) e decisão de autorização.
   */
  async inspect(raw: unknown): Promise<{ error?: ContractError; decision?: AuthorizationDecision }> {
    if (!validateRequest(raw)) {
      const err = primaryError(validateRequest.errors);
      return {
        error: {
          code: "INVALID_ARGUMENTS",
          message: `Requisição fora do contrato: ${describeErrors(validateRequest.errors)}`,
          retryable: false,
          ...pointerFields(err?.instancePath ?? ""),
        },
      };
    }
    const request = raw as OperationRequest;
    const entry = this.handlers.get(request.operation);
    if (!entry) {
      return {
        error: {
          code: "UNKNOWN_OPERATION",
          message: `Operação '${request.operation}' não está registrada.`,
          retryable: false,
          details: { known: this.operations() },
        },
      };
    }
    const bound = containsBinding(request.arguments) || containsBinding(request.targetId);
    if (!bound && entry.validateArgs && !entry.validateArgs(request.arguments)) {
      const err = primaryError(entry.validateArgs.errors);
      return {
        error: {
          code: "INVALID_ARGUMENTS",
          message: describeErrors(entry.validateArgs.errors),
          retryable: false,
          argumentPath: err?.instancePath || "/",
        },
      };
    }
    return { decision: await this.policy(request, entry.handler) };
  }

  /**
   * `preapproved` é só para chamadores internos de confiança (o executor de lotes, depois que o usuário
   * aprovou o cartão de confirmação do lote inteiro). Nunca é exposto à interface ou ao agente.
   */
  async dispatch(raw: unknown, options: { preapproved?: boolean } = {}): Promise<OperationResult> {
    const result = await this.dispatchInner(raw, options.preapproved ?? false);
    if (this.validateResults && !validateResult(result)) {
      throw new Error(`OperationResult fora do contrato: ${describeErrors(validateResult.errors)}`);
    }
    return result;
  }

  private async dispatchInner(raw: unknown, preapproved: boolean): Promise<OperationResult> {
    if (!validateRequest(raw)) {
      const err = primaryError(validateRequest.errors);
      const candidate = (raw as { operationId?: unknown } | null)?.operationId;
      const operationId = typeof candidate === "string" && OPERATION_ID.test(candidate) ? candidate : this.newId("act");
      return this.finish(operationId, "rejected", {
        error: {
          code: "INVALID_ARGUMENTS",
          message: `Requisição fora do contrato: ${describeErrors(validateRequest.errors)}`,
          retryable: false,
          ...pointerFields(err?.instancePath ?? ""),
        },
      });
    }
    const request = raw as OperationRequest;
    const fingerprint = fingerprintOf(request);

    // Duas entregas simultâneas do mesmo operationId: a segunda espera a primeira.
    const running = this.inFlight.get(request.operationId);
    if (running) {
      if (running.fingerprint !== fingerprint) return this.idempotencyMismatch(request);
      return { ...(await running.promise), replayed: true };
    }

    const stored = this.idempotency.get(request.operationId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) return this.idempotencyMismatch(request);
      if (stored.result) return { ...stored.result, replayed: true };
    }

    const promise = this.run(request, fingerprint, preapproved);
    this.inFlight.set(request.operationId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.inFlight.delete(request.operationId);
    }
  }

  private async run(request: OperationRequest, fingerprint: string, preapproved: boolean): Promise<OperationResult> {
    const requestedAt = this.now();
    const reject = (error: ContractError) => this.complete(request, requestedAt, "rejected", { error, changes: [] });

    if (containsBinding(request.arguments) || containsBinding(request.targetId)) {
      return reject({
        code: "INVALID_ARGUMENTS",
        message: "A requisição ainda tem $bind não resolvido; bindings só existem dentro de um lote.",
        retryable: false,
      });
    }

    const entry = this.handlers.get(request.operation);
    if (!entry) {
      return reject({
        code: "UNKNOWN_OPERATION",
        message: `Operação '${request.operation}' não está registrada.`,
        retryable: false,
        details: { known: this.operations() },
      });
    }
    const { handler, validateArgs } = entry;
    const args = request.arguments as Args;

    if (validateArgs && !validateArgs(args)) {
      const err = primaryError(validateArgs.errors);
      return reject({
        code: "INVALID_ARGUMENTS",
        message: describeErrors(validateArgs.errors),
        retryable: false,
        argumentPath: err?.instancePath || "/",
      });
    }

    for (const pre of request.preconditions ?? []) {
      const outcome: PreconditionOutcome = this.options.evaluatePrecondition
        ? await this.options.evaluatePrecondition(pre, request)
        : { ok: false, message: "Nenhum avaliador de pré-condições configurado." };
      if (!outcome.ok) {
        return reject({
          code: outcome.code ?? "PRECONDITION_FAILED",
          message: outcome.message,
          retryable: true,
          details: { precondition: pre },
        });
      }
    }

    const ctx: HandlerContext = { request, now: this.now };
    try {
      await handler.check?.(args, ctx);
    } catch (err) {
      return reject(toContractError(err));
    }

    const decision = await this.policy(request, handler);
    if (decision.decision === "deny") {
      return reject({ code: "UNAUTHORIZED", message: decision.reason, retryable: false });
    }
    if (decision.decision === "confirm" && !preapproved) {
      const token = request.authorization.confirmationToken;
      if (!token) return this.askConfirmation(request, fingerprint, decision);
      const pending = this.confirmations.get(token);
      if (!pending || pending.operationId !== request.operationId || pending.fingerprint !== fingerprint) {
        return reject({
          code: "UNAUTHORIZED",
          message: "Token de confirmação não corresponde a esta operação.",
          retryable: false,
        });
      }
      this.confirmations.delete(token);
      if (pending.expiresAt < this.now().getTime()) {
        return reject({
          code: "CONFIRMATION_EXPIRED",
          message: "A confirmação expirou; peça de novo.",
          retryable: true,
        });
      }
    }

    if (request.dryRun) {
      return this.finish(request.operationId, "succeeded", { output: { dryRun: true }, changes: [] });
    }

    let result: OperationResult;
    let undo: ActionRecord["undo"];
    try {
      const outcome = await handler.handle(args, ctx);
      undo = outcome.undo;
      result = await this.complete(
        request,
        requestedAt,
        "succeeded",
        {
          changes: outcome.changes,
          ...(outcome.output !== undefined && { output: outcome.output }),
          ...(outcome.workspaceRevision !== undefined && { workspaceRevision: outcome.workspaceRevision }),
        },
        handler,
        undo,
      );
    } catch (err) {
      result = await this.complete(request, requestedAt, "failed", { error: toContractError(err), changes: [] }, handler);
    }
    // Uma leitura não guarda a saída (o conteúdo de um arquivo, por exemplo): o reenvio consulta de novo.
    this.idempotency.set(request.operationId, handler.readOnly ? { fingerprint } : { fingerprint, result });
    return result;
  }

  private askConfirmation(
    request: OperationRequest,
    fingerprint: string,
    decision: Extract<AuthorizationDecision, { decision: "confirm" }>,
  ): OperationResult {
    const now = this.now().getTime();
    pruneExpired(this.confirmations, now, this.confirmationTtlMs);
    const token = randomUUID();
    const expiresAt = now + this.confirmationTtlMs;
    this.confirmations.set(token, { operationId: request.operationId, fingerprint, expiresAt });
    const confirmation: ConfirmationRequest = {
      token,
      risk: decision.risk,
      summary: decision.summary,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    if (decision.reversible !== undefined) confirmation.reversible = decision.reversible;
    return this.finish(request.operationId, "confirmation_required", { confirmation });
  }

  private idempotencyMismatch(request: OperationRequest): OperationResult {
    return this.finish(request.operationId, "rejected", {
      error: {
        code: "IDEMPOTENCY_MISMATCH",
        message: "Este operationId já foi usado com outros argumentos.",
        retryable: false,
      },
      changes: [],
    });
  }

  /** Resultado que entra no histórico e gera evento. */
  private async complete(
    request: OperationRequest,
    requestedAt: Date,
    status: "succeeded" | "rejected" | "failed",
    fields: Partial<OperationResult>,
    handler?: OperationHandler,
    undo?: ActionRecord["undo"],
  ): Promise<OperationResult> {
    const eventId = this.newId("evt");
    const result = this.finish(request.operationId, status, { ...fields, eventIds: [eventId] });

    const record: ActionRecord = {
      id: request.operationId,
      operation: request.operation,
      actor: request.authorization.actor,
      status,
      requestedAt: requestedAt.toISOString(),
      completedAt: result.completedAt,
      argumentsRedacted: handler?.redact ? handler.redact(request.arguments as Args) : (request.arguments as Args),
    };
    if (typeof request.targetId === "string") record.targetId = request.targetId;
    if (request.batchId) record.batchId = request.batchId;
    if (request.stepId) record.stepId = request.stepId;
    if (request.turnId) record.turnId = request.turnId;
    if (result.changes) record.changes = result.changes;
    if (result.error) record.error = result.error;
    if (undo) record.undo = undo;
    this.options.actionLog?.append(record);

    const event: DomainEvent = {
      eventId,
      type: "operation.completed",
      source: "orchestrator",
      operationId: request.operationId,
      payload: { operation: request.operation, status },
      at: result.completedAt,
    };
    if (result.workspaceRevision !== undefined) event.workspaceRevision = result.workspaceRevision;
    this.options.onEvent?.(event);
    return result;
  }

  private finish(
    operationId: string,
    status: OperationResult["status"],
    fields: Partial<OperationResult>,
  ): OperationResult {
    return { operationId, status, ...fields, completedAt: this.now().toISOString() };
  }
}

/** Identidade de uma requisição para idempotência: operação, alvo e argumentos (não a autorização). */
export function fingerprintOf(request: Pick<OperationRequest, "operation" | "targetId" | "arguments">): string {
  const canonical = stableStringify({
    operation: request.operation,
    targetId: request.targetId ?? null,
    arguments: request.arguments,
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Igualdade de valores JSON que não depende da ordem das chaves. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function containsBinding(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsBinding);
  if (value && typeof value === "object") {
    if ("$bind" in value) return true;
    return Object.values(value).some(containsBinding);
  }
  return false;
}

