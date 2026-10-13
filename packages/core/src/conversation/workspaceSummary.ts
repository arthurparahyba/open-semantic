// O workspace como o modelo o lê: o cabeçalho de todo pedido e o resumo enxuto da ferramenta get_workspace.
import type { WorkspaceSnapshot } from "@open-semantic/protocol";
import { activeProject } from "@open-semantic/workspace-store";

const projectsOf = (snapshot: WorkspaceSnapshot) =>
  snapshot.projects.map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.location.kind === "local" ? { folder: p.location.rootPath } : {}),
    roots: p.roots.map((r) => ({ id: r.id, path: r.path })),
    rootArtifactId: p.rootRef,
  }));

/** Cabeçalho do bloco <workspace>: o que o modelo precisa para agir em qualquer pedido. O resto vem do motor de contexto. */
export function workspaceHeader(snapshot: WorkspaceSnapshot) {
  const active = activeProject(snapshot);
  return {
    ...(active ? { activeProjectId: active.id } : {}),
    projects: projectsOf(snapshot),
    cameraControl: snapshot.navigation.control?.mode ?? "agent_allowed",
  };
}

/** Resumo enxuto do workspace para o modelo (sem conteúdo de arquivos). */
export function summarizeWorkspace(snapshot: WorkspaceSnapshot) {
  const regionOf = new Map(snapshot.canvas.objects.map((o) => [o.id, o.regionId]));
  const inRegion = (id: string) => (regionOf.get(id) ? { regionId: regionOf.get(id) } : {});
  const active = activeProject(snapshot);
  return {
    ...(active ? { activeProjectId: active.id } : {}),
    projects: projectsOf(snapshot),
    regions: snapshot.canvas.regions.map((r) => ({
      id: r.id,
      title: r.title,
      objects: snapshot.canvas.objects.filter((o) => o.regionId === r.id).map((o) => o.id),
      ...(r.semanticEntityIds?.length ? { semanticEntityIds: r.semanticEntityIds } : {}),
    })),
    mods: snapshot.mods.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      ...inRegion(m.id),
      ...(typeof m.config.rootRef === "string" ? { rootRef: m.config.rootRef } : {}),
      ...(typeof m.config.artifactId === "string" ? { artifactId: m.config.artifactId } : {}),
    })),
    diagrams: snapshot.diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      ...(d.anchorIds ? { anchorIds: d.anchorIds } : {}),
      ...inRegion(d.id),
      nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind, ...(n.semanticEntityId ? { semanticEntityId: n.semanticEntityId } : {}) })),
      edges: d.edges.map((e) => ({ id: e.id, from: e.sourceNodeId, to: e.targetNodeId, ...(e.label ? { label: e.label } : {}) })),
    })),
    semantic: {
      entities: snapshot.semantic.entities.slice(0, 200).map((e) => ({ id: e.id, kind: e.kind, name: e.name, status: e.status })),
      relations: snapshot.semantic.relations.slice(0, 200).map((r) => ({ id: r.id, type: r.type, from: r.sourceId, to: r.targetId, status: r.status })),
    },
    cameraControl: snapshot.navigation.control?.mode ?? "agent_allowed",
  };
}
