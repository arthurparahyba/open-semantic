import {
  OperationError,
  SCHEMA_BASE_URI,
  sameValue,
  type CanvasObject,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type KnowledgeStatus,
  type OperationHandler,
  type Point,
} from "@open-semantic/protocol";
import { placeNew, placedBy, repositoryUnit, type PlacementRequest, type WorkspaceStore } from "@open-semantic/workspace-store";

import { computeLayout, diagramSize, type LayoutAlgorithm, type LayoutDirection } from "./layout.js";
import { applyPatch, checkModel, type DiagramOp } from "./model.js";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });
const diagramId = ref("common.schema.json#/$defs/DiagramId");

const placementSchema = {
  type: "object",
  properties: {
    strategy: { const: "free_space_near" },
    position: ref("common.schema.json#/$defs/Point"),
    anchorIds: { type: "array", items: ref("common.schema.json#/$defs/VisualTargetId") },
    regionId: ref("common.schema.json#/$defs/RegionId"),
  },
  additionalProperties: false,
};

const anchorIdsSchema = { type: "array", items: ref("common.schema.json#/$defs/SemanticEntityId"), uniqueItems: true, minItems: 1 };

const captionSchema = { type: "string", maxLength: 600 };

const layoutRequestSchema = {
  type: "object",
  properties: {
    algorithm: { enum: ["manual", "layered", "force", "grid"] },
    direction: { enum: ["LR", "RL", "TB", "BT"] },
  },
  additionalProperties: false,
};

/** Status do conhecimento vinculado a cada nó e aresta, derivado na hora (não fica no diagrama). */
export interface DiagramKnowledge {
  nodes: Record<string, KnowledgeStatus | "broken">;
  edges: Record<string, KnowledgeStatus | "broken">;
}

export function knowledgeOf(store: WorkspaceStore, diagram: DiagramModel): DiagramKnowledge {
  const out: DiagramKnowledge = { nodes: {}, edges: {} };
  for (const n of diagram.nodes) {
    if (n.semanticEntityId) out.nodes[n.id] = store.entity(n.semanticEntityId)?.status ?? "broken";
  }
  for (const e of diagram.edges) {
    if (e.semanticRelationId) out.edges[e.id] = store.relation(e.semanticRelationId)?.status ?? "broken";
  }
  return out;
}

/** Operações do Diagram Engine (docs/funcionalidades/03-diagram-engine.md). */
export function diagramHandlers({ store }: { store: WorkspaceStore }): OperationHandler[] {
  const requireDiagram = (id: string) => {
    const diagram = store.diagram(id);
    if (!diagram) throw new OperationError("TARGET_NOT_FOUND", `Diagrama ${id} não existe.`, { targetId: id });
    return diagram;
  };

  /** Vínculos semânticos precisam existir; um diagrama nunca inventa entidade. */
  const checkLinks = (nodes: DiagramNode[], edges: DiagramEdge[], path: string) => {
    for (const [i, n] of nodes.entries()) {
      if (n.semanticEntityId && !store.entity(n.semanticEntityId)) {
        throw new OperationError("REFERENCE_INVALID", `Entidade '${n.semanticEntityId}' não existe no Open Semantic.`, {
          argumentPath: `${path}/nodes/${i}/semanticEntityId`,
          targetId: n.semanticEntityId,
        });
      }
    }
    for (const [i, e] of edges.entries()) {
      if (e.semanticRelationId && !store.relation(e.semanticRelationId)) {
        throw new OperationError("REFERENCE_INVALID", `Relação '${e.semanticRelationId}' não existe no Open Semantic.`, {
          argumentPath: `${path}/edges/${i}/semanticRelationId`,
          targetId: e.semanticRelationId,
        });
      }
    }
  };

  /** Âncoras precisam ser unidades de contexto que existem (doc 09). */
  const checkAnchors = (anchorIds: string[] | undefined) => {
    for (const [i, id] of (anchorIds ?? []).entries()) {
      if (!store.entity(id)) {
        throw new OperationError("REFERENCE_INVALID", `Unidade de contexto '${id}' não existe no Open Semantic.`, { argumentPath: `/anchorIds/${i}`, targetId: id });
      }
    }
  };

  /**
   * Todo diagrama nasce ancorado. Sem âncora pedida, vale a unidade do repositório do diagrama
   * (ou do projeto ativo); sem projeto pedido, vale o da primeira âncora.
   */
  const anchoring = (projectId: string | undefined, anchorIds: string[] | undefined) => {
    const project = projectId ?? (anchorIds?.length ? store.entity(anchorIds[0]!)?.projectId : undefined) ?? store.activeProject()?.id;
    if (anchorIds?.length) return { projectId: project, anchorIds };
    const repo = project ? repositoryUnit(store.read(), project) : undefined;
    return { projectId: project, anchorIds: repo ? [repo.id] : [] };
  };

  /** Ajusta o tamanho do objeto no canvas ao conteúdo; só cresce, para não desfazer o que o usuário esticou. */
  const fitObject = (diagram: DiagramModel) => {
    const object = store.canvasObject(diagram.id);
    if (!object) return;
    const need = diagramSize(diagram.layout, diagram.caption);
    if (need.width <= object.size.width && need.height <= object.size.height) return;
    store.placeObject({
      ...object,
      size: { width: Math.max(object.size.width, need.width), height: Math.max(object.size.height, need.height) },
    });
  };

  const output = (diagram: DiagramModel) => ({
    diagramId: diagram.id,
    revision: diagram.revision,
    nodeIds: diagram.nodes.map((n) => n.id),
    edgeIds: diagram.edges.map((e) => e.id),
  });

  return [
    {
      operation: "diagram.create",
      argumentsSchema: {
        type: "object",
        required: ["diagramId", "title", "kind", "nodes", "edges"],
        properties: {
          diagramId,
          title: { type: "string", minLength: 1 },
          caption: captionSchema,
          kind: { enum: ["architecture", "flow", "sequence", "dependency", "freeform"] },
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          anchorIds: anchorIdsSchema,
          nodes: { type: "array", items: ref("diagram.schema.json#/$defs/DiagramNode") },
          edges: { type: "array", items: ref("diagram.schema.json#/$defs/DiagramEdge") },
          layout: layoutRequestSchema,
          placement: placementSchema,
        },
        additionalProperties: false,
      },
      check(args) {
        const nodes = args.nodes as DiagramNode[];
        const edges = args.edges as DiagramEdge[];
        checkModel(nodes, edges);
        checkLinks(nodes, edges, "");
        if (args.projectId && !store.project(args.projectId as string)) {
          throw new OperationError("REFERENCE_INVALID", `Projeto '${args.projectId}' não existe.`, { argumentPath: "/projectId" });
        }
        checkAnchors(args.anchorIds as string[] | undefined);
        const regionId = (args.placement as PlacementRequest | undefined)?.regionId;
        if (regionId && !store.region(regionId)) {
          throw new OperationError("REFERENCE_INVALID", `Região '${regionId}' não existe.`, { argumentPath: "/placement/regionId" });
        }
        const existing = store.diagram(args.diagramId as string);
        if (existing && !sameModel(existing, args)) {
          throw new OperationError("PRECONDITION_FAILED", "Já existe um diagrama com esse id e outro conteúdo; use diagram.apply_patch.", {
            targetId: existing.id,
          });
        }
      },
      async handle(args, { request }) {
        const id = args.diagramId as string;
        const existing = store.diagram(id);
        if (existing) return { output: output(existing), changes: [{ id, change: "unchanged", revision: existing.revision }] };
        const requested = (args.layout ?? {}) as { algorithm?: LayoutAlgorithm; direction?: LayoutDirection };
        const nodes = args.nodes as DiagramNode[];
        const edges = args.edges as DiagramEdge[];
        const layout = await computeLayout(
          { nodes, edges, layout: { algorithm: "manual", nodes: {} } },
          { algorithm: requested.algorithm ?? "layered", direction: requested.direction ?? "LR" },
        );
        const { projectId, anchorIds } = anchoring(args.projectId as string | undefined, args.anchorIds as string[] | undefined);
        const model: DiagramModel = {
          id,
          title: args.title as string,
          ...(args.caption ? { caption: args.caption as string } : {}),
          kind: args.kind as DiagramModel["kind"],
          ...(projectId ? { projectId } : {}),
          ...(anchorIds.length ? { anchorIds: anchorIds as NonNullable<DiagramModel["anchorIds"]> } : {}),
          nodes,
          edges,
          layout,
          revision: 0,
        };
        const size = diagramSize(layout, model.caption);
        const saved = store.transact(() => {
          const { rect, regionId, grownRegion } = placeNew(store.read(), size, {
            ...((args.placement ?? {}) as PlacementRequest),
            ...(anchorIds[0] ? { unitId: anchorIds[0] } : {}),
          });
          if (grownRegion) store.putRegion(grownRegion);
          const zIndex = Math.max(0, ...store.read().canvas.objects.map((o) => o.zIndex ?? 0)) + 1;
          const object: CanvasObject = {
            id,
            objectKind: "diagram",
            ...rect,
            zIndex,
            ...(regionId ? { regionId } : {}),
            placedBy: placedBy(request.authorization.actor),
          };
          store.placeObject(object);
          return store.putDiagram(model);
        });
        return {
          output: { ...output(saved), position: store.canvasObject(id)!.position, size: store.canvasObject(id)!.size },
          changes: [{ id, change: "created", revision: saved.revision }],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      operation: "diagram.get",
      readOnly: true,
      argumentsSchema: { type: "object", required: ["diagramId"], properties: { diagramId }, additionalProperties: false },
      handle(args) {
        const diagram = requireDiagram(args.diagramId as string);
        return { output: { diagram: structuredClone(diagram), knowledge: knowledgeOf(store, diagram) }, changes: [] };
      },
    },

    {
      operation: "diagram.apply_patch",
      argumentsSchema: {
        type: "object",
        required: ["diagramId"],
        properties: {
          diagramId,
          ops: ref("diagram.schema.json#/$defs/DiagramPatch/properties/ops"),
          relayout: { type: "boolean", default: true },
          caption: captionSchema,
        },
        additionalProperties: false,
      },
      check(args) {
        const diagram = requireDiagram(args.diagramId as string);
        if (!args.ops && args.caption === undefined) {
          throw new OperationError("INVALID_ARGUMENTS", "Informe ops ou caption.", { argumentPath: "/ops" });
        }
        const { model } = applyPatch(diagram, (args.ops ?? []) as DiagramOp[]);
        checkLinks(model.nodes, model.edges, "/result");
      },
      async handle(args) {
        const diagram = requireDiagram(args.diagramId as string);
        const { model, summary } = applyPatch(diagram, (args.ops ?? []) as DiagramOp[]);
        const captionChanged = typeof args.caption === "string" && args.caption !== (diagram.caption ?? "");
        if (captionChanged) {
          if (args.caption) model.caption = args.caption as string;
          else delete model.caption;
        }
        const changed = captionChanged || Object.values(summary).some((list) => list.length > 0);
        if (!changed) return { output: { ...output(diagram), ...summary }, changes: [{ id: diagram.id, change: "unchanged", revision: diagram.revision }] };
        if (args.relayout !== false) {
          model.layout = await computeLayout(model, {
            algorithm: model.layout.algorithm,
            ...(model.layout.direction ? { direction: model.layout.direction } : {}),
          });
        } else {
          model.layout = await computeLayout(model, { algorithm: "manual" });
        }
        const saved = store.transact(() => {
          const out = store.putDiagram(model);
          fitObject(out);
          return out;
        });
        return {
          output: { ...output(saved), ...summary },
          changes: [{ id: saved.id, change: "updated", revision: saved.revision }],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      operation: "diagram.layout",
      argumentsSchema: {
        type: "object",
        required: ["diagramId", "algorithm"],
        properties: {
          diagramId,
          algorithm: { enum: ["manual", "layered", "force", "grid"] },
          direction: { enum: ["LR", "RL", "TB", "BT"] },
          respectPinned: { type: "boolean", default: true },
        },
        additionalProperties: false,
      },
      check: (args) => void requireDiagram(args.diagramId as string),
      async handle(args) {
        const diagram = requireDiagram(args.diagramId as string);
        const layout = await computeLayout(diagram, {
          algorithm: args.algorithm as LayoutAlgorithm,
          ...(args.direction || diagram.layout.direction ? { direction: (args.direction ?? diagram.layout.direction) as LayoutDirection } : {}),
          respectPinned: args.respectPinned !== false,
        });
        if (sameValue(layout, diagram.layout)) {
          return { output: { layout }, changes: [{ id: diagram.id, change: "unchanged", revision: diagram.revision }] };
        }
        const saved = store.transact(() => {
          const out = store.putDiagram({ ...diagram, layout });
          fitObject(out);
          return out;
        });
        return { output: { layout: saved.layout }, changes: [{ id: saved.id, change: "updated", revision: saved.revision }], workspaceRevision: store.revision };
      },
    },

    {
      // Arrastar um nó: muda só layout.nodes[nodeId] e o fixa (pinned). Nada no Open Semantic muda.
      operation: "diagram.move_node",
      argumentsSchema: {
        type: "object",
        required: ["diagramId", "nodeId", "position"],
        properties: { diagramId, nodeId: ref("common.schema.json#/$defs/NodeId"), position: ref("common.schema.json#/$defs/Point") },
        additionalProperties: false,
      },
      check(args) {
        const diagram = requireDiagram(args.diagramId as string);
        if (!diagram.layout.nodes[args.nodeId as string]) {
          throw new OperationError("TARGET_NOT_FOUND", `Nó ${args.nodeId} não existe no diagrama.`, { targetId: args.nodeId as string });
        }
      },
      handle(args) {
        const diagram = requireDiagram(args.diagramId as string);
        const nodeId = args.nodeId as string;
        const position = args.position as Point;
        const rect = diagram.layout.nodes[nodeId]!;
        const pinned = [...new Set([...(diagram.layout.pinned ?? []), nodeId])];
        const saved = store.transact(() => {
          const out = store.putDiagram({
            ...diagram,
            layout: { ...diagram.layout, nodes: { ...diagram.layout.nodes, [nodeId]: { ...rect, position } }, pinned },
          });
          fitObject(out);
          return out;
        });
        return { output: { position }, changes: [{ id: saved.id, change: "updated", revision: saved.revision }], workspaceRevision: store.revision };
      },
    },

    {
      // Muda as unidades de contexto do diagrama. Ele não sai do lugar sozinho: mover é outro pedido.
      operation: "diagram.anchor",
      argumentsSchema: {
        type: "object",
        required: ["diagramId", "anchorIds"],
        properties: { diagramId, anchorIds: anchorIdsSchema },
        additionalProperties: false,
      },
      check(args) {
        requireDiagram(args.diagramId as string);
        checkAnchors(args.anchorIds as string[]);
      },
      handle(args) {
        const diagram = requireDiagram(args.diagramId as string);
        const anchorIds = args.anchorIds as NonNullable<DiagramModel["anchorIds"]>;
        if (sameValue(diagram.anchorIds ?? [], anchorIds)) {
          return { output: output(diagram), changes: [{ id: diagram.id, change: "unchanged", revision: diagram.revision }] };
        }
        const saved = store.transact(() => store.putDiagram({ ...diagram, anchorIds }));
        return { output: output(saved), changes: [{ id: saved.id, change: "updated", revision: saved.revision }], workspaceRevision: store.revision };
      },
    },

    {
      // Para o agente, sempre com confirmação (política em @open-semantic/core).
      operation: "diagram.delete",
      argumentsSchema: { type: "object", required: ["diagramId"], properties: { diagramId }, additionalProperties: false },
      handle(args) {
        const id = args.diagramId as string;
        if (!store.diagram(id)) return { changes: [{ id, change: "unchanged" }] };
        store.transact(() => store.deleteDiagram(id));
        return { changes: [{ id, change: "deleted" }], workspaceRevision: store.revision };
      },
    },
  ];
}

function sameModel(existing: DiagramModel, args: Record<string, unknown>): boolean {
  return (
    existing.title === args.title &&
    (existing.caption ?? "") === ((args.caption as string | undefined) ?? "") &&
    existing.kind === args.kind &&
    sameValue(existing.nodes, args.nodes) &&
    sameValue(existing.edges, args.edges)
  );
}
