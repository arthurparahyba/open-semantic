// A operação do Dispatcher em execução em cada fluxo assíncrono. Os eventos de domínio que saem dos commits
// do store usam isto para dizer qual operação os causou, mesmo depois de um await ou de um timer.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

/** Roda `fn` como parte da operação: o que acontecer dentro dela, inclusive depois de awaits, sabe o operationId. */
export function runInOperation<T>(operationId: string, fn: () => T): T {
  return scope.run(operationId, fn);
}

/** A operação em execução neste fluxo, se houver. */
export function currentOperationId(): string | undefined {
  return scope.getStore();
}
