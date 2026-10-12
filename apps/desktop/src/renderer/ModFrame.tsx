import type { ReactNode } from "react";

import type { CanvasObject, ModInstance } from "@open-semantic/protocol";

import { run } from "./client.js";

interface Props {
  mod: ModInstance;
  object: CanvasObject;
  highlighted?: boolean;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onResizePointerDown(event: React.PointerEvent): void;
  icon: string;
  badge?: ReactNode;
  onFocus(): void;
  onError(message: string): void;
  children: ReactNode;
}

/** Moldura comum: cabeçalho arrastável, recolher/abrir (close/reopen), enquadrar, remover e redimensionar. */
export function ModFrame({ mod, object, highlighted, icon, badge, onHeaderPointerDown, onResizePointerDown, onFocus, onError, children }: Props) {
  const closed = mod.lifecycle === "closed";
  const act = async (operation: string) => {
    const result = await run(operation, { modId: mod.id });
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível concluir.");
  };
  const remove = () => {
    if (window.confirm(`Remover “${mod.title}” do canvas? Os arquivos não são apagados.`)) void act("mod.delete");
  };

  return (
    <section className={`mod mod-${mod.type}${closed ? " is-closed" : ""}${highlighted ? " is-highlighted" : ""}`} data-mod-id={mod.id} data-testid={`mod-${mod.type}`}>
      <header className="mod-header" onPointerDown={onHeaderPointerDown} onDoubleClick={onFocus} title="Arraste para mover · duplo clique para enquadrar">
        <span className="mod-icon" aria-hidden>
          {icon}
        </span>
        <span className="mod-title">{mod.title}</span>
        {badge}
        <span className="mod-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={onFocus} title="Enquadrar" aria-label="Enquadrar">
            ⤢
          </button>
          <button
            type="button"
            onClick={() => void act(closed ? "mod.reopen" : "mod.close")}
            title={closed ? "Abrir" : "Fechar (continua no canvas)"}
            aria-label={closed ? "Abrir" : "Fechar"}
          >
            {closed ? "▸" : "▾"}
          </button>
          <button type="button" onClick={remove} title="Remover do canvas" aria-label="Remover">
            ×
          </button>
        </span>
      </header>
      {!closed && (
        <>
          <div className="mod-body">{children}</div>
          <div className="mod-resize" onPointerDown={onResizePointerDown} aria-hidden />
        </>
      )}
      {object.placedBy === "agent" && <span className="mod-origin">criado pelo agente</span>}
    </section>
  );
}
