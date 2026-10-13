// Blocos de explicação e reorganização do canvas (docs/funcionalidades/13-layout-semantico.md).
// O agente diz o que existe (blocos e relações); o layout diz onde fica; o canvas anima a mudança.
import { OperationError, SCHEMA_BASE_URI, type Arrangement, type Block, type CanvasObject, type OperationHandler, type Point, type Rect, type Size } from "@open-semantic/protocol";

import { placedBy } from "./handlers.js";
import { litObjects } from "./layerView.js";
import { repositoryUnit } from "./layout/anchoring.js";
import { placeArranged } from "./layout/arranged.js";
import { blockSize } from "./layout/blockSize.js";
import { placeNew } from "./layout/placement.js";
import { planRebalance } from "./layout/rebalance.js";
import { activeProject } from "./projects.js";
import type { WorkspaceStore } from "./store.js";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });
const blockProp = (name: string) => ref(`block.schema.json#/$defs/Block/properties/${name}`);
const CONTENT = ["kind", "title", "text", "items", "ordered", "columns", "rows"] as const;

const blockInput = {
  type: "object",
  required: ["blockId", "kind"],
  properties: {
    blockId: ref("common.schema.json#/$defs/BlockId"),
    ...Object.fromEntries(CONTENT.map((k) => [k, blockProp(k)])),
    arrangement: ref("common.schema.json#/$defs/Arrangement"),
  },
  additionalProperties: false,
};

type BlockInput = Omit<Block, "id" | "revision" | "projectId"> & { blockId: string };

/**
 * Lugar de um objeto novo com relação declarada; quando ele abre espaço (título acima de um diagrama),
 * quem estava ali desce. Sem relação, ou com o alvo fora do canvas, vale `fallback`.
 */
export function placeInFlow(store: WorkspaceStore, size: Size, arrangement: Arrangement | undefined, fallback: () => Rect): Rect {
  const placed = arrangement ? placeArranged(store.read(), size, arrangement) : undefined;
  if (!placed) return fallback();
  for (const id of placed.shift?.ids ?? []) {
    const o = store.canvasObject(id);
    if (o) store.placeObject({ ...o, position: { x: o.position.x, y: o.position.y + placed.shift!.dy } });
  }
  return placed.rect;
}

/** Aplica posições novas sem mudar quem pôs o objeto (a reorganização não transforma o arranjo do agente em do usuário). */
function moveTo(store: WorkspaceStore, moves: { objectId: string; position: Point }[]) {
  for (const m of moves) {
    const o = store.canvasObject(m.objectId);
    if (o) store.placeObject({ ...o, position: m.position });
  }
}

function checkBlock(store: WorkspaceStore, b: BlockInput, i: number, created: Set<string>) {
  const at = `/blocks/${i}`;
  if (b.kind === "list" && !b.items?.length) throw new OperationError("INVALID_ARGUMENTS", "Lista sem itens.", { argumentPath: `${at}/items` });
  if (b.kind === "table" && !b.rows?.length) throw new OperationError("INVALID_ARGUMENTS", "Tabela sem linhas.", { argumentPath: `${at}/rows` });
  if ((b.kind === "heading" && !b.title) || (b.kind === "text" && !b.text)) {
    throw new OperationError("INVALID_ARGUMENTS", "Bloco sem texto.", { argumentPath: at });
  }
  const target = b.arrangement?.targetId;
  if (target && !store.canvasObject(target) && !created.has(target)) {
    throw new OperationError("REFERENCE_INVALID", `${target} não está no canvas.`, { argumentPath: `${at}/arrangement/targetId` });
  }
  if (store.block(b.blockId) || created.has(b.blockId)) throw new OperationError("PRECONDITION_FAILED", `Já existe o bloco ${b.blockId}; use block.update.`, { targetId: b.blockId });
}

export interface BlockHandlerDeps {
  store: WorkspaceStore;
}

export function blockHandlers({ store }: BlockHandlerDeps): OperationHandler[] {
  const createBlock = (input: BlockInput, projectId: string | undefined, actor: CanvasObject["placedBy"]) => {
    const { blockId, ...content } = input;
    const block: Block = { id: blockId, ...content, ...(projectId ? { projectId } : {}), revision: 0 };
    const target = input.arrangement ? store.canvasObject(input.arrangement.targetId) : undefined;
    const size = blockSize(block, input.arrangement?.relation === "annotates" ? target?.size.width : undefined);
    const repo = projectId ? repositoryUnit(store.read(), projectId) : undefined;
    const rect = placeInFlow(store, size, input.arrangement, () => placeNew(store.read(), size, repo ? { unitId: repo.id } : {}).rect);
    const zIndex = Math.max(0, ...store.read().canvas.objects.map((o) => o.zIndex ?? 0)) + 1;
    store.placeObject({ id: blockId, objectKind: "block", ...rect, zIndex, ...(actor ? { placedBy: actor } : {}) });
    return store.putBlock(block);
  };

  return [
    {
      operation: "block.create",
      agent: {
        guide: "{blocks:[{blockId, kind: heading|text|list|table, title?, text?, items?, ordered?, columns?, rows?, arrangement?:{relation, targetId, side?}}], projectId?}",
        describe: (args) => `escrever ${(args.blocks as unknown[]).length} bloco(s) de explicação`,
      },
      argumentsSchema: {
        type: "object",
        required: ["blocks"],
        properties: { blocks: { type: "array", minItems: 1, maxItems: 12, items: blockInput }, projectId: ref("common.schema.json#/$defs/ProjectId") },
        additionalProperties: false,
      },
      check(args) {
        const created = new Set<string>();
        (args.blocks as BlockInput[]).forEach((b, i) => {
          checkBlock(store, b, i, created);
          created.add(b.blockId);
        });
      },
      handle(args, { request }) {
        const projectId = (args.projectId as string | undefined) ?? activeProject(store.read())?.id;
        const actor = placedBy(request.authorization.actor);
        const saved = store.transact(() => (args.blocks as BlockInput[]).map((b) => createBlock(b, projectId, actor)));
        return {
          output: { blocks: saved.map((b) => ({ blockId: b.id, ...store.canvasObject(b.id)! })) },
          changes: saved.map((b) => ({ id: b.id, change: "created" as const, revision: b.revision })),
          workspaceRevision: store.revision,
        };
      },
    },
    ...blockEditHandlers(store),
    ...layoutHandlers(store),
  ];
}

/** Mudar o conteúdo de um bloco e tirá-lo do canvas. */
function blockEditHandlers(store: WorkspaceStore): OperationHandler[] {
  return [
    {
      operation: "block.update",
      agent: { guide: "{blockId, set:{title?, text?, items?, ordered?, columns?, rows?}}", describe: (args) => `atualizar o bloco ${String(args.blockId)}` },
      argumentsSchema: {
        type: "object",
        required: ["blockId", "set"],
        properties: {
          blockId: ref("common.schema.json#/$defs/BlockId"),
          set: { type: "object", properties: Object.fromEntries(CONTENT.filter((k) => k !== "kind").map((k) => [k, blockProp(k)])), additionalProperties: false },
        },
        additionalProperties: false,
      },
      check(args) {
        if (!store.block(args.blockId as string)) throw new OperationError("TARGET_NOT_FOUND", `Bloco ${String(args.blockId)} não existe.`, { targetId: args.blockId as string });
      },
      handle(args) {
        const current = store.block(args.blockId as string)!;
        const next = { ...current, ...(args.set as Partial<Block>) };
        const saved = store.transact(() => {
          const object = store.canvasObject(current.id);
          const target = next.arrangement?.relation === "annotates" ? store.canvasObject(next.arrangement.targetId) : undefined;
          if (object) store.placeObject({ ...object, size: blockSize(next, target?.size.width ?? object.size.width) });
          return store.putBlock(next);
        });
        return { output: { blockId: saved.id }, changes: [{ id: saved.id, change: "updated", revision: saved.revision }], workspaceRevision: store.revision };
      },
    },
    {
      operation: "block.remove",
      agent: { guide: "{blockId} removes a block and the blocks attached to it.", describe: (args) => `tirar o bloco ${String(args.blockId)}` },
      argumentsSchema: { type: "object", required: ["blockId"], properties: { blockId: ref("common.schema.json#/$defs/BlockId") }, additionalProperties: false },
      handle(args) {
        const id = args.blockId as string;
        if (!store.block(id)) return { changes: [{ id, change: "unchanged" }] };
        store.transact(() => store.deleteBlock(id));
        return { changes: [{ id, change: "deleted" }], workspaceRevision: store.revision };
      },
    },
  ];
}

const pointSchema = ref("common.schema.json#/$defs/Point");

/** Reorganizar (com prévia, para o canvas decidir se anima) e aplicar posições (o desfazer da reorganização). */
function layoutHandlers(store: WorkspaceStore): OperationHandler[] {
  return [
    {
      operation: "canvas.rebalance",
      agent: { guide: "{all?} reorganizes the explanations of the active layer by their relations.", describe: () => "reorganizar o canvas" },
      argumentsSchema: {
        type: "object",
        properties: {
          all: { type: "boolean", description: "Também o que o usuário pôs à mão." },
          preview: { type: "boolean", description: "Só calcula o plano, sem mexer." },
        },
        additionalProperties: false,
      },
      handle(args) {
        const scope = litObjects(store.read());
        const moves = planRebalance(store.read(), { ...(scope ? { scope } : {}), all: args.all === true });
        if (args.preview || !moves.length) return { output: { moves, applied: false }, changes: [] };
        store.transact(() => moveTo(store, moves.map((m) => ({ objectId: m.objectId, position: m.to }))));
        return {
          output: { moves, applied: true },
          changes: moves.map((m) => ({ id: m.objectId, change: "updated" as const, revision: store.canvasObject(m.objectId)?.revision ?? 0 })),
          workspaceRevision: store.revision,
        };
      },
    },
    {
      operation: "canvas.arrange",
      argumentsSchema: {
        type: "object",
        required: ["moves"],
        properties: {
          moves: {
            type: "array",
            minItems: 1,
            items: { type: "object", required: ["objectId", "position"], properties: { objectId: ref("common.schema.json#/$defs/CanvasObjectId"), position: pointSchema }, additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
      handle(args) {
        const moves = (args.moves as { objectId: string; position: Point }[]).filter((m) => store.canvasObject(m.objectId));
        store.transact(() => moveTo(store, moves));
        return {
          changes: moves.map((m) => ({ id: m.objectId, change: "updated" as const, revision: store.canvasObject(m.objectId)?.revision ?? 0 })),
          workspaceRevision: store.revision,
        };
      },
    },
  ];
}
