// O que a interface precisa das camadas de assunto (docs/funcionalidades/11-camadas.md), sem dependências de Node.
// Nada aqui é gravado: tudo sai do snapshot.
import type { Block, Layer, WorkspaceSnapshot } from "@open-semantic/protocol";

import { flowRoot } from "./layout/flow.js";

type LayerDoc = Pick<WorkspaceSnapshot, "diagrams" | "navigation"> & Partial<Pick<WorkspaceSnapshot, "canvas">> & { layers?: Layer[]; blocks?: Block[] };

export interface LayerNode {
  layer: Layer;
  depth: number;
}

export interface LayerMark {
  layerId: string;
  name: string;
}

/** As camadas em ordem de índice: cada mãe seguida das filhas (protegido contra ciclos). */
export function layerTree(doc: LayerDoc): LayerNode[] {
  const layers = doc.layers ?? [];
  const known = new Set(layers.map((l) => l.id));
  const out: LayerNode[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | undefined, depth: number) => {
    for (const layer of layers.filter((l) => (parentId ? l.parentId === parentId : !l.parentId || !known.has(l.parentId)))) {
      if (seen.has(layer.id)) continue;
      seen.add(layer.id);
      out.push({ layer, depth });
      walk(layer.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

export function activeLayerOf(doc: LayerDoc): Layer | undefined {
  const id = doc.navigation.activeLayerId;
  return id ? doc.layers?.find((l) => l.id === id) : undefined;
}

/** Objeto do canvas (diagrama ou mod) que contém o elemento: o próprio, ou o diagrama do nó. */
function objectOf(doc: LayerDoc, id: string): string | undefined {
  if (!id.startsWith("nd_")) return id.startsWith("turn_") ? undefined : id;
  return doc.diagrams.find((d) => d.nodes.some((n) => n.id === id))?.id;
}

/**
 * Objetos do canvas em cor plena com a camada ativa: os membros e os diagramas dos nós membros.
 * Sem camada ativa (a base) devolve undefined: tudo fica em cor plena.
 */
export function litObjects(doc: LayerDoc): Set<string> | undefined {
  const active = activeLayerOf(doc);
  if (!active) return undefined;
  const lit = new Set(active.members.map((m) => objectOf(doc, m.id)).filter((id): id is string => !!id));
  // Um bloco acompanha a explicação de onde ele parte (doc 13).
  const canvas = doc.canvas;
  if (canvas) for (const b of doc.blocks ?? []) if (lit.has(flowRoot({ canvas, diagrams: doc.diagrams, blocks: doc.blocks }, b.id))) lit.add(b.id);
  return lit;
}

/** A camada ativa e as de baixo dela até a base: o que é delas aparece (as de baixo esmaecidas). */
function chainOf(doc: LayerDoc): Set<string> {
  const byId = new Map((doc.layers ?? []).map((l) => [l.id, l]));
  const chain = new Set<string>();
  for (let l = activeLayerOf(doc); l && !chain.has(l.id); l = l.parentId ? byId.get(l.parentId) : undefined) chain.add(l.id);
  return chain;
}

/**
 * Objetos do canvas que somem: os que pertencem só a camadas fora do caminho da ativa até a base
 * (doc 11: o que nasce numa camada é só dela). O que não é de camada nenhuma é da base e sempre aparece.
 */
export function hiddenObjects(doc: LayerDoc): Set<string> {
  const chain = chainOf(doc);
  const owners = new Map<string, Set<string>>();
  for (const layer of doc.layers ?? []) {
    for (const m of layer.members) {
      const object = objectOf(doc, m.id);
      if (!object || m.id.startsWith("nd_")) continue; // um nó membro não leva o diagrama inteiro
      const set = owners.get(object) ?? new Set<string>();
      set.add(layer.id);
      owners.set(object, set);
    }
  }
  const canvas = doc.canvas;
  if (canvas) {
    for (const b of doc.blocks ?? []) {
      const root = flowRoot({ canvas, diagrams: doc.diagrams, blocks: doc.blocks }, b.id);
      const rootOwners = owners.get(root);
      if (rootOwners && root !== b.id) owners.set(b.id, new Set([...(owners.get(b.id) ?? []), ...rootOwners]));
    }
  }
  const hidden = new Set<string>();
  for (const [object, set] of owners) if (![...set].some((id) => chain.has(id))) hidden.add(object);
  return hidden;
}

/** Marcadores das filhas da camada ativa (ou das de primeiro nível, na base), por objeto do canvas da âncora. */
export function childMarks(doc: LayerDoc): Map<string, LayerMark[]> {
  const active = activeLayerOf(doc);
  const known = new Set((doc.layers ?? []).map((l) => l.id));
  const children = (doc.layers ?? []).filter((l) => (active ? l.parentId === active.id : !l.parentId || !known.has(l.parentId)));
  const marks = new Map<string, LayerMark[]>();
  for (const child of children) {
    for (const anchor of child.anchors) {
      const object = objectOf(doc, anchor);
      if (!object) continue;
      const list = marks.get(object) ?? [];
      if (!list.some((m) => m.layerId === child.id)) list.push({ layerId: child.id, name: child.name });
      marks.set(object, list);
    }
  }
  return marks;
}
