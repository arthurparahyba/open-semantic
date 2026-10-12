import type { AgentActivity, ScriptInfo } from "@open-semantic/core";
import type { DomainEvent, OperationResult, WorkspaceSnapshot } from "@open-semantic/protocol";

export type { AgentActivity, ScriptInfo };

export type PersistState =
  | { state: "saved"; revision: number }
  | { state: "pending"; revision: number }
  | { state: "error"; revision: number; message: string };

/** Requisição que a interface envia. O processo principal sempre assina como o usuário local. */
export interface UiOperationRequest {
  operationId: string;
  operation: string;
  arguments: Record<string, unknown>;
  preconditions?: unknown[];
  targetId?: string;
}

/** API exposta pelo preload em window.openSemantic. É o único canal entre interface e núcleo. */
export interface OpenSemanticApi {
  dispatch(request: UiOperationRequest): Promise<OperationResult>;
  snapshot(): Promise<WorkspaceSnapshot>;
  pickFolder(): Promise<{ path: string; name: string } | null>;
  onRevision(listener: (revision: number) => void): () => void;
  onPersist(listener: (state: PersistState) => void): () => void;
  onEvent(listener: (event: DomainEvent) => void): () => void;
  /** Tamanho da área do canvas, para o Navigator enquadrar no núcleo. */
  setViewport(viewport: { width: number; height: number }): void;
  /** Roteiros do agente roteirizado (M2, antes da IA). */
  agentScripts(): Promise<ScriptInfo[]>;
  /** Pede ao agente roteirizado que execute um roteiro. O pedido é do usuário; quem age é o agente. */
  runAgentScript(scriptId: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Resposta ao cartão de confirmação de um lote do agente. */
  respondToAgent(batchId: string, approve: boolean): Promise<void>;
  agentActivity(): Promise<AgentActivity[]>;
  onAgentActivity(listener: (activity: AgentActivity) => void): () => void;
}

export const CHANNELS = {
  dispatch: "os:dispatch",
  snapshot: "os:snapshot",
  pickFolder: "os:pick-folder",
  revision: "os:revision",
  persist: "os:persist",
  event: "os:event",
  viewport: "os:viewport",
  agentScripts: "os:agent-scripts",
  agentRun: "os:agent-run",
  agentRespond: "os:agent-respond",
  agentActivity: "os:agent-activity",
  agentActivityList: "os:agent-activity-list",
} as const;
