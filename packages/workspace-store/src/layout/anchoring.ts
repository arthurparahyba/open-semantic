// Ancoragem e projeção do canvas (docs/funcionalidades/09-ancoragem-e-projecao.md).
// Cada item do canvas é ancorado a unidades de contexto (entidades semânticas); o lugar dele e os grupos
// desenhados em volta saem dessas âncoras. Nada aqui é gravado: tudo é recalculado do documento.
import type { Rect, SemanticEntity, Size, WorkspaceSnapshot } from "@open-semantic/protocol";

import { flowRoot } from "./flow.js";
import { GAP, boundsOfRects, findFreeSpot, overlaps } from "./placement.js";

export type AnchorDoc = Pick<WorkspaceSnapshot, "canvas"> & Partial<Pick<WorkspaceSnapshot, "diagrams" | "mods" | "semantic" | "blocks">>;

/** Margem do grupo em volta do conteúdo; em cima fica o título. O repositório tem margem maior. */
export const GROUP_PADDING = { top: 56, side: 28 } as const;
export const REPOSITORY_PADDING = { top: 72, side: 40 } as const;

export interface ContextGroup {
  unitId: string;
  name: string;
  kind: string;
  /** 0 para unidades de primeiro nível; cresce para dentro. */
  depth: number;
  bounds: Rect;
}

const live = (status: SemanticEntity["status"]) => status !== "rejected" && status !== "invalid";
const entitiesOf = (doc: AnchorDoc) => (doc.semantic?.entities ?? []).filter((e) => live(e.status));
const rectOf = (o: { position: Rect["position"]; size: Size }): Rect => ({ position: o.position, size: o.size });
const paddingOf = (kind: string) => (kind === "repository" ? REPOSITORY_PADDING : GROUP_PADDING);

/**
 * Lugar junto de `last` sem pular por cima de outro grupo (o grupo é um retângulo: pular o faria
 * engolir o vizinho). Tenta à direita e abaixo do último item; depois, linhas novas embaixo do conteúdo.
 */
function growInside(occupied: Rect[], size: Size, last: Rect, content: Rect): Rect {
  const fits = (r: Rect) => !occupied.some((o) => overlaps(r, o, GAP / 2));
  const at = (x: number, y: number): Rect => ({ position: { x, y }, size });
  const right = at(last.position.x + last.size.width + GAP, last.position.y);
  const below = at(last.position.x, last.position.y + last.size.height + GAP);
  for (const candidate of [right, below]) if (fits(candidate)) return candidate;
  let y = content.position.y + content.size.height + GAP;
  for (let i = 0; i < 200; i++) {
    const candidate = at(content.position.x, y);
    if (fits(candidate)) return candidate;
    y += GAP + size.height / 2;
  }
  return at(content.position.x, y);
}

function padBy(rect: Rect, padding: { top: number; side: number }): Rect {
  return {
    position: { x: rect.position.x - padding.side, y: rect.position.y - padding.top },
    size: { width: rect.size.width + 2 * padding.side, height: rect.size.height + padding.top + padding.side },
  };
}

/** A unidade do repositório de um projeto, se já existir. */
export function repositoryUnit(doc: AnchorDoc, projectId: string): SemanticEntity | undefined {
  return entitiesOf(doc).find((e) => e.kind === "repository" && e.projectId === projectId);
}

/**
 * Pai de cada unidade: quem a contém (relação `contains`). Sem relação explícita, uma unidade de um
 * repositório fica dentro da unidade desse repositório.
 */
export function parentsOf(doc: AnchorDoc): Map<string, string> {
  const entities = entitiesOf(doc);
  const known = new Set(entities.map((e) => e.id));
  const parent = new Map<string, string>();
  for (const r of doc.semantic?.relations ?? []) {
    if (r.type === "contains" && live(r.status) && known.has(r.sourceId) && known.has(r.targetId) && !parent.has(r.targetId)) {
      parent.set(r.targetId, r.sourceId);
    }
  }
  for (const e of entities) {
    if (parent.has(e.id) || e.kind === "repository" || !e.projectId) continue;
    const repo = repositoryUnit(doc, e.projectId);
    if (repo && repo.id !== e.id) parent.set(e.id, repo.id);
  }
  return parent;
}

/** Cadeia de unidades de dentro para fora, começando pela própria (protegida contra ciclos). */
export function ancestry(parents: Map<string, string>, unitId: string): string[] {
  const chain = [unitId];
  for (let p = parents.get(unitId); p && !chain.includes(p); p = parents.get(p)) chain.push(p);
  return chain;
}

/** Âncoras de cada objeto do canvas. A primeira é a principal: é ela que decide o grupo do objeto. */
export function anchorsOf(doc: AnchorDoc): Map<string, string[]> {
  const known = new Set(entitiesOf(doc).map((e) => e.id));
  const fallback = (projectId: string | undefined) => {
    const repo = projectId ? repositoryUnit(doc, projectId) : undefined;
    return repo ? [repo.id] : [];
  };
  const byObject = new Map<string, string[]>();
  for (const d of doc.diagrams ?? []) {
    const anchors = (d.anchorIds ?? []).filter((id) => known.has(id));
    byObject.set(d.id, anchors.length ? anchors : fallback(d.projectId));
  }
  for (const m of doc.mods ?? []) {
    const anchors = (m.semanticEntityIds ?? []).filter((id) => known.has(id));
    byObject.set(m.id, anchors.length ? anchors : fallback(m.projectId));
  }
  anchorBlocks(doc, byObject);
  const onCanvas = new Set(doc.canvas.objects.map((o) => o.id));
  for (const id of [...byObject.keys()]) if (!onCanvas.has(id) || !byObject.get(id)!.length) byObject.delete(id);
  return byObject;
}

/** Um bloco fica no grupo de onde a explicação dele parte (doc 13). */
function anchorBlocks(doc: AnchorDoc, byObject: Map<string, string[]>) {
  const flow = { canvas: doc.canvas, diagrams: doc.diagrams ?? [], blocks: doc.blocks ?? [] };
  for (const b of flow.blocks) {
    const anchors = byObject.get(flowRoot(flow, b.id));
    if (anchors) byObject.set(b.id, anchors);
  }
}

/** Objetos do canvas ancorados à unidade ou a unidades dentro dela (qualquer âncora, não só a principal). */
export function unitItems(doc: AnchorDoc, unitId: string): string[] {
  const parents = parentsOf(doc);
  return [...anchorsOf(doc)].filter(([, anchors]) => anchors.some((a) => ancestry(parents, a).includes(unitId))).map(([id]) => id);
}

/** Grupos desenhados no canvas: um por unidade que tem algo ancorado nela ou dentro dela. De fora para dentro. */
export function contextGroups(doc: AnchorDoc): ContextGroup[] {
  const parents = parentsOf(doc);
  const entities = new Map(entitiesOf(doc).map((e) => [e.id, e]));
  const objects = new Map(doc.canvas.objects.map((o) => [o.id, o]));
  const own = new Map<string, Rect[]>();
  for (const [objectId, anchors] of anchorsOf(doc)) {
    const unit = anchors[0]!;
    own.set(unit, [...(own.get(unit) ?? []), rectOf(objects.get(objectId)!)]);
  }
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents) children.set(parent, [...(children.get(parent) ?? []), child]);

  const groups = new Map<string, ContextGroup>();
  const visit = (unitId: string, depth: number, path: string[]): Rect | undefined => {
    if (path.includes(unitId)) return undefined;
    const inner = (children.get(unitId) ?? []).map((c) => visit(c, depth + 1, [...path, unitId])).filter((r): r is Rect => r !== undefined);
    const rects = [...(own.get(unitId) ?? []), ...inner];
    const entity = entities.get(unitId);
    if (!rects.length || !entity) return undefined;
    const bounds = padBy(boundsOfRects(rects), paddingOf(entity.kind));
    groups.set(unitId, { unitId, name: entity.name, kind: entity.kind, depth, bounds });
    return bounds;
  };
  const roots = [...entities.keys()].filter((id) => !parents.has(id));
  for (const root of roots) visit(root, 0, []);
  return [...groups.values()].sort((a, b) => a.depth - b.depth || a.unitId.localeCompare(b.unitId));
}

/**
 * Lugar para um item novo ancorado à unidade: junto do que a unidade já tem; se ela ainda não tem nada,
 * dentro do grupo de quem a contém; se não houver, perto de unidades relacionadas; senão, à direita de tudo.
 * Nunca entra no grupo de outra unidade.
 */
export function placeAnchored(doc: AnchorDoc, size: Size, unitId: string): Rect {
  const parents = parentsOf(doc);
  const chain = ancestry(parents, unitId);
  const groups = contextGroups(doc);
  const groupOf = new Map(groups.map((g) => [g.unitId, g]));
  const kindOf = new Map(entitiesOf(doc).map((e) => [e.id, e.kind]));
  // O item vai ficar dentro do grupo de cada unidade da cadeia; a margem de todos eles não pode encostar
  // no grupo de outra unidade. Por isso os grupos alheios entram "inchados" por essa margem.
  const margin = chain.reduce(
    (m, u) => {
      const p = paddingOf(kindOf.get(u) ?? "");
      return { top: m.top + p.top, side: m.side + p.side };
    },
    { top: 0, side: 0 },
  );
  const foreign = groups.filter((g) => !chain.includes(g.unitId)).map(
    (g): Rect => ({
      // O item fica com margin.top acima e margin.side nos lados e embaixo.
      position: { x: g.bounds.position.x - margin.side, y: g.bounds.position.y - margin.side },
      size: { width: g.bounds.size.width + 2 * margin.side, height: g.bounds.size.height + margin.side + margin.top },
    }),
  );
  const occupied = [...doc.canvas.objects.map(rectOf), ...doc.canvas.regions.map((r) => r.bounds), ...foreign];
  // Unidades da cadeia que ainda não têm grupo vão ganhar um: o título delas precisa de espaço acima do item.
  const firstWithGroup = chain.findIndex((u) => groupOf.has(u));
  const growing = firstWithGroup < 0 ? chain : chain.slice(0, firstWithGroup);
  const lift = growing.reduce((t, u) => t + paddingOf(kindOf.get(u) ?? "").top, 0);
  const outerSize = { width: size.width, height: size.height + lift };
  const inner = (outer: Rect): Rect => ({ position: { x: outer.position.x, y: outer.position.y + lift }, size });

  if (firstWithGroup >= 0) {
    const host = chain[firstWithGroup]!;
    // Âncora: o último item ou subgrupo dentro do grupo anfitrião.
    const anchors = [...anchorsOf(doc)]
      .filter(([, a]) => ancestry(parents, a[0]!).includes(host))
      .map(([id]) => rectOf(doc.canvas.objects.find((o) => o.id === id)!));
    const last = anchors[anchors.length - 1] ?? groupOf.get(host)!.bounds;
    return inner(growInside(occupied, outerSize, last, anchors.length ? boundsOfRects(anchors) : last));
  }

  const related = (doc.semantic?.relations ?? [])
    .filter((r) => live(r.status) && (r.sourceId === unitId || r.targetId === unitId))
    .map((r) => (r.sourceId === unitId ? r.targetId : r.sourceId))
    .map((id) => groupOf.get(id) ?? groupOf.get(ancestry(parents, id).find((a) => groupOf.has(a)) ?? ""))
    .filter((g): g is ContextGroup => g !== undefined)
    .map((g) => g.bounds);
  if (!occupied.length) return { position: { x: 0, y: 0 }, size };
  return inner(findFreeSpot(occupied, outerSize, related.slice(0, 1)));
}
