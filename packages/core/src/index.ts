// Composição dos módulos do M1 num único processo (o processo principal do Electron).
// A V0.1 permite que as responsabilidades vivam no mesmo processo desde que as interfaces fiquem claras:
// aqui elas só se falam pelo Dispatcher e por eventos.
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { diagramHandlers } from "@open-semantic/diagram-engine";
import { modHandlers } from "@open-semantic/mod-runtime";
import type { Viewport } from "@open-semantic/navigator";
import { navigationHandlers } from "@open-semantic/navigator/handlers";
import { ProjectRuntime, artifactUnchanged, projectHandlers } from "@open-semantic/project-runtime";
import {
  BatchExecutor,
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
import { semanticHandlers } from "@open-semantic/semantic";

import { AgentRunner, type AgentActivity } from "./agent.js";

export { AgentRunner, describeStep, summarizeBatch, type ActivityStep, type AgentActivity } from "./agent.js";
export {
  AGENT_OPERATIONS,
  CLAUDE_AGENT,
  Conversation,
  ConversationBusyError,
  DEFAULT_LIMITS,
  activeProject,
  compactHistory,
  summarizeWorkspace,
  type ChatEntry,
  type ConversationSettings,
  type ConversationView,
  type TurnLimits,
} from "./conversation.js";
export { SYSTEM_PROMPT } from "./prompt.js";
export { AGENT, SCRIPTS, ScriptError, scriptedPlan, type ScriptInfo } from "./scripts.js";

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
  onActivity?: (activity: AgentActivity) => void;
  /** Duração da animação de navegação no núcleo (testes usam 0). */
  animationMs?: number;
}

/**
 * Política de autorização. O usuário age livremente pela interface; pedidos do agente
 * que excluem ou escrevem conteúdo exigem confirmação (docs/funcionalidades/06, tabela de autorização).
 */
export function defaultPolicy(store: WorkspaceStore): AuthorizationPolicy {
  return (request) => {
    if (request.authorization.actor.kind === "user") return { decision: "allow" };
    switch (request.operation) {
      case "mod.delete":
        return store.read().workspace.settings.agentMayDeleteMods
          ? { decision: "allow" }
          : { decision: "confirm", risk: "medium", summary: "Remover um mod do canvas (os arquivos não são apagados).", reversible: false };
      case "diagram.delete":
        return { decision: "confirm", risk: "medium", summary: "Excluir um diagrama do canvas.", reversible: false };
      case "region.delete": {
        const regionId = (request.arguments as { regionId?: string }).regionId;
        const occupied = store.read().canvas.objects.some((o) => o.regionId === regionId);
        return occupied
          ? { decision: "confirm", risk: "low", summary: "Remover a moldura de uma região que tem objetos (os objetos ficam).", reversible: true }
          : { decision: "allow" };
      }
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

  // Tamanho da área do canvas na tela, informado pela interface; o Navigator precisa dele para enquadrar.
  let viewport: Viewport = { width: 1400, height: 860 };
  const isDirectory = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
  for (const handler of [
    ...workspaceHandlers({ store, isDirectory }),
    ...projectHandlers(runtime),
    ...modHandlers({ store }),
    ...semanticHandlers({ store }),
    ...diagramHandlers({ store }),
    ...navigationHandlers({
      store,
      viewport: () => viewport,
      ...(options.animationMs !== undefined ? { animationMs: options.animationMs } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    }),
  ]) {
    dispatcher.register(handler);
  }

  const batches = new BatchExecutor({ dispatcher, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
  const agent = new AgentRunner({
    executor: batches,
    snapshot: () => store.snapshot(),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });

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
    batches,
    agent,
    log,
    revalidated,
    setViewport(next: Viewport) {
      if (next.width > 0 && next.height > 0) viewport = next;
    },
    /** Grava tudo que estiver pendente. Chamar antes de sair. */
    async close() {
      await saver.flush();
      saver.stop();
      await log.flush();
    },
  };
}

export type Core = Awaited<ReturnType<typeof createCore>>;
