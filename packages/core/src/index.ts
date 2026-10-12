// Composição dos módulos do M1 num único processo (o processo principal do Electron).
// A V0.1 permite que as responsabilidades vivam no mesmo processo desde que as interfaces fiquem claras:
// aqui elas só se falam pelo Dispatcher e por eventos.
import { execFile } from "node:child_process";
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
  type ActionLog,
  type ActionRecord,
  type AuthorizationPolicy,
  type DomainEvent,
} from "@open-semantic/protocol";
import {
  REPO_DIR,
  WorkspaceFolderPersistence,
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
      case "workspace.add_project": {
        const { rootPath, name } = request.arguments as { rootPath?: string; name?: string };
        return {
          decision: "confirm",
          risk: "medium",
          summary: `Adicionar a pasta ${rootPath ?? ""} ao workspace como "${name ?? ""}". Diagramas e conhecimento sobre ela ficam em ${REPO_DIR}/ dentro da pasta.`,
          reversible: true,
        };
      }
      case "workspace.clone_repository": {
        const { url } = request.arguments as { url?: string };
        return {
          decision: "confirm",
          risk: "medium",
          summary: `Baixar ${url ?? "o repositório"} para a pasta repos/ do workspace e trabalhar nele. Diagramas e conhecimento sobre ele ficam em ${REPO_DIR}/ dentro do repositório.`,
          reversible: true,
        };
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
  private closed = false;
  readonly records: ActionRecord[] = [];
  constructor(private readonly file: string) {}
  append(record: ActionRecord) {
    this.records.push(record);
    if (this.closed) return;
    this.chain = this.chain.then(() => appendFile(this.file, JSON.stringify(record) + "\n", "utf8")).catch(() => {});
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
  const log = new JsonlActionLog(join(metaDir, "history.jsonl"));
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
    ...workspaceHandlers({
      store,
      isDirectory,
      importRepo: (projectId) => persistence.importProject(store, projectId),
      reposDir: join(workspaceDir, "repos"),
      cloneRepository: options.cloneRepository ?? gitClone,
      homeDir: options.homeDir ?? homedir(),
    }),
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
