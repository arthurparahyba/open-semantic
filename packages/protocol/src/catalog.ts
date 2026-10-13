// O catálogo de operações: cada operação diz no próprio handler quem pode chamá-la, se só consulta e como o
// agente de IA a usa. Daqui saem a política de autorização, a lista e o enum do agente, a descrição de cada
// passo no cartão do lote e a seção de operações do prompt (docs/funcionalidades/06-conversa-agente-e-protocolo.md).
import type {
  ActionRecord,
  Actor,
  Change,
  ConfirmationRequest,
  OperationRequest,
} from "./generated/contracts.js";

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

/** O que o cartão de confirmação mostra ao usuário. */
export type ConfirmationNeed = Pick<ConfirmationRequest, "risk" | "summary" | "reversible">;

/** Como o agente de IA usa a operação nos lotes. Sem isto, o agente não pede a operação (só lê, se for leitura). */
export interface AgentAccess {
  /** A linha da operação no prompt, em inglês como o resto dele: os argumentos principais e quando usar. */
  guide: string;
  /**
   * O passo em linguagem do usuário, no infinitivo ("criar a pasta backend/"), para o cartão do lote e o resumo.
   * Roda antes da validação: os argumentos podem estar incompletos ou ter `$bind`.
   */
  describe(args: Args): string;
  /** Quando devolve algo, o agente só executa depois que o usuário aprovar. */
  confirm?(args: Args): ConfirmationNeed | undefined;
}

/** Uma operação registrada. O módulo dono implementa; o Dispatcher valida, autoriza, registra e garante idempotência. */
export interface OperationHandler {
  /** Nome no formato modulo.acao, por exemplo "mod.create". O domínio precisa estar em OperationName (operation.schema.json). */
  operation: string;
  /** JSON Schema dos argumentos. Pode usar {"$ref": "https://schemas.open-semantic.invalid/v0.2/..."}. */
  argumentsSchema?: object;
  /** Quem pode chamar. Ausente: qualquer ator, e a política decide. */
  actors?: Actor["kind"][];
  /**
   * Só consulta: não muda o workspace nem arquivos (registrar o artefato consultado não conta).
   * O resultado não fica guardado para replay: repetir o mesmo operationId consulta de novo.
   */
  readOnly?: boolean;
  agent?: AgentAccess;
  /** Verificações que dependem do estado (referências existem, transição é válida). Lançar aqui → `rejected`. */
  check?(args: Args, ctx: HandlerContext): void | Promise<void>;
  /** Executa. Lançar aqui → `failed`. */
  handle(args: Args, ctx: HandlerContext): HandlerOutcome | Promise<HandlerOutcome>;
  /** Remove conteúdo de arquivo ou segredos antes de gravar no histórico. */
  redact?(args: Args): Args;
}

export type AuthorizationDecision = { decision: "allow" } | { decision: "deny"; reason: string } | ({ decision: "confirm" } & ConfirmationNeed);

export type AuthorizationPolicy = (
  request: OperationRequest,
  handler: OperationHandler,
) => AuthorizationDecision | Promise<AuthorizationDecision>;

/**
 * A política que sai do catálogo (docs/funcionalidades/06, tabela de autorização). O usuário age livremente pela interface.
 * Os outros atores consultam livremente e só mudam o que a operação abre ao agente, com confirmação quando `agent.confirm` pede.
 */
export const catalogPolicy: AuthorizationPolicy = (request, handler) => {
  if (request.authorization.actor.kind === "user" || handler.readOnly) return { decision: "allow" };
  if (!handler.agent) {
    return { decision: "deny", reason: `O agente não pode usar ${request.operation}; essa operação é só da interface.` };
  }
  const need = handler.agent.confirm?.(request.arguments as Args);
  return need ? { decision: "confirm", ...need } : { decision: "allow" };
};

const ACTOR_NAMES: Record<Actor["kind"], string> = { user: "o usuário", agent: "o agente", system: "o sistema" };

/** Motivo da recusa quando o ator não está entre os que podem chamar a operação; undefined quando pode. */
export function actorRefusal(handler: OperationHandler, actor: Actor): string | undefined {
  if (!handler.actors || handler.actors.includes(actor.kind)) return undefined;
  return `Só ${handler.actors.map((kind) => ACTOR_NAMES[kind]).join(" ou ")} pode usar ${handler.operation}.`;
}
