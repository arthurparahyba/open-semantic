import {
  OperationError,
  contractValidator,
  describeErrors,
  sameValue,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type DiagramPatch,
} from "@open-semantic/protocol";

const validateNode = contractValidator("diagram.schema.json#/$defs/DiagramNode");
const validateEdge = contractValidator("diagram.schema.json#/$defs/DiagramEdge");

export type DiagramOp = DiagramPatch["ops"][number];

/** O que um patch mudou, para devolver ao agente exatamente as alterações aplicadas. */
export interface PatchSummary {
  addedNodes: string[];
  updatedNodes: string[];
  removedNodes: string[];
  addedEdges: string[];
  updatedEdges: string[];
  removedEdges: string[];
}

/**
 * Integridade do modelo: ids únicos, arestas entre nós do próprio diagrama, pais existentes e sem ciclo.
 * `path` é o prefixo do argumentPath nos erros (ex.: "" para diagram.create).
 */
export function checkModel(nodes: DiagramNode[], edges: DiagramEdge[], path = ""): void {
  const nodeIds = new Set<string>();
  for (const [i, node] of nodes.entries()) {
    if (nodeIds.has(node.id)) throw invalid(`Nó '${node.id}' repetido.`, `${path}/nodes/${i}/id`);
    nodeIds.add(node.id);
  }
  for (const [i, node] of nodes.entries()) {
    if (node.parentNodeId && !nodeIds.has(node.parentNodeId)) {
      throw invalid(`Nó pai '${node.parentNodeId}' não existe neste diagrama.`, `${path}/nodes/${i}/parentNodeId`);
    }
  }
  const parent = new Map(nodes.map((n) => [n.id, n.parentNodeId]));
  for (const [i, node] of nodes.entries()) {
    const seen = new Set<string>([node.id]);
    let p = parent.get(node.id);
    while (p) {
      if (seen.has(p)) throw invalid(`Agrupamento em ciclo envolvendo '${node.id}'.`, `${path}/nodes/${i}/parentNodeId`);
      seen.add(p);
      p = parent.get(p);
    }
  }
  const edgeIds = new Set<string>();
  for (const [i, edge] of edges.entries()) {
    if (edgeIds.has(edge.id)) throw invalid(`Aresta '${edge.id}' repetida.`, `${path}/edges/${i}/id`);
    edgeIds.add(edge.id);
    for (const end of ["sourceNodeId", "targetNodeId"] as const) {
      if (!nodeIds.has(edge[end])) {
        throw invalid(`Aresta '${edge.id}' aponta para o nó inexistente '${edge[end]}'.`, `${path}/edges/${i}/${end}`);
      }
    }
  }
}

/**
 * Aplica um patch de forma atômica: ou todas as ops valem, ou nenhuma (o modelo original não é tocado).
 * Erros apontam o índice da op (`/ops/3`). Função pura; o layout é tratado à parte.
 */
export function applyPatch(model: DiagramModel, ops: DiagramOp[]): { model: DiagramModel; summary: PatchSummary } {
  const next = structuredClone(model);
  const summary: PatchSummary = { addedNodes: [], updatedNodes: [], removedNodes: [], addedEdges: [], updatedEdges: [], removedEdges: [] };
  const nodeIndex = (id: string, at: string) => {
    const i = next.nodes.findIndex((n) => n.id === id);
    if (i < 0) throw new OperationError("TARGET_NOT_FOUND", `Nó '${id}' não existe no diagrama.`, { argumentPath: at, targetId: id });
    return i;
  };
  const edgeIndex = (id: string, at: string) => {
    const i = next.edges.findIndex((e) => e.id === id);
    if (i < 0) throw new OperationError("TARGET_NOT_FOUND", `Aresta '${id}' não existe no diagrama.`, { argumentPath: at, targetId: id });
    return i;
  };

  for (const [i, op] of ops.entries()) {
    const at = `/ops/${i}`;
    switch (op.op) {
      case "add_node": {
        if (next.nodes.some((n) => n.id === op.node.id)) {
          const same = sameValue(next.nodes.find((n) => n.id === op.node.id), op.node);
          if (same) break; // reaplicar o mesmo patch não duplica
          throw invalid(`Nó '${op.node.id}' já existe com outro conteúdo; use update_node.`, `${at}/node/id`);
        }
        next.nodes.push(structuredClone(op.node));
        summary.addedNodes.push(op.node.id);
        break;
      }
      case "update_node": {
        const idx = nodeIndex(op.nodeId, `${at}/nodeId`);
        const merged = mergeSet(next.nodes[idx]!, op.set) as DiagramNode;
        if (merged.id !== op.nodeId) throw invalid("Não é possível mudar o id de um nó.", `${at}/set/id`);
        if (!validateNode(merged)) throw invalid(describeErrors(validateNode.errors), `${at}/set`);
        next.nodes[idx] = merged;
        summary.updatedNodes.push(op.nodeId);
        break;
      }
      case "remove_node": {
        const idx = nodeIndex(op.nodeId, `${at}/nodeId`);
        next.nodes.splice(idx, 1);
        for (const n of next.nodes) if (n.parentNodeId === op.nodeId) delete n.parentNodeId;
        const removed = next.edges.filter((e) => e.sourceNodeId === op.nodeId || e.targetNodeId === op.nodeId);
        next.edges = next.edges.filter((e) => !removed.includes(e));
        delete next.layout.nodes[op.nodeId];
        if (next.layout.pinned) next.layout.pinned = next.layout.pinned.filter((p) => p !== op.nodeId);
        summary.removedNodes.push(op.nodeId);
        summary.removedEdges.push(...removed.map((e) => e.id));
        break;
      }
      case "add_edge": {
        if (next.edges.some((e) => e.id === op.edge.id)) {
          const same = sameValue(next.edges.find((e) => e.id === op.edge.id), op.edge);
          if (same) break;
          throw invalid(`Aresta '${op.edge.id}' já existe com outro conteúdo; use update_edge.`, `${at}/edge/id`);
        }
        next.edges.push(structuredClone(op.edge));
        summary.addedEdges.push(op.edge.id);
        break;
      }
      case "update_edge": {
        const idx = edgeIndex(op.edgeId, `${at}/edgeId`);
        const merged = mergeSet(next.edges[idx]!, op.set) as DiagramEdge;
        if (merged.id !== op.edgeId) throw invalid("Não é possível mudar o id de uma aresta.", `${at}/set/id`);
        if (!validateEdge(merged)) throw invalid(describeErrors(validateEdge.errors), `${at}/set`);
        next.edges[idx] = merged;
        summary.updatedEdges.push(op.edgeId);
        break;
      }
      case "remove_edge": {
        next.edges.splice(edgeIndex(op.edgeId, `${at}/edgeId`), 1);
        summary.removedEdges.push(op.edgeId);
        break;
      }
      case "bind_node": {
        const idx = nodeIndex(op.nodeId, `${at}/nodeId`);
        next.nodes[idx] = { ...next.nodes[idx]!, semanticEntityId: op.semanticEntityId };
        summary.updatedNodes.push(op.nodeId);
        break;
      }
    }
    try {
      checkModel(next.nodes, next.edges);
    } catch (err) {
      if (err instanceof OperationError) {
        throw new OperationError(err.code, err.message, { argumentPath: at, details: { problem: err.argumentPath } });
      }
      throw err;
    }
  }
  return { model: next, summary };
}

/** `set` substitui campos; `null` remove um campo opcional (ex.: desvincular a entidade). */
function mergeSet<T extends object>(current: T, set: Record<string, unknown>): T {
  const out = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

function invalid(message: string, argumentPath: string) {
  return new OperationError("INVALID_ARGUMENTS", message, { argumentPath });
}

const END_KINDS = new Set(["end", "fim"]);

/**
 * BPMN: todo caminho termina num evento de fim. Tarefa ou decisão sem saída ganha uma seta para o fim
 * (o que já existe, ou um novo na raia dela). O modelo às vezes esquece a última seta; o processo não pode ficar aberto.
 */
export function closeBpmnPaths(nodes: DiagramNode[], edges: DiagramEdge[]): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const hasOut = new Set(edges.map((e) => e.sourceNodeId));
  const dangling = nodes.filter((n) => !hasOut.has(n.id) && !END_KINDS.has(n.kind) && n.kind !== "start" && n.kind !== "inicio");
  if (!dangling.length || !nodes.some((n) => n.kind === "start" || n.kind === "inicio")) return { nodes, edges };
  let end = nodes.find((n) => END_KINDS.has(n.kind));
  const outNodes = [...nodes];
  if (!end) {
    const ids = new Set(nodes.map((n) => n.id));
    let id = "nd_fim";
    for (let i = 2; ids.has(id); i++) id = `nd_fim_${i}`;
    const layer = dangling[0]!.attributes?.layer;
    end = { id, label: "Fim", kind: "end", ...(layer !== undefined ? { attributes: { layer } } : {}) } as DiagramNode;
    outNodes.push(end);
  }
  const edgeIds = new Set(edges.map((e) => e.id));
  const added = dangling.map((n) => {
    let id = `edg_${n.id.replace(/^nd_/, "")}_fim`;
    for (let i = 2; edgeIds.has(id); i++) id = `edg_${n.id.replace(/^nd_/, "")}_fim_${i}`;
    edgeIds.add(id);
    return { id, sourceNodeId: n.id, targetNodeId: end!.id } as DiagramEdge;
  });
  return { nodes: outNodes, edges: [...edges, ...added] };
}
