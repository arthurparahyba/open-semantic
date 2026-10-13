// O que a interface precisa das camadas de assunto (docs/funcionalidades/11-camadas.md), sem dependências de Node.
// Nada aqui é gravado: tudo sai do snapshot.
import type { Layer, WorkspaceSnapshot } from "@open-semantic/protocol";

type LayerDoc = Pick<WorkspaceSnapshot, "diagrams" | "navigation"> & { layers?: Layer[] };

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
  return new Set(active.members.map((m) => objectOf(doc, m.id)).filter((id): id is string => !!id));
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
