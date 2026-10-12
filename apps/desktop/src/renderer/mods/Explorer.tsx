import { useCallback, useEffect, useState } from "react";

import type { ModInstance } from "@open-semantic/protocol";

import { run, runOk } from "../client.js";

interface Entry {
  artifactId: string;
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface Props {
  mod: ModInstance;
  onOpenFile(artifactId: string): void;
  onError(message: string): void;
}

/** Explorer: árvore real de arquivos da raiz autorizada. Pastas expandidas ficam no uiState (persistem). */
export function Explorer({ mod, onOpenFile, onError }: Props) {
  const rootRef = mod.config.rootRef as string;
  const ui = (mod.uiState ?? {}) as { expanded?: string[]; selected?: string[] };
  const expanded = new Set(ui.expanded ?? []);
  const selected = ui.selected?.[0];
  const [children, setChildren] = useState<Record<string, Entry[] | "loading" | { error: string }>>({});

  const load = useCallback(async (artifactId: string) => {
    setChildren((c) => ({ ...c, [artifactId]: "loading" }));
    try {
      const { entries } = await runOk<{ entries: Entry[] }>("project.list_dir", { artifactId });
      setChildren((c) => ({ ...c, [artifactId]: entries }));
    } catch (err) {
      setChildren((c) => ({ ...c, [artifactId]: { error: (err as Error).message } }));
    }
  }, []);

  useEffect(() => {
    void load(rootRef);
    for (const id of ui.expanded ?? []) if (id !== rootRef) void load(id);
    // Recarrega só quando a raiz muda; pastas novas carregam ao expandir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef, load]);

  const saveUi = async (patch: { expanded?: string[]; selected?: string[] }) => {
    const result = await run("mod.configure", { modId: mod.id, uiState: patch });
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível salvar o estado do Explorer.");
  };

  const toggle = (entry: Entry) => {
    const next = new Set(expanded);
    if (next.has(entry.artifactId)) next.delete(entry.artifactId);
    else {
      next.add(entry.artifactId);
      if (!Array.isArray(children[entry.artifactId])) void load(entry.artifactId);
    }
    void saveUi({ expanded: [...next], selected: [entry.artifactId] });
  };

  const open = (entry: Entry) => {
    void saveUi({ selected: [entry.artifactId] });
    onOpenFile(entry.artifactId);
  };

  const renderLevel = (dirId: string, depth: number) => {
    const list = children[dirId];
    if (list === undefined || list === "loading") return <div className="tree-note" style={{ paddingLeft: 12 + depth * 14 }}>carregando…</div>;
    if (!Array.isArray(list)) return <div className="tree-note is-error" style={{ paddingLeft: 12 + depth * 14 }}>{list.error}</div>;
    if (list.length === 0) return <div className="tree-note" style={{ paddingLeft: 12 + depth * 14 }}>vazio</div>;
    return list.map((entry) => {
      const isOpen = expanded.has(entry.artifactId);
      return (
        <div key={entry.artifactId}>
          <button
            type="button"
            className={`tree-row${selected === entry.artifactId ? " is-selected" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (entry.kind === "directory" ? toggle(entry) : open(entry))}
            title={entry.path}
            data-path={entry.path}
          >
            <span className="tree-caret" aria-hidden>
              {entry.kind === "directory" ? (isOpen ? "▾" : "▸") : ""}
            </span>
            <span className="tree-icon" aria-hidden>
              {entry.kind === "directory" ? "📁" : "📄"}
            </span>
            <span className="tree-name">{entry.name}</span>
          </button>
          {entry.kind === "directory" && isOpen && renderLevel(entry.artifactId, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="explorer" role="tree">
      <div className="explorer-toolbar">
        <button type="button" onClick={() => void load(rootRef)} title="Atualizar">
          ↻ Atualizar
        </button>
      </div>
      {renderLevel(rootRef, 0)}
    </div>
  );
}
