import { useCallback, useEffect, useRef, useState } from "react";

import { childMarks, litObjects } from "@open-semantic/workspace-store/layers";
import { REBALANCE_THRESHOLD, displacement, type Move } from "@open-semantic/workspace-store/layout";
import { activeProject } from "@open-semantic/workspace-store/projects";

import type { PersistState, WorkspaceInfo } from "../shared/api.js";
import { AgentPanel } from "./AgentPanel.js";
import { BlockView } from "./BlockView.js";
import { Canvas, type CanvasHandle, type ObjectRenderProps } from "./Canvas.js";
import { OperationFailed, api, newId, run, runOk } from "./client.js";
import { DiagramView } from "./DiagramView.js";
import { LayersPanel } from "./LayersPanel.js";
import { ModFrame } from "./ModFrame.js";
import { Editor } from "./mods/Editor.js";
import { Explorer } from "./mods/Explorer.js";
import { useWorkspace } from "./useWorkspace.js";

interface Toast {
  id: number;
  message: string;
  action?: { label: string; run(): void };
}

export function App({ workspace }: { workspace: WorkspaceInfo }) {
  const snapshot = useWorkspace();
  const [persist, setPersist] = useState<PersistState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [pendingFrame, setPendingFrame] = useState<{ ids: string[]; intent: "focus" | "compare" } | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const canvas = useRef<CanvasHandle>(null);
  const toastSeq = useRef(0);

  useEffect(() => api().onPersist(setPersist), []);

  // Enquadra objetos recém-criados assim que aparecem no snapshot.
  useEffect(() => {
    if (!pendingFrame || !snapshot) return;
    const present = pendingFrame.ids.every((id) => snapshot.canvas.objects.some((o) => o.id === id));
    if (!present) return;
    const { ids, intent } = pendingFrame;
    setPendingFrame(null);
    requestAnimationFrame(() => canvas.current?.frame(ids, intent));
  }, [pendingFrame, snapshot]);

  const notify = useCallback((message: string, action?: Toast["action"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, message, ...(action ? { action } : {}) }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 10000 : 6000);
  }, []);

  // Camada criada pelo agente: avisa com o desfazer à mão (doc 11, controle do usuário).
  const knownLayers = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const layers = snapshot.layers ?? [];
    const known = knownLayers.current;
    knownLayers.current = new Set(layers.map((l) => l.id));
    if (!known) return;
    for (const layer of layers.filter((l) => !known.has(l.id) && l.origin === "agent")) {
      notify(`Criei a camada “${layer.name}”.`, { label: "Desfazer", run: () => void run("layer.dissolve", { layerId: layer.id }) });
    }
  }, [snapshot, notify]);

  // Entrar numa camada é um zoom até os membros dela que estão no canvas; voltar à base mostra tudo.
  const activeLayerId = snapshot?.navigation.activeLayerId;
  const lastActive = useRef(activeLayerId);
  useEffect(() => {
    if (!snapshot || lastActive.current === activeLayerId) return;
    lastActive.current = activeLayerId;
    const lit = litObjects(snapshot);
    const ids = lit ? snapshot.canvas.objects.filter((o) => lit.has(o.id)).map((o) => o.id) : [];
    if (lit && !ids.length) return;
    requestAnimationFrame(() => canvas.current?.frame(ids, ids.length ? "focus" : "overview"));
  }, [activeLayerId, snapshot]);

  const fail = (err: unknown) => notify(err instanceof OperationFailed ? err.message : String(err));

  // Reorganização (doc 13): depois que diagramas ou blocos entram ou saem, e com o usuário parado, o layout
  // pode reorganizar a explicação; a mudança é animada e tem desfazer. Arrastar ou rolar o canvas adia.
  const lastGesture = useRef(0);
  const rebalancing = useRef(false);
  const rebalance = useCallback(
    async (mode: "auto" | "all") => {
      if (rebalancing.current) return;
      rebalancing.current = true;
      try {
        const all = mode === "all";
        const preview = await runOk<{ moves: Move[] }>("canvas.rebalance", { preview: true, all });
        if (mode === "auto" && displacement(preview.moves) < REBALANCE_THRESHOLD) return;
        if (!preview.moves.length) return notify("O canvas já está organizado.");
        const rects = preview.moves.flatMap((m) => {
          const size = snapshot?.canvas.objects.find((o) => o.id === m.objectId)?.size ?? { width: 1, height: 1 };
          return [{ position: m.from, size }, { position: m.to, size }];
        });
        let applied: Move[] = [];
        await canvas.current?.arrange(rects, async () => {
          applied = (await runOk<{ moves: Move[] }>("canvas.rebalance", { all })).moves;
        });
        if (applied.length) notify("Reorganizei o canvas.", { label: "Desfazer", run: () => void run("canvas.arrange", { moves: applied.map((m) => ({ objectId: m.objectId, position: m.from })) }) });
      } catch (err) {
        fail(err);
      } finally {
        rebalancing.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, notify],
  );
  const explanationKey = snapshot?.canvas.objects.filter((o) => o.objectKind !== "mod").map((o) => o.id).join(",");
  const lastKey = useRef(explanationKey);
  useEffect(() => {
    if (explanationKey === undefined || lastKey.current === explanationKey) return undefined;
    const first = lastKey.current === undefined;
    lastKey.current = explanationKey;
    if (first) return undefined;
    const timer = setTimeout(() => {
      if (Date.now() - lastGesture.current > 3000) void rebalance("auto");
    }, 1800);
    return () => clearTimeout(timer);
  }, [explanationKey, rebalance]);

  const openFolder = async () => {
    try {
      const picked = await api().pickFolder();
      if (!picked || !snapshot) return;
      const existing = snapshot.projects.find((p) => p.location.kind === "local" && p.location.rootPath === picked.path);
      let rootArtifactId: string;
      if (existing) {
        rootArtifactId = existing.rootRef;
        // Reabrir uma pasta que já estava no workspace a torna o projeto em que o agente trabalha.
        await runOk("workspace.set_active_project", { projectId: existing.id });
      } else {
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

  const switchWorkspace = async () => {
    const outcome = await api().chooseWorkspace("pick");
    if (outcome && !outcome.ok) notify(outcome.message);
  };

  const activateProject = (projectId: string) => runOk("workspace.set_active_project", { projectId }).catch(fail);

  const removeProject = async (projectId: string) => {
    const project = snapshot?.projects.find((p) => p.id === projectId);
    if (!project) return;
    const ok = window.confirm(
      `Tirar “${project.name}” do workspace?\n\nSaem os Explorers, Editores, diagramas e o conhecimento ligados a ele. Os arquivos no disco não são tocados; dá para abrir a pasta de novo depois.`,
    );
    if (ok) await runOk("workspace.remove_project", { projectId }).catch(fail);
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

  const renderObject = (props: ObjectRenderProps) => {
    const { object } = props;
    const onFocus = () => canvas.current?.frame([object.id]);
    if (object.objectKind === "block") {
      const block = snapshot?.blocks?.find((b) => b.id === object.id);
      if (!block) return null;
      return <BlockView block={block} highlighted={props.highlighted} onHeaderPointerDown={props.onHeaderPointerDown} onFocus={onFocus} onError={notify} />;
    }
    if (object.objectKind === "diagram") {
      const diagram = snapshot?.diagrams.find((d) => d.id === object.id);
      if (!diagram || !snapshot) return null;
      return <DiagramView {...props} diagram={diagram} snapshot={snapshot} onFocus={onFocus} onError={notify} />;
    }
    const mod = snapshot?.mods.find((m) => m.id === object.id);
    if (!mod) return null;
    const common = {
      mod,
      object,
      highlighted: props.highlighted,
      onHeaderPointerDown: props.onHeaderPointerDown,
      onResizePointerDown: props.onResizePointerDown,
      onFocus,
      onError: notify,
    };
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

  const activateLayer = (layerId: string | undefined) => runOk("layer.activate", layerId ? { layerId } : {}).catch(fail);

  if (!snapshot) return <div className="splash">Abrindo workspace…</div>;
  const empty = snapshot.canvas.objects.length === 0 && snapshot.canvas.regions.length === 0;
  const autoNavigate = snapshot.navigation.control.mode !== "user_locked";
  const toggleAutoNavigate = async () => {
    const result = await run("navigation.set_control", { mode: autoNavigate ? "user_locked" : "shared" });
    if (result.status !== "succeeded") notify(result.error?.message ?? "Não foi possível mudar a navegação automática.");
  };

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">Open Semantic</strong>
        <button
          type="button"
          className="workspace-name"
          onClick={() => void switchWorkspace()}
          title={`Workspace em ${workspace.path}. Clique para abrir outra pasta como workspace.`}
          data-testid="workspace-name"
        >
          {snapshot.workspace.name}
        </button>
        <button type="button" onClick={() => void openFolder()} title="Também dá para pedir ao agente: cole o caminho da pasta ou o link do repositório">
          Abrir pasta…
        </button>
        {snapshot.projects.length > 0 && (
          <span className="projects" data-testid="projects">
            {snapshot.projects.map((p) => {
              const active = p.id === activeProject(snapshot)?.id;
              return (
                <span key={p.id} className={`project-chip${active ? " is-active" : ""}`} data-project-id={p.id} data-active={active}>
                  <button
                    type="button"
                    className="project-name"
                    onClick={() => void activateProject(p.id)}
                    title={active ? "Projeto em que o agente trabalha" : "Fazer o agente trabalhar neste projeto"}
                  >
                    {p.name}
                  </button>
                  <button type="button" className="project-remove" onClick={() => void removeProject(p.id)} aria-label={`Tirar ${p.name} do workspace`} title="Tirar do workspace">
                    ×
                  </button>
                </span>
              );
            })}
          </span>
        )}
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
        <button type="button" onClick={() => void rebalance("all")} disabled={empty} title="Reorganiza as explicações da camada ativa, inclusive o que você arrumou à mão" data-testid="rebalance">
          Reorganizar
        </button>
        <label className="toggle" title="Quando ligada, o agente pode levar a câmera até o que ele mostra">
          <input type="checkbox" checked={autoNavigate} onChange={() => void toggleAutoNavigate()} data-testid="auto-navigate" />
          Navegação automática
        </label>
        <button type="button" onClick={() => setAgentOpen((v) => !v)} aria-pressed={agentOpen} data-testid="history-toggle" title="Abre o histórico completo da conversa">
          Histórico
        </button>
        <PersistIndicator state={persist} />
      </header>

      <div className={`workarea${agentOpen ? " with-panel" : ""}`}>
      <main className="stage">
        <Canvas
          snapshot={snapshot}
          handle={canvas}
          renderObject={renderObject}
          onZoomChange={setZoom}
          litObjectIds={litObjects(snapshot)}
          layerMarks={childMarks(snapshot)}
          onOpenLayer={(id) => void activateLayer(id)}
          onUserGesture={() => (lastGesture.current = Date.now())}
        />
        <LayersPanel
          snapshot={snapshot}
          onActivate={(id) => void activateLayer(id)}
          onRename={(layerId, name) => void runOk("layer.update", { layerId, name }).catch(fail)}
          onDissolve={(layerId) => void runOk("layer.dissolve", { layerId }).catch(fail)}
        />
        {empty && (
          <div className="empty">
            <h1>Comece pela conversa</h1>
            <p>
              Diga ao agente com o que quer trabalhar: o caminho de uma pasta no seu computador ou o link de um repositório do GitHub. Ele traz o
              repositório para o workspace e organiza o canvas. Tudo continua no lugar quando você reabrir o app.
            </p>
            <button type="button" onClick={() => void openFolder()}>
              Ou abra uma pasta…
            </button>
          </div>
        )}
        <footer className="hint">Arraste o fundo para mover · Ctrl/⌘ + roda para zoom · duplo clique no título para enquadrar · Esc interrompe o movimento</footer>
      </main>
      {(
        <AgentPanel
          historyOpen={agentOpen}
          hasProject={snapshot.projects.length > 0}
          diagrams={snapshot.diagrams}
          onShowDiagram={(id) => canvas.current?.frame([id])}
          onError={notify}
        />
      )}
      </div>

      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
            {t.action && (
              <button type="button" className="toast-action" onClick={() => { t.action!.run(); setToasts((all) => all.filter((x) => x.id !== t.id)); }}>
                {t.action.label}
              </button>
            )}
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
