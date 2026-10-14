import { useState } from "react";

import { layerTree } from "@open-semantic/workspace-store/layers";
import { handoffPrompt, isSpecLayer, specPath } from "@open-semantic/workspace-store/specs";
import type { Layer, WorkspaceSnapshot } from "@open-semantic/protocol";

interface Props {
  snapshot: WorkspaceSnapshot;
  onActivate(layerId: string | undefined): void;
  onRename(layerId: string, name: string): void;
  onDissolve(layerId: string): void;
}

/**
 * Painel de camadas (docs/funcionalidades/11-camadas.md): o índice do workspace por assunto.
 * Clicar entra na camada; a base é o workspace inteiro. Desfazer tira só o recorte.
 */
export function LayersPanel({ snapshot, onActivate, onRename, onDissolve }: Props) {
  const tree = layerTree(snapshot);
  if (!tree.length) return null;
  const active = snapshot.navigation.activeLayerId;
  const rename = (layerId: string, current: string) => {
    const name = window.prompt("Novo nome da camada", current)?.trim();
    if (name && name !== current) onRename(layerId, name);
  };
  return (
    <nav className="layers" data-testid="layers" aria-label="Camadas">
      <span className="layers-title">Camadas</span>
      <button type="button" className={`layer-row${active ? "" : " is-active"}`} onClick={() => onActivate(undefined)} data-testid="layer-base">
        Workspace
      </button>
      {tree.map(({ layer, depth }) => (
        <span key={layer.id} className={`layer-row${layer.id === active ? " is-active" : ""}`} style={{ paddingLeft: 10 + depth * 14 }} data-layer-id={layer.id}>
          <button
            type="button"
            className="layer-name"
            onClick={() => onActivate(layer.id)}
            onDoubleClick={() => rename(layer.id, layer.name)}
            title={layer.description ?? "Clique para entrar · duplo clique para renomear"}
          >
            {layer.name}
          </button>
          <span className="layer-count">{layer.members.length}</span>
          <button type="button" className="layer-remove" onClick={() => onDissolve(layer.id)} aria-label={`Desfazer a camada ${layer.name}`} title="Desfazer a camada (nada é apagado)">
            ×
          </button>
          {isSpecLayer(layer) && (
            // Segunda linha da camada: o arquivo e o pedido não cabem ao lado do nome sem estourar o painel.
            <span className="layer-spec">
              <span className="layer-spec-file" data-testid="layer-spec-file" title={`O app grava esta camada em ${specPath(layer)}`}>
                {specPath(layer)}
              </span>
              <HandoffButton layer={layer} />
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * A camada de implementação já está em specs/<assunto>.md (doc 16). Um clique copia o pedido para o agente de código
 * que o usuário preferir; o app não implementa.
 */
function HandoffButton({ layer }: { layer: Layer }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(handoffPrompt(layer)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" className="layer-handoff" onClick={copy} data-testid="layer-handoff" title={`Copia o pedido para o agente de código: implementar ${specPath(layer)}`}>
      {copied ? "Copiado" : "Copiar pedido"}
    </button>
  );
}
