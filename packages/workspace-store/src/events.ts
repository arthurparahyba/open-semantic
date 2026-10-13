// Eventos de domínio a partir dos commits do store (DomainEvent em contracts/schemas/operation.schema.json).
// Um ponto só para todos os módulos: o que mudou no documento diz o evento, sem cada handler lembrar de publicar.
// A navegação publica os próprios eventos (navigation.started etc.), que dependem do movimento e não só do estado.
import { sameValue, type ArtifactReference, type DomainEvent, type ModInstance } from "@open-semantic/protocol";

import type { Commit, StoreChange } from "./commits.js";

export interface EventContext {
  workspaceId: string;
  newId(): string;
  now(): Date;
  /** A operação que causou o commit, quando houver (o Dispatcher sabe qual está em execução). */
  operationId?: string;
}

type Draft = Pick<DomainEvent, "type" | "source" | "subjectId"> & { payload: Record<string, unknown> };
type ChangeOf<C extends StoreChange["collection"]> = Extract<StoreChange, { collection: C }>;

/** Os eventos de um commit, na ordem das mudanças. Cada commit do documento termina em `workspace.revision_changed`. */
export function commitEvents(commit: Commit, ctx: EventContext): DomainEvent[] {
  const drafts = commit.changes.flatMap(eventsOf);
  if (!commit.viewOnly) {
    drafts.push({ type: "workspace.revision_changed", source: "workspace_store", subjectId: ctx.workspaceId, payload: { revision: commit.revision } });
  }
  const at = ctx.now().toISOString();
  return drafts.map((draft) => ({
    eventId: ctx.newId(),
    ...draft,
    ...(ctx.operationId ? { operationId: ctx.operationId } : {}),
    workspaceRevision: commit.revision,
    at,
  }));
}

function eventsOf(change: StoreChange): Draft[] {
  switch (change.collection) {
    case "artifacts":
      return artifactEvents(change);
    case "entities":
    case "relations":
      return semanticEvents(change);
    case "mods":
      return modEvents(change);
    case "diagrams":
      return diagramEvents(change);
    case "regions": {
      const region = change.after ?? change.before;
      return region ? [{ type: "region.changed", source: "workspace_store", subjectId: change.id, payload: { change: change.kind, title: region.title } }] : [];
    }
    case "canvas":
      return movedEvents(change);
    case "layers": {
      const layer = change.after ?? change.before;
      return layer ? [{ type: "layer.changed", source: "workspace_store", subjectId: change.id, payload: { change: change.kind, name: layer.name } }] : [];
    }
    default:
      // Projetos, evidências, o workspace e a navegação não têm evento próprio no contrato.
      return [];
  }
}

const pathOf = (artifact: ArtifactReference) => ("rootId" in artifact.locator ? { path: artifact.locator.path } : {});

function artifactEvents({ id, kind, before, after }: ChangeOf<"artifacts">): Draft[] {
  const event = (type: DomainEvent["type"], payload: Record<string, unknown>): Draft => ({ type, source: "project_runtime", subjectId: id, payload });
  if (kind === "created" && after) {
    return [event("artifact.created", { projectId: after.projectId, kind: after.kind, ...pathOf(after), source: after.provenance.source })];
  }
  if (!before || !after) return [];
  const from = before.validity.status;
  const to = after.validity.status;
  if (from !== to) {
    const reason = after.validity.reason ? { reason: after.validity.reason } : {};
    return [event("artifact.validity_changed", { from, to }), ...(to === "missing" ? [event("artifact.missing", { ...pathOf(after), ...reason })] : [])];
  }
  const hash = after.validity.fingerprint?.contentHash;
  return hash && hash !== before.validity.fingerprint?.contentHash ? [event("artifact.changed", { contentHash: hash })] : [];
}

function semanticEvents(change: ChangeOf<"entities"> | ChangeOf<"relations">): Draft[] {
  const upserted = upsertedEvent(change);
  const from = change.before?.status;
  const to = change.after?.status;
  if (!upserted) return [];
  return from && from !== to ? [upserted, { type: "semantic.status_changed", source: "semantic", subjectId: change.id, payload: { from, to } }] : [upserted];
}

function upsertedEvent(change: ChangeOf<"entities"> | ChangeOf<"relations">): Draft | undefined {
  if (change.collection === "entities") {
    const e = change.after;
    return e && { type: "semantic.entity_upserted", source: "semantic", subjectId: e.id, payload: { kind: e.kind, name: e.name, status: e.status } };
  }
  const r = change.after;
  return r && { type: "semantic.relation_upserted", source: "semantic", subjectId: r.id, payload: { type: r.type, sourceId: r.sourceId, targetId: r.targetId, status: r.status } };
}

/** O que conta como configuração de um mod: tudo menos o ciclo de vida e a contabilidade de revisão. */
const configOf = ({ lifecycle: _lifecycle, revision: _revision, updatedAt: _updatedAt, ...config }: ModInstance) => config;

function modEvents({ id, kind, before, after }: ChangeOf<"mods">): Draft[] {
  const event = (type: DomainEvent["type"], payload: Record<string, unknown>): Draft => ({ type, source: "mod_runtime", subjectId: id, payload });
  if (kind === "created" && after) return [event("mod.created", { type: after.type, ...(after.title ? { title: after.title } : {}) })];
  if (kind === "deleted" && before) return [event("mod.deleted", { type: before.type })];
  if (!before || !after) return [];
  const events: Draft[] = [];
  if (before.lifecycle !== after.lifecycle) events.push(event("mod.lifecycle_changed", { from: before.lifecycle, to: after.lifecycle }));
  if (!sameValue(configOf(before), configOf(after))) events.push(event("mod.configured", { revision: after.revision }));
  return events;
}

function diagramEvents({ id, kind, before, after }: ChangeOf<"diagrams">): Draft[] {
  const diagram = after ?? before;
  if (!diagram) return [];
  const type = kind === "created" ? "diagram.created" : kind === "deleted" ? "diagram.deleted" : "diagram.changed";
  return [{ type, source: "diagram_engine", subjectId: id, payload: { title: diagram.title, revision: diagram.revision } }];
}

/** Mudou de lugar, de tamanho ou foi recolhido: o que o Navigator precisa para refazer um enquadramento. */
function movedEvents({ id, kind, before, after }: ChangeOf<"canvas">): Draft[] {
  if (kind !== "updated" || !before || !after) return [];
  const footprint = (o: typeof after) => [o.position, o.size, o.collapsed ?? false];
  if (sameValue(footprint(before), footprint(after))) return [];
  const collapsed = after.collapsed !== undefined ? { collapsed: after.collapsed } : {};
  return [{ type: "canvas.object_moved", source: "workspace_store", subjectId: id, payload: { position: after.position, size: after.size, ...collapsed } }];
}
