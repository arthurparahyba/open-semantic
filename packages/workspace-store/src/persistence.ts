import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { contractValidator, describeErrors, type WorkspaceSnapshot } from "@open-semantic/protocol";

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
