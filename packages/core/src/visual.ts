// Resposta visual: a ferramenta show_diagram e o que o laço precisa para manter a conversa "visual first".
// O modelo descreve só o desenho (caixas, ligações, caminhos que viu e a legenda); daqui sai um lote comum
// que registra as unidades de contexto (verificadas quando há caminho no projeto, inferidas no resto),
// cria ou completa o diagrama ancorado e enquadra o resultado. Tudo passa pelo mesmo executor de lotes.
import { createHash } from "node:crypto";

import type { DiagramModel, WorkspaceSnapshot } from "@open-semantic/protocol";

export const DIAGRAM_KINDS = ["architecture", "flow", "sequence", "dependency"] as const;

export interface ShowDiagramNode {
  id: string;
  label: string;
  kind?: string;
  /** Unidade de contexto que já existe (sem_...). */
  unit?: string;
  /** Pasta ou arquivo do projeto onde o agente viu isso. Com caminho, o nó vira conhecimento verificado. */
  path?: string;
  /** O que foi visto no caminho, em uma frase. */
  seen?: string;
}

export interface ShowDiagramEdge {
  from: string;
  to: string;
  label?: string;
  type?: string;
  /** A ligação aparece no código do caminho do nó de origem. */
  seen?: boolean;
}

export interface ShowDiagramInput {
  diagramId: string;
  title: string;
  kind: DiagramModel["kind"];
  caption: string;
  projectId?: string;
  about?: string;
  direction?: "LR" | "TB";
  nodes: ShowDiagramNode[];
  edges?: ShowDiagramEdge[];
  remove?: string[];
}

export interface BatchStepInput {
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
  dependsOn?: string[];
}

export interface ResolvedPath {
  artifactId: string;
  kind: "directory" | "file" | "process";
}

export interface ShowDiagramPlan {
  intent: string;
  steps: BatchStepInput[];
  /** Para o modelo: a unidade e o status de cada nó, e os caminhos que não existiam. */
  nodes: Record<string, { unit: string; knowledge: "verified" | "inferred" }>;
  notes: string[];
}

const ENTITY_KINDS = new Set([
  "repository",
  "application",
  "module",
  "service",
  "component",
  "api",
  "endpoint",
  "data_store",
  "file",
  "directory",
  "process",
  "concept",
  "decision",
  "requirement",
]);
const RELATION_TYPES = new Set([
  "contains",
  "implements",
  "depends_on",
  "calls",
  "communicates_with",
  "reads",
  "writes",
  "exposes",
  "tests",
  "documents",
  "decided_by",
  "represents",
]);
const KIND_ALIASES: Record<string, string> = {
  database: "data_store",
  db: "data_store",
  store: "data_store",
  table: "data_store",
  controller: "component",
  repository_class: "component",
  class: "component",
  package: "module",
  layer: "module",
  app: "application",
  user: "x-actor",
  person: "x-actor",
  actor: "x-actor",
  external: "x-external",
  system: "x-external",
  queue: "x-queue",
};

/** Texto livre em id legível: minúsculas, sem acento, só letras, dígitos e _. */
export function slug(text: string, max = 40): string {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^(nd|sem|dgm|edg|rel|evd|prj)_/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/, "");
  return s.length >= 3 ? s : `${s || "x"}_${hash(text, 4)}`;
}

function hash(text: string, size = 8): string {
  return createHash("sha256").update(text).digest("hex").slice(0, size);
}

/** Id com prefixo, dentro do limite de 64 caracteres depois do prefixo. */
function idOf(prefix: string, ...parts: string[]): string {
  const body = parts.join("_");
  return `${prefix}_${body.length <= 60 ? body : `${body.slice(0, 51)}_${hash(body)}`}`;
}

function entityKind(kind: string | undefined): string {
  const k = (kind ?? "component").toLowerCase().trim();
  if (ENTITY_KINDS.has(k)) return k;
  if (KIND_ALIASES[k]) return KIND_ALIASES[k]!;
  if (/^x-[a-z][a-z0-9_]*$/.test(k)) return k;
  const s = k.replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "");
  return s ? `x-${s}` : "component";
}

function relationType(type: string | undefined, diagramKind: DiagramModel["kind"]): string {
  const t = (type ?? "").toLowerCase().trim();
  if (RELATION_TYPES.has(t) || /^x-[a-z][a-z0-9_]*$/.test(t)) return t;
  return diagramKind === "flow" || diagramKind === "sequence" ? "calls" : "depends_on";
}

const normalized = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Tira o "./" e as barras das pontas; um ponto que faz parte do nome (".github") fica. */
export function cleanPath(path: string): string {
  return path.trim().replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
}

/**
 * Monta o lote de uma resposta visual. `resolve` acha o artefato de um caminho do projeto (ou undefined).
 * Lança erro com mensagem para o modelo quando a entrada não serve.
 */
export async function planShowDiagram(
  input: ShowDiagramInput,
  snapshot: WorkspaceSnapshot,
  project: { id: string },
  resolve: (path: string) => Promise<ResolvedPath | undefined>,
): Promise<ShowDiagramPlan> {
  if (!/^dgm_[A-Za-z0-9_-]{3,64}$/.test(input.diagramId ?? "")) throw new Error("diagramId precisa ser dgm_ seguido de 3 a 64 letras, dígitos, _ ou -.");
  if (!input.title?.trim()) throw new Error("Informe o título do diagrama.");
  if (!DIAGRAM_KINDS.includes(input.kind as (typeof DIAGRAM_KINDS)[number])) throw new Error(`kind precisa ser um de: ${DIAGRAM_KINDS.join(", ")}.`);
  if (!Array.isArray(input.nodes) || !input.nodes.length) throw new Error("O diagrama precisa de pelo menos um nó.");
  const caption = (input.caption ?? "").trim().slice(0, 600);

  const existing = snapshot.diagrams.find((d) => d.id === input.diagramId);
  const pid = existing?.projectId ?? project.id;
  const projectName = snapshot.projects.find((p) => p.id === pid)?.name ?? pid;
  const projectSlug = slug(projectName, 20);
  const notes: string[] = [];

  // Nós: id estável no diagrama e a unidade de contexto de cada um.
  const nodeIdOf = new Map<string, string>();
  const nodes = input.nodes.map((n) => {
    const short = (n.id ?? "").replace(/^nd_/, "");
    const id = existing?.nodes.some((e) => e.id === n.id) ? n.id : `nd_${slug(short.length >= 3 ? short : n.label)}`;
    if (nodeIdOf.has(n.id)) throw new Error(`Nó '${n.id}' repetido.`);
    nodeIdOf.set(n.id, id);
    nodeIdOf.set(id, id);
    return { ...n, id };
  });
  const entityByName = new Map(
    snapshot.semantic.entities.filter((e) => e.projectId === pid && e.kind !== "repository").map((e) => [normalized(e.name), e]),
  );
  const entityById = new Map(snapshot.semantic.entities.map((e) => [e.id, e]));

  const observations: BatchStepInput[] = [];
  const inferredEntities: Record<string, unknown>[] = [];
  const unitOf = new Map<string, string>();
  const knowledge: ShowDiagramPlan["nodes"] = {};
  const observedFrom = new Map<string, string>(); // nó → passo de observação

  for (const n of nodes) {
    const previous = existing?.nodes.find((e) => e.id === n.id)?.semanticEntityId;
    const given = n.unit && entityById.has(n.unit) ? n.unit : undefined;
    if (n.unit && !given) notes.push(`A unidade ${n.unit} não existe; criei outra para '${n.label}'.`);
    const reused = given ?? previous ?? entityByName.get(normalized(n.label))?.id;
    let unit = reused ?? idOf("sem", projectSlug, slug(n.label));
    // Um id igual de outro projeto não é a mesma coisa.
    if (!reused && entityById.get(unit) && entityById.get(unit)!.projectId !== pid) unit = idOf("sem", projectSlug, slug(n.label), hash(pid, 6));
    unitOf.set(n.id, unit);
    const current = entityById.get(unit);

    const path = n.path ? cleanPath(n.path) : undefined;
    const artifact = path !== undefined ? await resolve(path) : undefined;
    if (path !== undefined && !artifact) notes.push(`O caminho '${n.path}' não existe no projeto; '${n.label}' ficou como suposição.`);

    const entity = { id: unit, kind: current?.kind ?? entityKind(n.kind), name: current?.name ?? n.label, projectId: pid };
    if (artifact) {
      const summary = (n.seen?.trim() || `${n.label} visto em ${path || "raiz do projeto"}.`).slice(0, 2000);
      const stepId = `obs_${observations.length + 1}_${slug(n.id, 50)}`;
      observations.push({
        id: stepId,
        operation: "semantic.upsert_observation",
        arguments: {
          entity: { ...entity, artifactIds: [artifact.artifactId] },
          evidence: {
            id: idOf("evd", slug(n.label, 30), hash(`${artifact.artifactId}|${summary}`)),
            kind: artifact.kind === "directory" ? "directory_listing" : "file_inspection",
            artifactId: artifact.artifactId,
            summary,
          },
        },
      });
      observedFrom.set(n.id, stepId);
      knowledge[n.id] = { unit, knowledge: "verified" };
    } else {
      if (!current) inferredEntities.push(entity);
      knowledge[n.id] = { unit, knowledge: current?.status === "verified" ? "verified" : "inferred" };
    }
  }

  // Ligações podem apontar também para nós que o diagrama já tinha.
  for (const old of existing?.nodes ?? []) {
    if (!nodeIdOf.has(old.id)) nodeIdOf.set(old.id, old.id);
    if (!unitOf.has(old.id) && old.semanticEntityId) unitOf.set(old.id, old.semanticEntityId);
  }

  // Ligações: viram relações (verificadas quando vistas no código da origem) e arestas do diagrama.
  const inferredRelations: Record<string, unknown>[] = [];
  const drawn = new Set<string>();
  const edges = (input.edges ?? []).flatMap((e, i) => {
    const source = nodeIdOf.get(e.from) ?? nodeIdOf.get(`nd_${slug(e.from)}`);
    const target = nodeIdOf.get(e.to) ?? nodeIdOf.get(`nd_${slug(e.to)}`);
    if (!source || !unitOf.has(source)) throw new Error(`edges[${i}].from '${e.from}' não é um nó deste diagrama.`);
    if (!target || !unitOf.has(target)) throw new Error(`edges[${i}].to '${e.to}' não é um nó deste diagrama.`);
    if (drawn.has(`${source}>${target}`)) return [];
    drawn.add(`${source}>${target}`);
    const type = relationType(e.type, input.kind);
    const sourceUnit = unitOf.get(source)!;
    const targetUnit = unitOf.get(target)!;
    const known = snapshot.semantic.relations.find((r) => r.sourceId === sourceUnit && r.targetId === targetUnit && r.type === type);
    const relation = { id: known?.id ?? idOf("rel", slug(sourceUnit, 25), type.replace(/^x-/, "x_"), slug(targetUnit, 25)), type, sourceId: sourceUnit, targetId: targetUnit };
    const observed = e.seen ? observedFrom.get(source) : undefined;
    if (observed) {
      const step = observations.find((s) => s.id === observed)!;
      step.arguments.relations = [...((step.arguments.relations as unknown[]) ?? []), relation];
    } else if (!known) {
      inferredRelations.push(relation);
    }
    const id = existing?.edges.find((x) => x.sourceNodeId === source && x.targetNodeId === target)?.id ?? idOf("edg", source.slice(3), target.slice(3));
    return [{ id, sourceNodeId: source, targetNodeId: target, ...(e.label ? { label: e.label } : {}), semanticRelationId: relation.id }];
  });

  // Uma observação que já está registrada (mesma evidência, entidade verificada, nenhuma relação nova) não se repete.
  const evidenceIds = new Set(snapshot.semantic.evidence.map((e) => e.id));
  const fresh = observations.filter((o) => {
    const args = o.arguments as { entity: { id: string }; evidence: { id: string }; relations?: { id: string }[] };
    const relationsKnown = (args.relations ?? []).every((r) => snapshot.semantic.relations.some((x) => x.id === r.id && x.status === "verified"));
    return !(evidenceIds.has(args.evidence.id) && entityById.get(args.entity.id)?.status === "verified" && relationsKnown);
  });
  observations.length = 0;
  observations.push(...fresh);

  // Ordem: suposições de entidades, observações (com as relações vistas), suposições de relações, diagrama, enquadramento.
  const steps: BatchStepInput[] = [];
  const rationale = `Suposição do agente ao montar o diagrama “${input.title}”; ainda sem evidência no código.`;
  if (inferredEntities.length) {
    steps.push({ id: "infer_units", operation: "semantic.upsert_inference", arguments: { entities: inferredEntities, confidence: 0.6, rationale } });
  }
  for (const o of observations) steps.push({ ...o, ...(inferredEntities.length ? { dependsOn: ["infer_units"] } : {}) });
  const semanticSteps = steps.map((s) => s.id);
  if (inferredRelations.length) {
    steps.push({
      id: "infer_links",
      operation: "semantic.upsert_inference",
      arguments: { relations: inferredRelations, confidence: 0.6, rationale },
      ...(semanticSteps.length ? { dependsOn: [...semanticSteps] } : {}),
    });
  }
  const before = steps.map((s) => s.id);
  const diagramNodes = nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind?.trim() || "component", semanticEntityId: unitOf.get(n.id)! }));

  let drew = false;
  if (!existing) {
    const about = input.about ? (unitOf.get(nodeIdOf.get(input.about) ?? "") ?? input.about) : undefined;
    if (about && !entityById.has(about) && ![...unitOf.values()].includes(about)) notes.push(`A unidade ${input.about} não existe; ancorei o diagrama no repositório.`);
    const anchor = about && (entityById.has(about) || [...unitOf.values()].includes(about)) ? about : undefined;
    steps.push({
      id: "draw",
      operation: "diagram.create",
      arguments: {
        diagramId: input.diagramId,
        title: input.title,
        kind: input.kind,
        projectId: pid,
        ...(anchor ? { anchorIds: [anchor] } : {}),
        ...(caption ? { caption } : {}),
        nodes: diagramNodes,
        edges,
        layout: { algorithm: "layered", direction: input.direction ?? (input.kind === "architecture" || input.kind === "dependency" ? "TB" : "LR") },
      },
      ...(before.length ? { dependsOn: before } : {}),
    });
    drew = true;
  } else {
    const ops: Record<string, unknown>[] = [];
    for (const id of input.remove ?? []) {
      const nodeId = nodeIdOf.get(id) ?? (existing.nodes.some((n) => n.id === id) ? id : undefined);
      if (nodeId && existing.nodes.some((n) => n.id === nodeId)) ops.push({ op: "remove_node", nodeId });
    }
    for (const n of diagramNodes) {
      const old = existing.nodes.find((x) => x.id === n.id);
      if (!old) ops.push({ op: "add_node", node: n });
      else if (old.label !== n.label || old.kind !== n.kind || old.semanticEntityId !== n.semanticEntityId) {
        ops.push({ op: "update_node", nodeId: n.id, set: { label: n.label, kind: n.kind, semanticEntityId: n.semanticEntityId } });
      }
    }
    for (const e of edges) {
      const old = existing.edges.find((x) => x.id === e.id);
      if (!old) ops.push({ op: "add_edge", edge: e });
      else if ((old.label ?? "") !== (e.label ?? "") || old.semanticRelationId !== e.semanticRelationId) {
        ops.push({ op: "update_edge", edgeId: e.id, set: { label: e.label ?? null, semanticRelationId: e.semanticRelationId } });
      }
    }
    const captionChanged = caption && caption !== (existing.caption ?? "");
    if (ops.length || captionChanged) {
      steps.push({
        id: "draw",
        operation: "diagram.apply_patch",
        arguments: { diagramId: existing.id, ...(ops.length ? { ops } : {}), ...(captionChanged ? { caption } : {}) },
        ...(before.length ? { dependsOn: before } : {}),
      });
      drew = true;
    }
  }
  steps.push({
    id: "show",
    operation: "navigation.frame",
    arguments: { targets: { visualIds: [input.diagramId] }, intent: "focus", highlight: true, reason: input.title.slice(0, 120) },
    ...(drew ? { dependsOn: ["draw"] } : {}),
  });

  return { intent: `${existing ? "Completar" : "Desenhar"} o diagrama ${input.title}`.slice(0, 200), steps, nodes: knowledge, notes };
}

/** Revisão de cada diagrama, para saber o que um pedido desenhou ou mudou. */
export function diagramRevisions(snapshot: WorkspaceSnapshot): Map<string, number> {
  return new Map(snapshot.diagrams.map((d) => [d.id, d.revision]));
}

export function changedDiagrams(before: Map<string, number>, snapshot: WorkspaceSnapshot): string[] {
  return snapshot.diagrams.filter((d) => before.get(d.id) !== d.revision).map((d) => d.id);
}

const EXPLAIN = [
  /\bexpli(que|ca|car|cacao|ca-me|que-me)\b/,
  /\bcomo (funciona|e organizad|esta organizad|se organiza|e a arquitetura|flui|passa)/,
  /\bdesenh[ae]\b/,
  /\b(arquitetura|fluxo|visao geral|overview|estrutura|dependencias|camadas)\b/,
  /\bo que (e|faz) (o|a|esse|essa|este|esta) (projeto|repositorio|sistema|aplicacao|app|modulo|servico)\b/,
  /\b(entender|compreender|conhecer) (o|a|esse|essa|este|esta)\b/,
  /\bpor onde (passa|anda|vai)\b/,
  /\b(explain|how does|walk me through|overview|architecture)\b/,
];

/**
 * O pedido é de entendimento de estrutura ou fluxo (a resposta deve ser um diagrama)?
 * Pergunta pontual ("qual a versão do Java?") não entra: a resposta é uma linha de texto.
 */
export function asksForExplanation(message: string): boolean {
  const text = normalized(message);
  return EXPLAIN.some((re) => re.test(text));
}

/** Mensagem do app para o modelo quando uma explicação terminou sem diagrama. Vai uma vez por pedido. */
export const VISUAL_NUDGE =
  "[app] Este pedido é de entendimento de estrutura ou fluxo e a resposta terminou sem diagrama. Responda desenhando: chame show_diagram (se já existe diagrama sobre o assunto no <workspace>, use o mesmo diagramId para completá-lo) com o que você já leu, e deixe o texto final como uma legenda curta que cita as caixas do desenho.";

export const isAppNote = (text: string) => text.startsWith("[app] ");

export const SHOW_DIAGRAM_TOOL = {
  name: "show_diagram",
  description:
    "Your main way to answer. Draws (or completes) a diagram on the canvas, anchored to its subject, and frames it for the user. Send only the picture: boxes, links, the project paths where you saw each box and a short caption. The app records each box as a context unit (verified when it has a path that exists in the project, inferred otherwise; inferred boxes are drawn dashed), creates or patches the diagram and moves the camera to it, in one batch. Calling it again with the same diagramId completes that diagram: new boxes and links are added, existing ones updated, nothing is removed unless listed in remove. Returns the batch result and, for each node, its unit and knowledge status.",
  inputSchema: {
    type: "object",
    required: ["diagramId", "title", "kind", "caption", "nodes"],
    properties: {
      diagramId: { type: "string", description: "dgm_ plus a readable name, e.g. dgm_petclinic_overview. Reuse the id of an existing diagram about the same subject to complete it." },
      title: { type: "string", description: "Short title shown on the diagram, in Portuguese." },
      kind: { enum: [...DIAGRAM_KINDS], description: "architecture: what the system is made of (overview, layers, modules). flow / sequence: how a request or use case moves through the parts. dependency: who depends on whom." },
      caption: { type: "string", maxLength: 600, description: "One to three short sentences in Portuguese that read the diagram for the user, naming its boxes. Shown with the diagram and in the chat." },
      projectId: { type: "string", description: "Only when it is not the active project." },
      about: { type: "string", description: "The context unit the diagram is about: an existing sem_ id, or the id of one of this call's nodes (for a detail diagram of a part). Omit for the whole repository." },
      direction: { enum: ["LR", "TB"], description: "Default: TB for architecture and dependency, LR for flow and sequence." },
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: { type: "string", description: "Short id, e.g. owner or nd_owner." },
            label: { type: "string", description: "Text in the box (short)." },
            kind: { type: "string", description: "service, module, component, api, endpoint, data_store, application, actor, external, queue, concept." },
            unit: { type: "string", description: "Existing context unit (sem_ id from <workspace>) this box represents." },
            path: { type: "string", description: "Folder or file of the project (relative to its root) where you saw this. Makes the box verified. Omit when you only suppose it." },
            seen: { type: "string", description: "What you saw there, in one short sentence (evidence)." },
          },
          additionalProperties: false,
        },
      },
      edges: {
        type: "array",
        maxItems: 60,
        items: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string", description: "Node id." },
            to: { type: "string", description: "Node id." },
            label: { type: "string", description: "Short verb or protocol, e.g. 'usa', 'HTTP', 'grava'." },
            type: { type: "string", description: "depends_on, calls, communicates_with, reads, writes, contains, exposes, implements." },
            seen: { type: "boolean", description: "True when you saw this link in the code at the source node's path." },
          },
          additionalProperties: false,
        },
      },
      remove: { type: "array", items: { type: "string" }, description: "Node ids to take out of an existing diagram (their links go too)." },
    },
    additionalProperties: false,
  },
};
