import type { OperationResult } from "@open-semantic/protocol";

import type { OpenSemanticApi } from "../shared/api.js";

declare global {
  interface Window {
    openSemantic: OpenSemanticApi;
  }
}

export const api = (): OpenSemanticApi => window.openSemantic;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** Envia uma operação. Cada chamada tem um operationId novo; repetir a mesma chamada é seguro no núcleo. */
export function run(
  operation: string,
  args: Record<string, unknown> = {},
  extra: { preconditions?: unknown[] } = {},
): Promise<OperationResult> {
  return api().dispatch({ operationId: newId("act"), operation, arguments: args, ...extra });
}

export class OperationFailed extends Error {
  constructor(readonly result: OperationResult) {
    super(result.error?.message ?? `Operação ${result.status}`);
  }
}

/** Como run(), mas lança se o resultado não for sucesso. */
export async function runOk<T = Record<string, unknown>>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await run(operation, args);
  if (result.status !== "succeeded") throw new OperationFailed(result);
  return (result.output ?? {}) as T;
}
