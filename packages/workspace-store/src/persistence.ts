import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { contractValidator, describeErrors, type WorkspaceSnapshot } from "@open-semantic/protocol";

import { REPO_DIR, RepoWriter, mergeRepoContent, readRepoContent, rootPathOfProject, splitSnapshot, statPaths, storesInRepo } from "./repoStore.js";
import type { WorkspaceStore } from "./store.js";

export interface WorkspacePersistence {
  load(workspaceId: string): Promise<WorkspaceSnapshot | undefined>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
}

const validateSnapshot = contractValidator("workspace.schema.json");

/** Um arquivo JSON por workspace, no formato do snapshot. Escrita atômica (arquivo temporário + rename). */
export class FileWorkspacePersistence implements WorkspacePersistence {
  constructor(private readonly dir: string) {}

  private file(id: string) {
    if (!/^ws_[A-Za-z0-9_-]{3,64}$/.test(id)) throw new Error(`id de workspace inválido: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async load(workspaceId: string): Promise<WorkspaceSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.file(workspaceId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const data: unknown = JSON.parse(text);
    if (!validateSnapshot(data)) {
      throw new Error(`workspace ${workspaceId} fora do contrato: ${describeErrors(validateSnapshot.errors)}`);
    }
    return data as WorkspaceSnapshot;
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(snapshot.workspace.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  }
}

/**
 * Workspace numa pasta escolhida pelo usuário. Os arquivos do próprio workspace ficam em `<pasta>/.open-semantic/`;
 * diagramas e conhecimento de cada repositório ficam no `.open-semantic/` do repositório (ver repoStore.ts).
 */
export class WorkspaceFolderPersistence implements WorkspacePersistence {
  readonly writer = new RepoWriter();
  /** Problemas encontrados ao ler os repositórios (arquivo inválido etc.), para avisar o usuário. */
  readonly problems: string[] = [];
  private seq = 0;

  constructor(
    readonly workspaceDir: string,
    private readonly options: { now?: () => Date } = {},
  ) {}

  get file() {
    return join(this.workspaceDir, REPO_DIR, "workspace.json");
  }

  async load(): Promise<WorkspaceSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const doc = JSON.parse(text) as WorkspaceSnapshot;
    for (const project of doc.projects.filter(storesInRepo)) await this.importInto(doc, project);
    // Um diagrama que sumiu do repositório (apagado fora do app) sai também do canvas.
    const diagrams = new Set(doc.diagrams.map((d) => d.id));
    doc.canvas.objects = doc.canvas.objects.filter((o) => o.objectKind !== "diagram" || diagrams.has(o.id));
    if (!validateSnapshot(doc)) {
      throw new Error(`workspace em ${this.workspaceDir} fora do contrato: ${describeErrors(validateSnapshot.errors)}`);
    }
    return doc;
  }

  /** Traz o `.open-semantic/` de um repositório para o documento (ao abrir, ou quando o projeto entra no workspace). */
  async importInto(doc: WorkspaceSnapshot, project: WorkspaceSnapshot["projects"][number]) {
    const rootPath = rootPathOfProject(project);
    if (!rootPath) return;
    const { content, problems } = await readRepoContent(rootPath);
    this.problems.push(...problems.map((p) => `${project.name}: ${p}`));
    const kinds = await statPaths(rootPath, content);
    mergeRepoContent(doc, project, content, kinds, {
      now: this.options.now ?? (() => new Date()),
      newArtifactId: () => `art_${project.id.slice(4)}_r${Date.now().toString(36)}${(this.seq++).toString(36)}`,
    });
    this.writer.remember(rootPath, content);
  }

  /** Igual a importInto, mas sobre o store vivo (projeto que acabou de entrar no workspace). */
  async importProject(store: WorkspaceStore, projectId: string) {
    const project = store.project(projectId);
    const rootPath = project && storesInRepo(project) ? rootPathOfProject(project) : undefined;
    if (!project || !rootPath) return;
    const { content, problems } = await readRepoContent(rootPath);
    this.problems.push(...problems.map((p) => `${project.name}: ${p}`));
    const kinds = await statPaths(rootPath, content);
    store.transact(() =>
      store.mutate((doc) =>
        mergeRepoContent(doc, project, content, kinds, {
          now: this.options.now ?? (() => new Date()),
          newArtifactId: () => `art_${project.id.slice(4)}_r${Date.now().toString(36)}${(this.seq++).toString(36)}`,
        }),
      ),
    );
    this.writer.remember(rootPath, content);
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    const { workspace, repos } = splitSnapshot(snapshot);
    await mkdir(join(this.workspaceDir, REPO_DIR), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(workspace, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
    const failures: string[] = [];
    for (const project of snapshot.projects) {
      const content = repos.get(project.id);
      const rootPath = rootPathOfProject(project);
      if (!content || !rootPath) continue;
      // Pasta que sumiu do disco: não recria nada lá.
      if (!(await stat(rootPath).catch(() => undefined))?.isDirectory()) continue;
      try {
        await this.writer.write(rootPath, content);
      } catch (err) {
        failures.push(`${project.name}: ${(err as Error).message}`);
      }
    }
    if (failures.length) throw new Error(`Não consegui gravar no repositório: ${failures.join("; ")}`);
  }
}

export type PersistStatus = { state: "saved"; revision: number } | { state: "pending"; revision: number } | { state: "error"; revision: number; message: string };

/**
 * Salva o workspace depois de cada mudança, agrupando mudanças próximas.
 * O status permite à interface distinguir salvo, pendente e falhou (V0.1 §4.1).
 */
export function autosave(
  store: WorkspaceStore,
  persistence: WorkspacePersistence,
  options: { debounceMs?: number; onStatus?: (status: PersistStatus) => void } = {},
) {
  const debounceMs = options.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();
  let savedRevision = store.revision;

  const report = (status: PersistStatus) => options.onStatus?.(status);

  const saveNow = () => {
    timer = undefined;
    const snapshot = store.snapshot();
    const revision = snapshot.workspace.revision;
    saving = saving
      .then(() => persistence.save(snapshot))
      .then(
        () => {
          savedRevision = Math.max(savedRevision, revision);
          if (savedRevision === store.revision) report({ state: "saved", revision });
        },
        (err: unknown) => report({ state: "error", revision, message: err instanceof Error ? err.message : String(err) }),
      );
    return saving;
  };

  const unsubscribe = store.onChange((revision) => {
    report({ state: "pending", revision });
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveNow, debounceMs);
  });

  return {
    /** Grava imediatamente o que estiver pendente (usar ao fechar o app). */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        await saveNow();
      } else await saving;
    },
    stop() {
      unsubscribe();
      if (timer) clearTimeout(timer);
    },
  };
}
