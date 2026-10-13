// Camadas de assunto (docs/funcionalidades/11-camadas.md): recortes nomeados que atravessam unidades.
// Toda camada nasce de um elemento da camada de baixo (a âncora). Desfazer uma camada só tira o recorte:
// diagramas, mods e mensagens continuam onde estão.
import { OperationError, SCHEMA_BASE_URI, type Layer, type LayerMember, type OperationHandler } from "@open-semantic/protocol";

import type { WorkspaceStore } from "./store.js";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });
const memberId = ref("layer.schema.json#/$defs/LayerMemberId");
const layerId = ref("common.schema.json#/$defs/LayerId");

const memberInput = {
  type: "object",
  required: ["id"],
  properties: { id: memberId, weight: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" } },
  additionalProperties: false,
};

type MemberInput = { id: string; weight?: number; reason?: string };

/** O elemento existe no workspace? Trechos de conversa (turn_) vivem na conversa, não no snapshot: valem sempre. */
export function elementExists(store: WorkspaceStore, id: string): boolean {
  if (id.startsWith("turn_")) return true;
  if (id.startsWith("dgm_")) return !!store.diagram(id);
  if (id.startsWith("mod_")) return !!store.mod(id);
  if (id.startsWith("nd_")) return store.read().diagrams.some((d) => d.nodes.some((n) => n.id === id));
  return false;
}

/** O elemento está na camada: é membro, ou é nó de um diagrama membro. Sem camada, é a base: tudo está nela. */
export function inLayer(store: WorkspaceStore, layer: Layer | undefined, id: string): boolean {
  if (!layer) return true;
  if (layer.members.some((m) => m.id === id)) return true;
  if (!id.startsWith("nd_")) return false;
  return layer.members.some((m) => m.id.startsWith("dgm_") && store.diagram(m.id)?.nodes.some((n) => n.id === id));
}

/** Junta membros novos aos atuais; quem já está fica com o maior peso. O que o usuário pôs, o agente não rebaixa. */
export function mergeMembers(current: LayerMember[], incoming: LayerMember[]): LayerMember[] {
  const out = current.slice();
  for (const m of incoming) {
    const i = out.findIndex((x) => x.id === m.id);
    if (i < 0) out.push(m);
    else if (m.weight > out[i]!.weight) out[i] = { ...out[i]!, weight: m.weight, ...(m.reason ? { reason: m.reason } : {}) };
  }
  return out;
}

function requireLayer(store: WorkspaceStore, id: string, argumentPath = "/layerId"): Layer {
  const layer = store.layer(id);
  if (!layer) throw new OperationError("TARGET_NOT_FOUND", `Camada ${id} não existe.`, { targetId: id, argumentPath });
  return layer;
}

function requireElements(store: WorkspaceStore, ids: string[], argumentPath: string) {
  ids.forEach((id, i) => {
    if (!elementExists(store, id)) throw new OperationError("TARGET_NOT_FOUND", `Elemento ${id} não existe.`, { targetId: id, argumentPath: `${argumentPath}/${i}` });
  });
}

export interface LayerHandlerDeps {
  store: WorkspaceStore;
}

interface Kit {
  store: WorkspaceStore;
  nameOf(id: unknown): string;
  toMembers(inputs: MemberInput[], addedBy: LayerMember["addedBy"]): LayerMember[];
  saved<C extends "created" | "updated">(layer: Layer, change: C): { id: string; change: C; revision: number };
}

function createHandler({ store, toMembers, saved }: Kit): OperationHandler {
  return {
    operation: "layer.create",
    agent: {
      guide:
        "{layerId, name, description?, parentId?, anchors, members?, activate?} opens a subject layer born from elements (anchors) of the layer below; only when the user digs into a subject that already has an overview there.",
      describe: (args) => `criar a camada “${String(args.name)}”`,
    },
    argumentsSchema: {
      type: "object",
      required: ["layerId", "name", "anchors"],
      properties: {
        layerId,
        name: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string" },
        parentId: layerId,
        anchors: { type: "array", items: memberId, minItems: 1, uniqueItems: true },
        members: { type: "array", items: memberInput },
        activate: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    check(args) {
      const parent = args.parentId ? requireLayer(store, args.parentId as string, "/parentId") : undefined;
      const anchors = args.anchors as string[];
      requireElements(store, anchors, "/anchors");
      anchors.forEach((id, i) => {
        if (!inLayer(store, parent, id)) {
          throw new OperationError("PRECONDITION_FAILED", `A âncora ${id} não está na camada de baixo (${parent!.name}).`, { targetId: id, argumentPath: `/anchors/${i}` });
        }
      });
      requireElements(store, ((args.members ?? []) as MemberInput[]).map((m) => m.id), "/members");
      const existing = store.layer(args.layerId as string);
      if (existing && existing.name !== args.name) {
        throw new OperationError("PRECONDITION_FAILED", "Já existe uma camada com esse id e outro nome; use layer.update.", { targetId: existing.id });
      }
    },
    handle(args, ctx) {
      const id = args.layerId as string;
      const existing = store.layer(id);
      if (existing) return { output: { layerId: id }, changes: [{ id, change: "unchanged", revision: existing.revision ?? 1 }] };
      const actor = ctx.request.authorization.actor.kind === "user" ? "user" : "agent";
      const at = ctx.now().toISOString();
      const layer: Layer = {
        id,
        name: args.name as string,
        ...(args.description ? { description: args.description as string } : {}),
        ...(args.parentId ? { parentId: args.parentId as string } : {}),
        anchors: args.anchors as string[],
        members: toMembers((args.members ?? []) as MemberInput[], actor),
        origin: actor,
        createdAt: at,
        lastActiveAt: at,
      };
      const next = store.transact(() => {
        const put = store.putLayer(layer);
        if (args.activate !== false) store.setActiveLayer(id);
        return put;
      });
      return { output: { layerId: id }, changes: [saved(next, "created")], workspaceRevision: store.revision };
    },
  };
}

function updateHandler({ store, nameOf, saved }: Kit): OperationHandler {
  return {
    operation: "layer.update",
    agent: {
      guide: "{layerId, name?, description?} renames or redescribes a layer.",
      describe: (args) => `alterar a camada “${nameOf(args.layerId)}”`,
    },
    argumentsSchema: {
      type: "object",
      required: ["layerId"],
      properties: { layerId, name: { type: "string", minLength: 1, maxLength: 80 }, description: { type: "string" } },
      additionalProperties: false,
    },
    check(args) {
      requireLayer(store, args.layerId as string);
    },
    handle(args) {
      const current = requireLayer(store, args.layerId as string);
      const next = { ...current, ...(args.name ? { name: args.name as string } : {}), ...(args.description !== undefined ? { description: args.description as string } : {}) };
      if (next.name === current.name && next.description === current.description) {
        return { changes: [{ id: current.id, change: "unchanged", revision: current.revision ?? 1 }] };
      }
      const put = store.transact(() => store.putLayer(next));
      return { changes: [saved(put, "updated")], workspaceRevision: store.revision };
    },
  };
}

function addMembersHandler({ store, nameOf, toMembers, saved }: Kit): OperationHandler {
  return {
    operation: "layer.add_members",
    agent: {
      guide: "{layerId, members: [{id, weight?, reason?}]} puts diagrams, nodes, mods or conversation turns into a layer.",
      describe: (args) => `colocar ${((args.members ?? []) as unknown[]).length} elemento(s) na camada “${nameOf(args.layerId)}”`,
    },
    argumentsSchema: {
      type: "object",
      required: ["layerId", "members"],
      properties: { layerId, members: { type: "array", items: memberInput, minItems: 1 } },
      additionalProperties: false,
    },
    check(args) {
      requireLayer(store, args.layerId as string);
      requireElements(store, (args.members as MemberInput[]).map((m) => m.id), "/members");
    },
    handle(args, ctx) {
      const current = requireLayer(store, args.layerId as string);
      const actor = ctx.request.authorization.actor.kind === "user" ? "user" : "agent";
      const members = mergeMembers(current.members, toMembers(args.members as MemberInput[], actor));
      if (members.length === current.members.length && members.every((m, i) => m === current.members[i])) {
        return { changes: [{ id: current.id, change: "unchanged", revision: current.revision ?? 1 }] };
      }
      const put = store.transact(() => store.putLayer({ ...current, members }));
      return { changes: [saved(put, "updated")], workspaceRevision: store.revision };
    },
  };
}

function removeMembersHandler({ store, nameOf, saved }: Kit): OperationHandler {
  return {
    operation: "layer.remove_members",
    agent: {
      guide: "{layerId, ids} takes elements out of a layer; the elements themselves stay. Never removes what the user put there unless the user asks.",
      describe: (args) => `tirar ${((args.ids ?? []) as unknown[]).length} elemento(s) da camada “${nameOf(args.layerId)}”`,
    },
    argumentsSchema: {
      type: "object",
      required: ["layerId", "ids"],
      properties: { layerId, ids: { type: "array", items: memberId, minItems: 1, uniqueItems: true } },
      additionalProperties: false,
    },
    check(args) {
      requireLayer(store, args.layerId as string);
    },
    handle(args) {
      const current = requireLayer(store, args.layerId as string);
      const out = new Set(args.ids as string[]);
      const members = current.members.filter((m) => !out.has(m.id));
      if (members.length === current.members.length) return { changes: [{ id: current.id, change: "unchanged", revision: current.revision ?? 1 }] };
      const put = store.transact(() => store.putLayer({ ...current, members }));
      return { changes: [saved(put, "updated")], workspaceRevision: store.revision };
    },
  };
}

function dissolveHandler({ store, nameOf, saved }: Kit): OperationHandler {
  return {
    // "Não precisa de camada para isso": o recorte some, o conteúdo volta para a camada de baixo.
    operation: "layer.dissolve",
    agent: {
      guide: "{layerId} undoes a layer: its members and child layers go back to the layer below; nothing is deleted. Use when the user says the layer is not needed.",
      describe: (args) => `desfazer a camada “${nameOf(args.layerId)}”`,
    },
    argumentsSchema: { type: "object", required: ["layerId"], properties: { layerId }, additionalProperties: false },
    handle(args) {
      const id = args.layerId as string;
      const layer = store.layer(id);
      if (!layer) return { changes: [{ id, change: "unchanged" }] };
      const parent = layer.parentId ? store.layer(layer.parentId) : undefined;
      const changes: { id: string; change: "created" | "updated" | "deleted"; revision?: number }[] = [];
      store.transact(() => {
        if (parent) changes.push(saved(store.putLayer({ ...parent, members: mergeMembers(parent.members, layer.members) }), "updated"));
        for (const child of store.layers().filter((l) => l.parentId === id)) {
          const { parentId: _p, ...rest } = child;
          changes.push(saved(store.putLayer(parent ? { ...rest, parentId: parent.id } : rest), "updated"));
        }
        const wasActive = store.activeLayer()?.id === id;
        store.deleteLayer(id);
        if (wasActive) store.setActiveLayer(parent?.id);
      });
      changes.push({ id, change: "deleted" });
      return { changes, workspaceRevision: store.revision };
    },
  };
}

function mergeHandler({ store, nameOf, saved }: Kit): OperationHandler {
  return {
    operation: "layer.merge",
    agent: {
      guide: "{layerId, sourceLayerId} merges sourceLayerId into layerId. Only when the user asks (\"junta essas duas\"); otherwise suggest it in text.",
      describe: (args) => `juntar a camada “${nameOf(args.sourceLayerId)}” à “${nameOf(args.layerId)}”`,
    },
    argumentsSchema: {
      type: "object",
      required: ["layerId", "sourceLayerId"],
      properties: { layerId, sourceLayerId: layerId },
      additionalProperties: false,
    },
    check(args) {
      requireLayer(store, args.layerId as string);
      requireLayer(store, args.sourceLayerId as string, "/sourceLayerId");
      if (args.layerId === args.sourceLayerId) throw new OperationError("INVALID_ARGUMENTS", "Não dá para juntar uma camada com ela mesma.", { argumentPath: "/sourceLayerId" });
    },
    handle(args) {
      const target = requireLayer(store, args.layerId as string);
      const source = requireLayer(store, args.sourceLayerId as string, "/sourceLayerId");
      const changes: { id: string; change: "created" | "updated" | "deleted"; revision?: number }[] = [];
      store.transact(() => {
        const anchors = [...target.anchors, ...source.anchors.filter((a) => !target.anchors.includes(a))];
        changes.push(saved(store.putLayer({ ...target, anchors, members: mergeMembers(target.members, source.members) }), "updated"));
        for (const child of store.layers().filter((l) => l.parentId === source.id)) changes.push(saved(store.putLayer({ ...child, parentId: target.id }), "updated"));
        const wasActive = store.activeLayer()?.id === source.id;
        store.deleteLayer(source.id);
        if (wasActive) store.setActiveLayer(target.id);
      });
      changes.push({ id: source.id, change: "deleted" });
      return { changes, workspaceRevision: store.revision };
    },
  };
}

function activateHandler({ store, nameOf }: Kit): OperationHandler {
  return {
    operation: "layer.activate",
    agent: {
      guide: "{layerId?} makes a layer the current subject; without layerId, back to the base (whole workspace).",
      describe: (args) => (args.layerId ? `entrar na camada “${nameOf(args.layerId)}”` : "voltar para a base"),
    },
    argumentsSchema: { type: "object", properties: { layerId }, additionalProperties: false },
    check(args) {
      if (args.layerId) requireLayer(store, args.layerId as string);
    },
    handle(args, ctx) {
      const id = args.layerId as string | undefined;
      if (store.activeLayer()?.id === id) return { changes: [] };
      store.transact(() => {
        store.setActiveLayer(id);
        const layer = id ? store.layer(id) : undefined;
        if (layer) store.putLayer({ ...layer, lastActiveAt: ctx.now().toISOString() });
      });
      return { output: { activeLayerId: id ?? null }, changes: id ? [{ id, change: "updated", revision: store.layer(id)?.revision ?? 1 }] : [], workspaceRevision: store.revision };
    },
  };
}

/** Operações das camadas de assunto. */
export function layerHandlers({ store }: LayerHandlerDeps): OperationHandler[] {
  const kit: Kit = {
    store,
    nameOf: (id) => (typeof id === "string" ? (store.layer(id)?.name ?? id) : ""),
    toMembers: (inputs, addedBy) => inputs.map((m) => ({ id: m.id, weight: m.weight ?? 1, addedBy, ...(m.reason ? { reason: m.reason } : {}) })),
    saved: (layer, change) => ({ id: layer.id, change, revision: layer.revision ?? 1 }),
  };
  return [createHandler, updateHandler, addMembersHandler, removeMembersHandler, dissolveHandler, mergeHandler, activateHandler].map((make) => make(kit));
}
