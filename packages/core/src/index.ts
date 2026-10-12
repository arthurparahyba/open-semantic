// Composição dos módulos do M1 num único processo (o processo principal do Electron).
// A V0.1 permite que as responsabilidades vivam no mesmo processo desde que as interfaces fiquem claras:
// aqui elas só se falam pelo Dispatcher e por eventos.
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { modHandlers } from "@open-semantic/mod-runtime";
import { ProjectRuntime, artifactUnchanged, projectHandlers } from "@open-semantic/project-runtime";
import {
  Dispatcher,
  type ActionLog,
  type ActionRecord,
  type AuthorizationPolicy,
  type DomainEvent,
} from "@open-semantic/protocol";
import {
  FileWorkspacePersistence,
  WorkspaceStore,
  autosave,
  workspaceHandlers,
  workspacePreconditions,
  type PersistStatus,
} from "@open-semantic/workspace-store";

export const DEFAULT_WORKSPACE_ID = "ws_default";

export interface CoreOptions {
  /** Pasta de dados do app (no Electron, app.getPath("userData")). */
  dataDir: string;
  workspaceId?: string;
  workspaceName?: string;
  debounceMs?: number;
  onEvent?: (event: DomainEvent) => void;
  onPersist?: (status: PersistStatus) => void;
  onRevision?: (revision: number) => void;
}

/**
 * Política de autorização do M1. O usuário age livremente pela interface; pedidos do agente
 * que excluem ou escrevem exigem confirmação (docs/funcionalidades/06, tabela de autorização).
 */
export function defaultPolicy(store: WorkspaceStore): AuthorizationPolicy {
  return (request) => {
    if (request.authorization.actor.kind === "user") return { decision: "allow" };
    switch (request.operation) {
      case "mod.delete":
        return store.read().workspace.settings.agentMayDeleteMods
          ? { decision: "allow" }
          : { decision: "confirm", risk: "medium", summary: "Remover um mod do canvas (os arquivos não são apagados).", reversible: false };
      case "project.write_file":
        return { decision: "confirm", risk: "high", summary: "Gravar alterações em um arquivo do projeto.", reversible: false };
      default:
        return { decision: "allow" };
    }
  };
}

/** Histórico persistente: uma linha JSON por ActionRecord. */
export class JsonlActionLog implements ActionLog {
  private chain: Promise<void> = Promise.resolve();
  readonly records: ActionRecord[] = [];
  constructor(private readonly file: string) {}
  append(record: ActionRecord) {
    this.records.push(record);
    this.chain = this.chain.then(() => appendFile(this.file, JSON.stringify(record) + "\n", "utf8")).catch(() => {});
  }
  flush() {
    return this.chain;
  }
}

export async function createCore(options: CoreOptions) {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspacesDir = join(options.dataDir, "workspaces");
  const historyDir = join(options.dataDir, "history");
  await mkdir(historyDir, { recursive: true });

  const persistence = new FileWorkspacePersistence(workspacesDir);
  const loaded = await persistence.load(workspaceId);
  const store = loaded
    ? new WorkspaceStore(loaded)
    : WorkspaceStore.create({ id: workspaceId, name: options.workspaceName ?? "Meu workspace" });
  if (!loaded) await persistence.save(store.snapshot());

  const runtime = new ProjectRuntime(store);
  const log = new JsonlActionLog(join(historyDir, `${workspaceId}.jsonl`));
  const dispatcher = new Dispatcher({
    actionLog: log,
    policy: defaultPolicy(store),
    evaluatePrecondition: workspacePreconditions(store, artifactUnchanged(runtime)),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  const isDirectory = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
  for (const handler of [...workspaceHandlers({ store, isDirectory }), ...projectHandlers(runtime), ...modHandlers({ store })]) {
    dispatcher.register(handler);
  }

  const saver = autosave(store, persistence, {
    debounceMs: options.debounceMs ?? 300,
    ...(options.onPersist ? { onStatus: options.onPersist } : {}),
  });
  if (options.onRevision) store.onChange(options.onRevision);

  // Ao abrir, revalida as referências a arquivos: algo pode ter mudado com o app fechado (C4).
  const revalidated = Promise.all(store.read().artifacts.map((a) => runtime.stat(a.id).catch(() => undefined)));

  return {
    store,
    runtime,
    dispatcher,
    log,
    revalidated,
    /** Grava tudo que estiver pendente. Chamar antes de sair. */
    async close() {
      await saver.flush();
      saver.stop();
      await log.flush();
    },
  };
}

export type Core = Awaited<ReturnType<typeof createCore>>;
