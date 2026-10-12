import type { AgentActivity, ChatEntry, ConversationView, ScriptInfo } from "@open-semantic/core";
import type { DomainEvent, OperationResult, WorkspaceSnapshot } from "@open-semantic/protocol";

export type { AgentActivity, ChatEntry, ConversationView, ScriptInfo };

/** O que a interface sabe das configurações do agente de IA. A chave em si nunca chega aqui. */
export interface AgentSettingsView {
  provider: string;
  providerLabel: string;
  models: { id: string; label: string; note: string; inputPerMTok: number; outputPerMTok: number }[];
  model: string;
  maxCostPerRequestUsd: number;
  key: {
    configured: boolean;
    /** saved: cifrada no cofre do sistema; memory: só até fechar o app; env: variável ANTHROPIC_API_KEY; test: provedor roteirizado. */
    source: "saved" | "memory" | "env" | "test" | "none";
    /** Últimos 4 caracteres, para o usuário reconhecer a chave. */
    hint?: string;
  };
  encryptionAvailable: boolean;
}

export type Outcome = { ok: true } | { ok: false; message: string };

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

/** Pasta do workspace aberta agora. */
export interface WorkspaceInfo {
  path: string;
  name: string;
}

/** API exposta pelo preload em window.openSemantic. É o único canal entre interface e núcleo. */
export interface OpenSemanticApi {
  /** Workspace aberto, ou null se o usuário ainda não escolheu a pasta (primeira abertura). */
  workspaceInfo(): Promise<WorkspaceInfo | null>;
  /** Pasta sugerida para o primeiro workspace (~/Open Semantic). */
  defaultWorkspacePath(): Promise<string>;
  /** Abre (ou cria) o workspace: na pasta sugerida ou escolhida num diálogo. A janela recarrega em seguida. */
  chooseWorkspace(where: "default" | "pick"): Promise<Outcome | null>;
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

  /** Conversa com o agente de IA (M2). */
  agentSettings(): Promise<AgentSettingsView>;
  saveAgentSettings(patch: { model?: string; maxCostPerRequestUsd?: number }): Promise<AgentSettingsView>;
  /** Envia a chave para o processo principal, que a cifra e guarda. null apaga. */
  setApiKey(key: string | null): Promise<{ ok: true; view: AgentSettingsView } | { ok: false; message: string }>;
  conversation(): Promise<ConversationView>;
  onConversation(listener: (view: ConversationView) => void): () => void;
  sendChat(text: string): Promise<Outcome>;
  stopChat(): Promise<void>;
  resetChat(): Promise<Outcome>;
}

export const CHANNELS = {
  workspaceInfo: "os:workspace-info",
  workspaceDefault: "os:workspace-default",
  workspaceChoose: "os:workspace-choose",
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
  agentSettings: "os:agent-settings",
  agentSettingsSave: "os:agent-settings-save",
  agentKey: "os:agent-key",
  chat: "os:chat",
  chatChanged: "os:chat-changed",
  chatSend: "os:chat-send",
  chatStop: "os:chat-stop",
  chatReset: "os:chat-reset",
} as const;
