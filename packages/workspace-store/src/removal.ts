// Tirar um projeto do workspace (os arquivos no disco não mudam). Sai junto tudo que só existe por causa dele:
// referências a arquivos, mods que mostram esses arquivos, diagramas e conhecimento do projeto.
// O que sobra perde só os vínculos com o que saiu, sempre em cópias novas (o store não altera objetos no lugar).
import type { DiagramModel, ModInstance, Provenance, Region, SemanticEntity, WorkspaceSnapshot } from "@open-semantic/protocol";

export interface Removed {
  artifacts: number;
  mods: number;
  diagrams: number;
  entities: number;
}

const MOD_REFS = ["rootRef", "fileRef", "cwdRef", "artifactId"];

type Gone = ReturnType<typeof doomed>;

/** Os ids que saem com o projeto. */
function doomed(doc: WorkspaceSnapshot, projectId: string) {
  const artifacts = new Set(doc.artifacts.filter((a) => a.projectId === projectId).map((a) => a.id));
  const modGone = (m: ModInstance) =>
    m.projectId === projectId || MOD_REFS.some((k) => typeof m.config[k] === "string" && artifacts.has(m.config[k] as string));
  const entities = new Set(doc.semantic.entities.filter((e) => e.projectId === projectId).map((e) => e.id));
  return {
    artifacts,
    entities,
    mods: new Set(doc.mods.filter(modGone).map((m) => m.id)),
    diagrams: new Set(doc.diagrams.filter((d) => d.projectId === projectId).map((d) => d.id)),
    nodes: new Set(doc.diagrams.filter((d) => d.projectId === projectId).flatMap((d) => d.nodes.map((n) => n.id))),
    relations: new Set(doc.semantic.relations.filter((r) => entities.has(r.sourceId) || entities.has(r.targetId)).map((r) => r.id)),
    evidence: new Set(doc.semantic.evidence.filter((ev) => ev.artifactId !== undefined && artifacts.has(ev.artifactId)).map((ev) => ev.id)),
  };
}

export function removeProjectFrom(doc: WorkspaceSnapshot, projectId: string): Removed {
  const gone = doomed(doc, projectId);
  dropFromWorkspace(doc, projectId);
  doc.projects = doc.projects.filter((p) => p.id !== projectId);
  doc.artifacts = doc.artifacts.filter((a) => !gone.artifacts.has(a.id));
  doc.mods = doc.mods.filter((m) => !gone.mods.has(m.id)).map((m) => unlinkEntities(m, gone));
  doc.diagrams = doc.diagrams.filter((d) => !gone.diagrams.has(d.id)).map((d) => unlinkDiagram(d, gone));
  doc.semantic.entities = doc.semantic.entities.filter((e) => !gone.entities.has(e.id)).map((e) => unlinkEntity(e, gone));
  doc.semantic.relations = doc.semantic.relations.filter((r) => !gone.relations.has(r.id)).map((r) => dropEvidence(r, gone));
  doc.semantic.evidence = doc.semantic.evidence.filter((ev) => !gone.evidence.has(ev.id));
  doc.canvas.objects = doc.canvas.objects.filter((o) => !gone.mods.has(o.id) && !gone.diagrams.has(o.id));
  doc.canvas.regions = doc.canvas.regions.map((r) => unlinkEntities(r, gone));
  unlinkFocus(doc, gone);
  unlinkLayers(doc, gone);
  return { artifacts: gone.artifacts.size, mods: gone.mods.size, diagrams: gone.diagrams.size, entities: gone.entities.size };
}

/** A lista sem os ids que saíram, ou a mesma lista quando nada sai (o objeto não muda à toa). */
function keep(ids: string[] | undefined, gone: (id: string) => boolean): string[] | undefined {
  return ids?.some(gone) ? ids.filter((id) => !gone(id)) : ids;
}

function dropFromWorkspace(doc: WorkspaceSnapshot, projectId: string) {
  const { activeProjectId, ...workspace } = doc.workspace;
  const projectIds = workspace.projectIds.filter((p) => p !== projectId);
  const active = activeProjectId === projectId ? projectIds[projectIds.length - 1] : activeProjectId;
  doc.workspace = { ...workspace, projectIds, ...(active ? { activeProjectId: active } : {}) };
}

function unlinkEntities<T extends ModInstance | Region>(item: T, gone: Gone): T {
  const ids = keep(item.semanticEntityIds, (id) => gone.entities.has(id));
  return ids === item.semanticEntityIds ? item : { ...item, semanticEntityIds: ids as string[] };
}

function unlinkDiagram(d: DiagramModel, gone: Gone): DiagramModel {
  const unlinked = (n: DiagramModel["nodes"][number]) => !!n.semanticEntityId && gone.entities.has(n.semanticEntityId);
  const unrelated = (e: DiagramModel["edges"][number]) => !!e.semanticRelationId && gone.relations.has(e.semanticRelationId);
  if (!d.nodes.some(unlinked) && !d.edges.some(unrelated)) return d;
  return {
    ...d,
    nodes: d.nodes.map((n) => (unlinked(n) ? withoutKey(n, "semanticEntityId") : n)),
    edges: d.edges.map((e) => (unrelated(e) ? withoutKey(e, "semanticRelationId") : e)),
  };
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function dropEvidence<T extends { provenance: Provenance }>(item: T, gone: Gone): T {
  const ids = keep(item.provenance.evidenceIds, (id) => gone.evidence.has(id));
  return ids === item.provenance.evidenceIds ? item : { ...item, provenance: { ...item.provenance, evidenceIds: ids as string[] } };
}

function unlinkEntity(entity: SemanticEntity, gone: Gone): SemanticEntity {
  const e = dropEvidence(entity, gone);
  const artifactIds = keep(e.artifactIds, (id) => gone.artifacts.has(id));
  return artifactIds === e.artifactIds ? e : { ...e, artifactIds: artifactIds as string[] };
}

/** O foco da navegação não aponta mais para o que saiu. */
function unlinkFocus(doc: WorkspaceSnapshot, gone: Gone) {
  const isGone = (id: string) => gone.mods.has(id) || gone.diagrams.has(id) || gone.entities.has(id) || gone.relations.has(id) || gone.artifacts.has(id);
  const focus = doc.navigation.focus as { targetIds?: string[]; highlightIds?: string[] };
  const targetIds = keep(focus.targetIds, isGone);
  const highlightIds = keep(focus.highlightIds, isGone);
  if (targetIds === focus.targetIds && highlightIds === focus.highlightIds) return;
  doc.navigation = { ...doc.navigation, focus: { ...focus, ...(targetIds ? { targetIds } : {}), ...(highlightIds ? { highlightIds } : {}) } };
}

/** Diagramas, nós e mods que saíram deixam de ser membros e âncoras das camadas; a camada fica. */
function unlinkLayers(doc: WorkspaceSnapshot, gone: Gone) {
  if (!doc.layers?.length) return;
  const isGone = (id: string) => gone.diagrams.has(id) || gone.mods.has(id) || gone.nodes.has(id);
  doc.layers = doc.layers.map((layer) => {
    const members = layer.members.filter((m) => !isGone(m.id));
    const anchors = keep(layer.anchors, isGone) ?? [];
    return members.length === layer.members.length && anchors === layer.anchors ? layer : { ...layer, members, anchors };
  });
}
