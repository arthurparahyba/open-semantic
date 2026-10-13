// Composição dos módulos do M1 num único processo (o processo principal do Electron).
// A V0.1 permite que as responsabilidades vivam no mesmo processo desde que as interfaces fiquem claras:
// aqui elas só se falam pelo Dispatcher e por eventos.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { diagramHandlers } from "@open-semantic/diagram-engine";
import { modHandlers } from "@open-semantic/mod-runtime";
import type { Viewport } from "@open-semantic/navigator";
import { navigationHandlers } from "@open-semantic/navigator/handlers";
import { ProjectRuntime, artifactUnchanged, projectHandlers } from "@open-semantic/project-runtime";
import {
  BatchExecutor,
  Dispatcher,
  catalogPolicy,
  currentOperationId,
  type ActionLog,
  type ActionRecord,
  type DomainEvent,
} from "@open-semantic/protocol";
import {
  REPO_DIR,
  WorkspaceFolderPersistence,
  WorkspaceStore,
  autosave,
  commitEvents,
  keepNewDiagramsInActiveLayer,
  layerHandlers,
  workspaceHandlers,
  workspacePreconditions,
  type Commit,
  type PersistStatus,
} from "@open-semantic/workspace-store";
import { semanticHandlers } from "@open-semantic/semantic";

import { AgentRunner, type AgentActivity } from "./agent.js";

export { AgentRunner, summarizeBatch, type ActivityStep, type AgentActivity } from "./agent.js";
export {
  CLAUDE_AGENT,
  Conversation,
  ConversationBusyError,
  DEFAULT_LIMITS,
  VISUAL_NUDGE,
  asksForExplanation,
  kindHint,
  suggestDiagramKind,
  cleanPath,
  compactHistory,
  planShowDiagram,
  slug,
  summarizeWorkspace,
  workspaceHeader,
  type ChatEntry,
  type ConversationSettings,
  type ConversationView,
  type ShowDiagramInput,
  type TurnLimits,
} from "./conversation/index.js";
export { WorkspaceContext, canvasAttention, workspaceIndex } from "./context.js";
export { systemPrompt } from "./prompt.js";
export { AGENT, SCRIPTS, ScriptError, scriptedPlan, type ScriptInfo } from "./scripts.js";

export const DEFAULT_WORKSPACE_ID = "ws_default";

export interface CoreOptions {
  /**
   * Pasta do workspace, escolhida pelo usuário. O próprio workspace fica em `<pasta>/.open-semantic/`;
   * repositórios clonados vão para `<pasta>/repos/`.
   */
  workspaceDir: string;
  /** Clona um repositório (padrão: `git clone`). Os testes trocam por um clone local. */
  cloneRepository?: (url: string, targetDir: string) => Promise<void>;
  /** Pasta que `~` representa nos caminhos que o agente recebe do usuário. */
  homeDir?: string;
  workspaceId?: string;
  workspaceName?: string;
  debounceMs?: number;
  onEvent?: (event: DomainEvent) => void;
  onPersist?: (status: PersistStatus) => void;
  /** Cada commit do store, na ordem: a interface aplica as mudanças na cópia dela do workspace. */
  onCommit?: (commit: Commit) => void;
  onActivity?: (activity: AgentActivity) => void;
  /** Duração da animação de navegação no núcleo (testes usam 0). */
  animationMs?: number;
}

/** Histórico persistente: uma linha JSON por ActionRecord. Na memória ficam só os registros mais recentes. */
export class JsonlActionLog implements ActionLog {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  readonly records: ActionRecord[] = [];
  constructor(
    private readonly file: string,
    private readonly options: { limit?: number; onError?: (err: unknown) => void } = {},
  ) {}
  append(record: ActionRecord) {
    this.records.push(record);
    const excess = this.records.length - (this.options.limit ?? 1_000);
    if (excess > 0) this.records.splice(0, excess);
    if (this.closed) return;
    this.chain = this.chain
      .then(() => appendFile(this.file, JSON.stringify(record) + "\n", "utf8"))
      .catch((err: unknown) => this.options.onError?.(err));
  }
  flush() {
    return this.chain;
  }
  /** Para de gravar no disco (o workspace foi fechado); o que já estava na fila termina. */
  close() {
    this.closed = true;
    return this.chain;
  }
}

/**
 * Eventos de domínio de cada commit do store, com a operação que o causou, e o `workspace.opened` de quando abre.
 * Os eventos da navegação, das operações e dos lotes saem do Navigator, do Dispatcher e do executor de lotes.
 */
function publishDomainEvents(store: WorkspaceStore, onEvent: (event: DomainEvent) => void) {
  const newId = () => `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const now = () => new Date();
  store.onCommit((commit) => {
    const operationId = currentOperationId();
    for (const event of commitEvents(commit, { workspaceId: store.id, newId, now, ...(operationId ? { operationId } : {}) })) onEvent(event);
  });
  const projects = store.read().projects.length;
  onEvent({ eventId: newId(), type: "workspace.opened", source: "workspace_store", subjectId: store.id, workspaceRevision: store.revision, payload: { projects }, at: now().toISOString() });
}

/** `git clone` sem perguntar credenciais no terminal (o app não tem terminal para responder). */
export async function gitClone(url: string, targetDir: string) {
  await mkdir(dirname(targetDir), { recursive: true });
  await promisify(execFile)("git", ["clone", "--", url, targetDir], {
    timeout: 10 * 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export async function createCore(options: CoreOptions) {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspaceDir = options.workspaceDir;
  const metaDir = join(workspaceDir, REPO_DIR);
  await mkdir(metaDir, { recursive: true });

  const persistence = new WorkspaceFolderPersistence(workspaceDir);
  const loaded = await persistence.load();
  const store = loaded
    ? new WorkspaceStore(loaded)
    : WorkspaceStore.create({ id: workspaceId, name: options.workspaceName ?? basename(workspaceDir) });
  if (!loaded) await persistence.save(store.snapshot());

  const runtime = new ProjectRuntime(store);
  const log = new JsonlActionLog(join(metaDir, "history.jsonl"), {
    // A interface mostra no mesmo indicador do salvamento: disco cheio também impede salvar o workspace.
    onError: (err) =>
      options.onPersist?.({
        state: "error",
        revision: store.revision,
        message: `O histórico de ações não foi gravado: ${err instanceof Error ? err.message : String(err)}`,
      }),
  });
  const dispatcher = new Dispatcher({
    actionLog: log,
    // Quem pode o quê sai do catálogo: cada handler diz se só consulta, quem chama e se o agente usa (com ou sem confirmação).
    policy: catalogPolicy,
    evaluatePrecondition: workspacePreconditions(store, artifactUnchanged(runtime)),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  // Tamanho da área do canvas na tela, informado pela interface; o Navigator precisa dele para enquadrar.
  let viewport: Viewport = { width: 1400, height: 860 };
  const isDirectory = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
  for (const handler of [
    ...workspaceHandlers({
      store,
      isDirectory,
      importRepo: (projectId) => persistence.importProject(store, projectId),
      reposDir: join(workspaceDir, "repos"),
      cloneRepository: options.cloneRepository ?? gitClone,
      homeDir: options.homeDir ?? homedir(),
    }),
    ...projectHandlers(runtime),
    ...layerHandlers({ store }),
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
    describe: (operation, args) => dispatcher.describe(operation, args),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });

  const saver = autosave(store, persistence, {
    debounceMs: options.debounceMs ?? 300,
    ...(options.onPersist ? { onStatus: options.onPersist } : {}),
  });
  keepNewDiagramsInActiveLayer(store);
  if (options.onCommit) store.onCommit(options.onCommit);
  if (options.onEvent) publishDomainEvents(store, options.onEvent);

  // Ao abrir, revalida as referências a arquivos: algo pode ter mudado com o app fechado (C4).
  const revalidated = Promise.all(store.read().artifacts.map((a) => runtime.stat(a.id).catch(() => undefined)));

  return {
    workspaceDir,
    /** Arquivos `.open-semantic/` que não puderam ser lidos ao abrir (para avisar o usuário). */
    problems: persistence.problems,
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
    /** Espera as gravações pendentes (workspace e `.open-semantic/` dos repositórios). */
    flush: () => saver.flush(),
    /** Grava tudo que estiver pendente. Chamar antes de sair. */
    async close() {
      await revalidated;
      await saver.flush();
      saver.stop();
      await log.close();
    },
  };
}

export type Core = Awaited<ReturnType<typeof createCore>>;
