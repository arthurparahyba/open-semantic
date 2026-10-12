import type { Error as ContractError, ErrorCode } from "./generated/contracts.js";

/**
 * Erro lançado por handlers e pelo Dispatcher. Vira o campo `error` de um OperationResult.
 * Lançado em `check` → resultado `rejected`; lançado em `handle` → resultado `failed`.
 */
export class OperationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly argumentPath: string | undefined;
  readonly targetId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; argumentPath?: string; targetId?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.argumentPath = options.argumentPath;
    this.targetId = options.targetId;
    this.details = options.details;
  }

  toContract(): ContractError {
    const out: ContractError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.argumentPath !== undefined) out.argumentPath = this.argumentPath;
    if (this.targetId !== undefined) out.targetId = this.targetId;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function toContractError(err: unknown): ContractError {
  if (err instanceof OperationError) return err.toContract();
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL", message: message || "erro interno", retryable: false };
}
