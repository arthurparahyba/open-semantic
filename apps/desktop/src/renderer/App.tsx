import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkspaceSnapshot } from "@open-semantic/protocol";

import type { PersistState } from "../shared/api.js";
import { Canvas, type CanvasHandle, type ModRenderProps } from "./Canvas.js";
import { OperationFailed, api, newId, runOk } from "./client.js";
import { ModFrame } from "./ModFrame.js";
import { Editor } from "./mods/Editor.js";
import { Explorer } from "./mods/Explorer.js";

interface Toast {
  id: number;
  message: string;
}

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [persist, setPersist] = useState<PersistState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [pendingFrame, setPendingFrame] = useState<{ ids: string[]; intent: "focus" | "compare" } | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  const toastSeq = useRef(0);

  const refresh = useCallback(async () => setSnapshot(await api().snapshot()), []);

  useEffect(() => {
    void refresh();
    const offRevision = api().onRevision(() => void refresh());
    const offPersist = api().onPersist(setPersist);
    return () => {
      offRevision();
      offPersist();
    };
  }, [refresh]);

  // Enquadra objetos recém-criados assim que aparecem no snapshot.
  useEffect(() => {
    if (!pendingFrame || !snapshot) return;
    const present = pendingFrame.ids.every((id) => snapshot.canvas.objects.some((o) => o.id === id));
    if (!present) return;
    const { ids, intent } = pendingFrame;
    setPendingFrame(null);
    requestAnimationFrame(() => canvas.current?.frame(ids, intent));
  }, [pendingFrame, snapshot]);

  const notify = useCallback((message: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const fail = (err: unknown) => notify(err instanceof OperationFailed ? err.message : String(err));

  const openFolder = async () => {
    try {
      const picked = await api().pickFolder();
      if (!picked || !snapshot) return;
      const existing = snapshot.projects.find((p) => p.location.kind === "local" && p.location.rootPath === picked.path);
      let rootArtifactId: string;
      if (existing) rootArtifactId = existing.rootRef;
      else {
        const out = await runOk<{ rootArtifactId: string }>("workspace.add_project", {
          projectId: newId("prj"),
          name: picked.name,
          rootPath: picked.path,
        });
        rootArtifactId = out.rootArtifactId;
      }
      const explorer = snapshot.mods.find((m) => m.type === "explorer" && m.config.rootRef === rootArtifactId);
      if (explorer) {
        if (explorer.lifecycle === "closed") await runOk("mod.reopen", { modId: explorer.id });
        setPendingFrame({ ids: [explorer.id], intent: "focus" });
        return;
      }
      const modId = newId("mod");
      await runOk("mod.create", { modId, type: "explorer", title: picked.name, config: { rootRef: rootArtifactId } });
      setPendingFrame({ ids: [modId], intent: "focus" });
    } catch (err) {
      fail(err);
    }
  };

  const openFile = async (explorerId: string, fileRef: string) => {
    if (!snapshot) return;
    try {
      const existing = snapshot.mods.find((m) => m.type === "editor" && m.config.fileRef === fileRef);
      if (existing) {
        if (existing.lifecycle === "closed") await runOk("mod.reopen", { modId: existing.id });
        setPendingFrame({ ids: [existing.id], intent: "focus" });
        return;
      }
      const modId = newId("mod");
      await runOk("mod.create", { modId, type: "editor", config: { fileRef }, placement: { anchorIds: [explorerId] } });
      setPendingFrame({ ids: [explorerId, modId], intent: "compare" });
    } catch (err) {
      fail(err);
    }
  };

  const setModDirty = (modId: string, value: boolean) =>
    setDirty((d) => {
      if (d.has(modId) === value) return d;
      const next = new Set(d);
      if (value) next.add(modId);
      else next.delete(modId);
      return next;
    });

  const renderMod = (props: ModRenderProps) => {
    const { mod } = props;
    const common = { ...props, onFocus: () => canvas.current?.frame([mod.id]), onError: notify };
    if (mod.type === "explorer") {
      return (
        <ModFrame {...common} icon="🗂">
          <Explorer mod={mod} onOpenFile={(fileRef) => void openFile(mod.id, fileRef)} onError={notify} />
        </ModFrame>
      );
    }
    if (mod.type === "editor") {
      const artifact = snapshot?.artifacts.find((a) => a.id === mod.config.fileRef);
      return (
        <ModFrame {...common} icon="✎" badge={dirty.has(mod.id) ? <span className="mod-dirty" title="Alterações não salvas">●</span> : null}>
          <Editor mod={mod} artifact={artifact} onDirtyChange={(v) => setModDirty(mod.id, v)} onError={notify} />
        </ModFrame>
      );
    }
    return (
      <ModFrame {...common} icon="?">
        <p className="tree-note">Tipo de mod ainda não suportado: {mod.type}</p>
      </ModFrame>
    );
  };

  if (!snapshot) return <div className="splash">Abrindo workspace…</div>;
  const empty = snapshot.mods.length === 0;

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">Open Semantic</strong>
        <span className="workspace-name">{snapshot.workspace.name}</span>
        <button type="button" className="primary" onClick={() => void openFolder()}>
          Abrir pasta…
        </button>
        <span className="spacer" />
        <button type="button" onClick={() => canvas.current?.zoomBy(1 / 1.2)} aria-label="Diminuir zoom">
          −
        </button>
        <span className="zoom" data-testid="zoom">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" onClick={() => canvas.current?.zoomBy(1.2)} aria-label="Aumentar zoom">
          +
        </button>
        <button type="button" onClick={() => canvas.current?.frame([], "overview")} disabled={empty}>
          Ver tudo
        </button>
        <PersistIndicator state={persist} />
      </header>

      <main className="stage">
        <Canvas snapshot={snapshot} handle={canvas} renderMod={renderMod} onZoomChange={setZoom} />
        {empty && (
          <div className="empty">
            <h1>Comece abrindo uma pasta</h1>
            <p>O Explorer aparece no canvas. Clique num arquivo para abri-lo no Editor ao lado. Tudo continua no lugar quando você reabrir o app.</p>
            <button type="button" className="primary" onClick={() => void openFolder()}>
              Abrir pasta…
            </button>
          </div>
        )}
        <footer className="hint">Arraste o fundo para mover · Ctrl/⌘ + roda para zoom · duplo clique no título para enquadrar</footer>
      </main>

      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function PersistIndicator({ state }: { state: PersistState | null }) {
  if (!state || state.state === "saved") return <span className="persist" data-testid="persist">Salvo</span>;
  if (state.state === "pending") return <span className="persist is-pending" data-testid="persist">Salvando…</span>;
  return (
    <span className="persist is-error" data-testid="persist" title={state.message}>
      Erro ao salvar
    </span>
  );
}
