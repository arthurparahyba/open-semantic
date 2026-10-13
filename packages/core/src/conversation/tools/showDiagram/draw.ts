// O fim do plano do show_diagram: a ordem dos passos semânticos, o desenho (diagrama novo, ou só o que mudou)
// e o enquadramento.
import type { DiagramModel } from "@open-semantic/protocol";

import type { BatchStepInput, PlannedEdge, PlannedNode, ShowDiagramInput } from "./types.js";

/** O que vira passo semântico. */
export interface SemanticWork {
  inferredEntities: Record<string, unknown>[];
  /** Observações com as relações vistas no código. */
  observations: BatchStepInput[];
  inferredRelations: Record<string, unknown>[];
}

/** Suposições de entidades, observações e suposições de relações, nessa ordem e cada grupo depois do anterior. */
export function semanticSteps(title: string, work: SemanticWork): BatchStepInput[] {
  const steps: BatchStepInput[] = [];
  const rationale = `Suposição do agente ao montar o diagrama “${title}”; ainda sem evidência no código.`;
  const inferUnits = work.inferredEntities.length > 0;
  if (inferUnits) {
    steps.push({ id: "infer_units", operation: "semantic.upsert_inference", arguments: { entities: work.inferredEntities, confidence: 0.6, rationale } });
  }
  for (const o of work.observations) steps.push({ ...o, ...(inferUnits ? { dependsOn: ["infer_units"] } : {}) });
  const before = steps.map((s) => s.id);
  if (work.inferredRelations.length) {
    steps.push({
      id: "infer_links",
      operation: "semantic.upsert_inference",
      arguments: { relations: work.inferredRelations, confidence: 0.6, rationale },
      ...(before.length ? { dependsOn: before } : {}),
    });
  }
  return steps;
}

/** O desenho a fazer. */
export interface Drawing {
  input: ShowDiagramInput;
  existing: DiagramModel | undefined;
  projectId: string;
  caption: string;
  nodes: PlannedNode[];
  edges: PlannedEdge[];
  /** O id no diagrama de um nó, pelo id que o modelo deu ou pelo id final (inclui os nós que o diagrama já tinha). */
  nodeIdOf(ref: string): string | undefined;
  /** A unidade de um nó do diagrama. */
  unitOf(nodeId: string): string | undefined;
  /** A unidade existe no workspace ou entra com este plano. */
  isUnit(id: string): boolean;
  notes: string[];
}

/** diagram.create para um diagrama novo; diagram.apply_patch só com o que mudou; nenhum passo se nada mudou. */
export function drawStep(d: Drawing, dependsOn: string[]): BatchStepInput | undefined {
  const step = d.existing ? patchStep(d, d.existing) : createStep(d);
  return step && { ...step, ...(dependsOn.length ? { dependsOn } : {}) };
}

/** Enquadra o diagrama, depois do desenho quando houve um. */
export function frameStep(input: ShowDiagramInput, drew: boolean): BatchStepInput {
  return {
    id: "show",
    operation: "navigation.frame",
    arguments: { targets: { visualIds: [input.diagramId] }, intent: "focus", highlight: true, reason: input.title.slice(0, 120) },
    ...(drew ? { dependsOn: ["draw"] } : {}),
  };
}

function createStep(d: Drawing): BatchStepInput {
  const { input } = d;
  // O assunto do diagrama: uma unidade, ou um nó desta chamada (diagrama de detalhe de uma parte).
  const about = input.about ? (d.unitOf(d.nodeIdOf(input.about) ?? "") ?? input.about) : undefined;
  const anchor = about && d.isUnit(about) ? about : undefined;
  if (about && !anchor) d.notes.push(`A unidade ${input.about} não existe; ancorei o diagrama no repositório.`);
  return {
    id: "draw",
    operation: "diagram.create",
    arguments: {
      diagramId: input.diagramId,
      title: input.title,
      kind: input.kind,
      projectId: d.projectId,
      ...(anchor ? { anchorIds: [anchor] } : {}),
      ...(d.caption ? { caption: d.caption } : {}),
      nodes: d.nodes,
      edges: d.edges,
      layout: layoutOf(input),
    },
  };
}

/** Cada tipo tem a sua gramática visual; os de caixas e setas usam o layout em camadas do ELK. */
function layoutOf(input: ShowDiagramInput): { algorithm: string; direction?: string } {
  if (input.kind === "layers") return { algorithm: "lanes" };
  if (input.kind === "sequence") return { algorithm: "sequence" };
  if (input.kind === "tree") return { algorithm: "tree", direction: "TB" };
  return { algorithm: "layered", direction: input.direction ?? (input.kind === "architecture" || input.kind === "dependency" ? "TB" : "LR") };
}

function patchStep(d: Drawing, existing: DiagramModel): BatchStepInput | undefined {
  const ops = [...removeOps(d, existing), ...staleMessages(d, existing), ...nodeOps(d.nodes, existing), ...edgeOps(d.edges, existing)];
  const captionChanged = d.caption && d.caption !== (existing.caption ?? "");
  if (!ops.length && !captionChanged) return undefined;
  return {
    id: "draw",
    operation: "diagram.apply_patch",
    arguments: { diagramId: existing.id, ...(ops.length ? { ops } : {}), ...(captionChanged ? { caption: d.caption } : {}) },
  };
}

/** Só sai o que o modelo pediu para tirar (remove); completar um diagrama não apaga nada. */
function removeOps(d: Drawing, existing: DiagramModel): Record<string, unknown>[] {
  return (d.input.remove ?? [])
    .map((ref) => d.nodeIdOf(ref) ?? ref)
    .filter((nodeId) => existing.nodes.some((n) => n.id === nodeId))
    .map((nodeId) => ({ op: "remove_node", nodeId }));
}

/** Numa sequência a lista de mensagens é a história inteira: as que não vieram de novo saem. */
function staleMessages(d: Drawing, existing: DiagramModel): Record<string, unknown>[] {
  if (existing.kind !== "sequence" || !d.edges.length) return [];
  const kept = new Set(d.edges.map((e) => e.id));
  return existing.edges.filter((e) => !kept.has(e.id)).map((e) => ({ op: "remove_edge", edgeId: e.id }));
}

/** Nós novos entram; os que mudaram de rótulo, tipo ou unidade são atualizados. */
function nodeOps(nodes: PlannedNode[], existing: DiagramModel): Record<string, unknown>[] {
  return nodes.flatMap<Record<string, unknown>>((n) => {
    const old = existing.nodes.find((x) => x.id === n.id);
    if (!old) return [{ op: "add_node", node: n }];
    const changed = old.label !== n.label || old.kind !== n.kind || old.semanticEntityId !== n.semanticEntityId || !sameAttributes(old.attributes, n.attributes);
    return changed
      ? [{ op: "update_node", nodeId: n.id, set: { label: n.label, kind: n.kind, semanticEntityId: n.semanticEntityId, ...(n.attributes ? { attributes: n.attributes } : {}) } }]
      : [];
  });
}

/** Arestas novas entram; as que mudaram de rótulo ou relação são atualizadas. */
function edgeOps(edges: PlannedEdge[], existing: DiagramModel): Record<string, unknown>[] {
  return edges.flatMap<Record<string, unknown>>((e) => {
    const old = existing.edges.find((x) => x.id === e.id);
    if (!old) return [{ op: "add_edge", edge: e }];
    const changed = (old.label ?? "") !== (e.label ?? "") || old.semanticRelationId !== e.semanticRelationId || !sameAttributes(old.attributes, e.attributes);
    return changed
      ? [{ op: "update_edge", edgeId: e.id, set: { label: e.label ?? null, semanticRelationId: e.semanticRelationId ?? null, ...(e.attributes ? { attributes: e.attributes } : {}) } }]
      : [];
  });
}

const sameAttributes = (a?: Record<string, unknown>, b?: Record<string, unknown>) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
