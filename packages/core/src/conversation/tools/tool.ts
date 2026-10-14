// Uma ferramenta do modelo: nome, descrição, schema da entrada e execução. Criar uma é criar um arquivo
// nesta pasta e pôr a ferramenta na lista de tools/index.ts.
import type { Dispatcher, WorkspaceSnapshot } from "@open-semantic/protocol";

import type { WorkspaceContext } from "../../context.js";

/** O que uma ferramenta usa da conversa durante um pedido. */
export interface ToolContext {
  dispatcher: Dispatcher;
  snapshot(): WorkspaceSnapshot;
  /** Motor de contexto ligado ao workspace. */
  context: WorkspaceContext;
  newId(): string;
  /** Mostra no chat o que o agente consultou ("Leu README.md"). */
  note(text: string): void;
  /**
   * O que o agente de fato leu nesta conversa: caminho → conteúdo (arquivo) ou null (pasta listada).
   * É daqui, e não da palavra do modelo, que sai o "verificado" de uma caixa.
   */
  reads: Map<string, string | null>;
  /** Roda passos como um lote do agente, no orçamento do pedido (a entrada de run_batch). */
  runBatch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ConversationTool {
  name: string;
  description: string;
  /** JSON Schema da entrada. As ferramentas que citam operações recebem as que o catálogo abre ao agente. */
  inputSchema(operations: string[]): Record<string, unknown>;
  /** O resultado é o de um lote: a compactação do histórico guarda o resumo dele. */
  runsBatch?: boolean;
  /** O que volta ao modelo, como JSON. Um erro volta como resultado de erro, com a mensagem. */
  run(input: Record<string, unknown>, ctx: ToolContext): unknown;
}
