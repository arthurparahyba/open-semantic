// O workspace na interface: lido inteiro uma vez e, daí em diante, atualizado só com os commits do núcleo.
import { useEffect, useState } from "react";

import type { WorkspaceSnapshot } from "@open-semantic/protocol";
import { applyCommit } from "@open-semantic/workspace-store/commits";

import { api } from "./client.js";

/**
 * Cópia do workspace que acompanha o núcleo pelos commits, sem reler o resto a cada mudança.
 * Commits que a leitura inicial já inclui são ignorados; se um se perder (número pulado), relê tudo.
 */
export function useWorkspace(): WorkspaceSnapshot | null {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  useEffect(() => {
    let sequence = -1; // o último commit que a cópia já tem
    let newest = -1; // o commit mais novo que chegou
    let loading = false;
    let disposed = false;
    const load = async () => {
      loading = true;
      // Se a leitura falhar, o próximo commit encontra a cópia atrasada e tenta de novo.
      const state = await api().workspaceState().finally(() => (loading = false));
      if (disposed || !state) return;
      sequence = state.sequence;
      setSnapshot(state.snapshot);
      // Um commit mais novo chegou enquanto a leitura acontecia e ficou de fora: lê de novo.
      if (newest > sequence) void load();
    };
    const off = api().onCommit((commit) => {
      newest = Math.max(newest, commit.sequence);
      if (loading || commit.sequence <= sequence) return;
      if (commit.sequence !== sequence + 1) return void load();
      sequence = commit.sequence;
      setSnapshot((current) => (current ? applyCommit(current, commit) : current));
    });
    void load();
    return () => {
      disposed = true;
      off();
    };
  }, []);
  return snapshot;
}
