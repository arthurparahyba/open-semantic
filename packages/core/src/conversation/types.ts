// O que a conversa mostra à interface e o que o núcleo passa para ela.
import type { LlmProvider, Usage } from "@open-semantic/llm";
import type { Dispatcher, WorkspaceSnapshot } from "@open-semantic/protocol";

import type { AgentRunner } from "../agent.js";
import type { TurnLimits } from "./budget.js";

export const CLAUDE_AGENT = { kind: "agent" as const, id: "claude" };

export interface ConversationSettings {
  model: string;
  /** Teto de custo por pedido, em dólares. A conversa para antes da chamada que passaria dele. */
  maxCostPerRequestUsd: number;
}

export type ChatEntry =
  | { id: string; kind: "user"; text: string; at: string }
  /** Resposta do agente. Quando o pedido desenhou ou mudou diagramas, o texto é a legenda deles. */
  | { id: string; kind: "assistant"; text: string; diagramIds?: string[]; at: string }
  /** Um lote de mudanças; a interface mostra o cartão do lote (passos, confirmação, resultado). */
  | { id: string; kind: "batch"; batchId: string; at: string }
  /** Leitura feita pelo agente (pasta, arquivo, workspace), para o usuário ver o que ele consultou. */
  | { id: string; kind: "tool"; text: string; at: string }
  | { id: string; kind: "notice"; text: string; tone: "info" | "limit" | "error"; at: string }
  /**
   * Do motor de contexto: a pergunta rápida quando a dúvida muda o foco (o pedido espera a resposta),
   * ou a suposição feita, que a pessoa pode trocar. A interface mostra as opções como botões.
   */
  | {
      id: string;
      kind: "choice";
      mode: "question" | "assumption";
      /** Termo normalizado da mensagem; a escolha vale para ele nos próximos pedidos. */
      term: string;
      text: string;
      options: { ref: string; label: string }[];
      chosen?: string;
      at: string;
    };

export type ChoiceEntry = Extract<ChatEntry, { kind: "choice" }>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Uma entrada antes de ganhar id e horário. */
export type NewChatEntry = DistributiveOmit<ChatEntry, "id" | "at">;

export interface ConversationView {
  id: string;
  status: "idle" | "thinking" | "working" | "waiting_user";
  entries: ChatEntry[];
  model: string;
  /** Soma da conversa inteira. */
  usage: Usage;
  costUsd: number;
  /** Só do último pedido. */
  lastRequest?: { usage: Usage; costUsd: number; modelCalls: number };
}

export interface ConversationOptions {
  /** Provedor configurado agora (undefined quando falta a chave). */
  provider(): LlmProvider | undefined;
  settings(): ConversationSettings;
  dispatcher: Dispatcher;
  agent: AgentRunner;
  snapshot(): WorkspaceSnapshot;
  onChange?: (view: ConversationView) => void;
  limits?: Partial<TurnLimits>;
  now?: () => Date;
  newId?: () => string;
}

export class ConversationBusyError extends Error {}
