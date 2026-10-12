import type { DomainEvent, OperationResult, WorkspaceSnapshot } from "@open-semantic/protocol";

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
}

export const CHANNELS = {
  dispatch: "os:dispatch",
  snapshot: "os:snapshot",
  pickFolder: "os:pick-folder",
  revision: "os:revision",
  persist: "os:persist",
  event: "os:event",
} as const;
