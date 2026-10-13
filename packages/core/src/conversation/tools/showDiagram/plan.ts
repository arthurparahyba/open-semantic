// O plano do show_diagram, em etapas: confere a entrada, dá id a cada nó, liga cada nó a uma unidade de contexto,
// transforma as ligações em relações, deixa de fora observações já registradas e monta o desenho (draw.ts).
import type { DiagramModel, SemanticEntity, WorkspaceSnapshot } from "@open-semantic/protocol";

import { hash, normalized, slug } from "../../text.js";
import { cleanPath } from "../project.js";
import { drawStep, frameStep, semanticSteps } from "./draw.js";
import { entityKind, idOf, relationType } from "./naming.js";
import {
  DIAGRAM_KINDS,
  type BatchStepInput,
  type PlannedEdge,
  type ResolvedPath,
  type ShowDiagramEdge,
  type ShowDiagramInput,
  type ShowDiagramNode,
  type ShowDiagramPlan,
} from "./types.js";

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
  const caption = checkInput(input);
  const planner = new DiagramPlanner(input, snapshot, project.id);
  await planner.linkUnits(resolve);
  return planner.plan(caption);
}

/** A entrada serve para desenhar? Devolve a legenda limpa. */
function checkInput(input: ShowDiagramInput): string {
  if (!/^dgm_[A-Za-z0-9_-]{3,64}$/.test(input.diagramId ?? "")) throw new Error("diagramId precisa ser dgm_ seguido de 3 a 64 letras, dígitos, _ ou -.");
  if (!input.title?.trim()) throw new Error("Informe o título do diagrama.");
  if (!DIAGRAM_KINDS.includes(input.kind as (typeof DIAGRAM_KINDS)[number])) throw new Error(`kind precisa ser um de: ${DIAGRAM_KINDS.join(", ")}.`);
  if (!Array.isArray(input.nodes) || !input.nodes.length) throw new Error("O diagrama precisa de pelo menos um nó.");
  return (input.caption ?? "").trim().slice(0, 600);
}

class DiagramPlanner {
  private readonly notes: string[] = [];
  private readonly existing: DiagramModel | undefined;
  private readonly projectId: string;
  private readonly projectSlug: string;
  private readonly entityById: Map<string, SemanticEntity>;
  /** Id do nó como o modelo escreveu (ou o id final) → id no diagrama. */
  private readonly nodeIdOf = new Map<string, string>();
  /** Nó do diagrama → unidade de contexto. */
  private readonly unitOf = new Map<string, string>();
  /** Nó → passo que registra o que foi visto nele. */
  private readonly observedFrom = new Map<string, string>();
  private readonly observations: BatchStepInput[] = [];
  private readonly inferredEntities: Record<string, unknown>[] = [];
  private readonly inferredRelations: Record<string, unknown>[] = [];
  private readonly knowledge: ShowDiagramPlan["nodes"] = {};
  private readonly nodes: ShowDiagramNode[];

  constructor(
    private readonly input: ShowDiagramInput,
    private readonly snapshot: WorkspaceSnapshot,
    projectId: string,
  ) {
    this.existing = snapshot.diagrams.find((d) => d.id === input.diagramId);
    this.projectId = this.existing?.projectId ?? projectId;
    this.projectSlug = slug(snapshot.projects.find((p) => p.id === this.projectId)?.name ?? this.projectId, 20);
    this.entityById = new Map(snapshot.semantic.entities.map((e) => [e.id, e]));
    this.nodes = input.nodes.map((n) => this.withStableId(n));
  }

  /** Id estável no diagrama: o que o nó já tinha, ou nd_ com o id curto (ou o rótulo) que o modelo deu. */
  private withStableId(n: ShowDiagramNode): ShowDiagramNode {
    const short = (n.id ?? "").replace(/^nd_/, "");
    const id = this.existing?.nodes.some((e) => e.id === n.id) ? n.id : `nd_${slug(short.length >= 3 ? short : n.label)}`;
    if (this.nodeIdOf.has(n.id)) throw new Error(`Nó '${n.id}' repetido.`);
    this.nodeIdOf.set(n.id, id);
    this.nodeIdOf.set(id, id);
    return { ...n, id };
  }

  /** Liga cada nó a uma unidade: verificada quando o caminho existe no projeto, suposta no resto. */
  async linkUnits(resolve: (path: string) => Promise<ResolvedPath | undefined>) {
    const byName = new Map(
      this.snapshot.semantic.entities.filter((e) => e.projectId === this.projectId && e.kind !== "repository").map((e) => [normalized(e.name), e]),
    );
    for (const n of this.nodes) {
      const unit = this.unitFor(n, byName);
      this.unitOf.set(n.id, unit);
      const path = n.path ? cleanPath(n.path) : undefined;
      const artifact = path === undefined ? undefined : await resolve(path);
      if (path !== undefined && !artifact) this.notes.push(`O caminho '${n.path}' não existe no projeto; '${n.label}' ficou como suposição.`);
      if (artifact) this.observe(n, unit, artifact, path ?? "");
      else this.suppose(n, unit);
    }
  }

  /** A unidade do nó: a que o modelo indicou, a que o nó já tinha, a de mesmo nome no projeto, ou uma nova. */
  private unitFor(n: ShowDiagramNode, byName: Map<string, SemanticEntity>): string {
    const previous = this.existing?.nodes.find((e) => e.id === n.id)?.semanticEntityId;
    const given = n.unit && this.entityById.has(n.unit) ? n.unit : undefined;
    if (n.unit && !given) this.notes.push(`A unidade ${n.unit} não existe; criei outra para '${n.label}'.`);
    const reused = given ?? previous ?? byName.get(normalized(n.label))?.id;
    if (reused !== undefined) return reused;
    const unit = idOf("sem", this.projectSlug, slug(n.label));
    // Um id igual de outro projeto não é a mesma coisa.
    const taken = this.entityById.get(unit);
    return taken && taken.projectId !== this.projectId ? idOf("sem", this.projectSlug, slug(n.label), hash(this.projectId, 6)) : unit;
  }

  private entityOf(n: ShowDiagramNode, unit: string) {
    const current = this.entityById.get(unit);
    return { id: unit, kind: current?.kind ?? entityKind(n.kind), name: current?.name ?? n.label, projectId: this.projectId };
  }

  /** Visto no projeto: vira observação (verificada), com a evidência do caminho. */
  private observe(n: ShowDiagramNode, unit: string, artifact: ResolvedPath, path: string) {
    const summary = (n.seen?.trim() || `${n.label} visto em ${path || "raiz do projeto"}.`).slice(0, 2000);
    const stepId = `obs_${this.observations.length + 1}_${slug(n.id, 50)}`;
    this.observations.push({
      id: stepId,
      operation: "semantic.upsert_observation",
      arguments: {
        entity: { ...this.entityOf(n, unit), artifactIds: [artifact.artifactId] },
        evidence: {
          id: idOf("evd", slug(n.label, 30), hash(`${artifact.artifactId}|${summary}`)),
          kind: artifact.kind === "directory" ? "directory_listing" : "file_inspection",
          artifactId: artifact.artifactId,
          summary,
        },
      },
    });
    this.observedFrom.set(n.id, stepId);
    this.knowledge[n.id] = { unit, knowledge: "verified" };
  }

  /** Sem caminho visto: uma unidade nova é suposição; uma que já existe fica com o que já se sabe dela. */
  private suppose(n: ShowDiagramNode, unit: string) {
    const current = this.entityById.get(unit);
    if (!current) this.inferredEntities.push(this.entityOf(n, unit));
    this.knowledge[n.id] = { unit, knowledge: current?.status === "verified" ? "verified" : "inferred" };
  }

  /** Ligações, ordem dos passos, desenho e enquadramento. */
  plan(caption: string): ShowDiagramPlan {
    this.includeExistingNodes();
    const edges = this.linkEdges();
    const work = { inferredEntities: this.inferredEntities, observations: this.freshObservations(), inferredRelations: this.inferredRelations };
    const steps = semanticSteps(this.input.title, work);
    const units = new Set(this.unitOf.values());
    const draw = drawStep(
      {
        input: this.input,
        existing: this.existing,
        projectId: this.projectId,
        caption,
        nodes: this.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind?.trim() || "component", semanticEntityId: this.unitOf.get(n.id)! })),
        edges,
        nodeIdOf: (ref) => this.nodeIdOf.get(ref),
        unitOf: (nodeId) => this.unitOf.get(nodeId),
        isUnit: (id) => this.entityById.has(id) || units.has(id),
        notes: this.notes,
      },
      steps.map((s) => s.id),
    );
    if (draw) steps.push(draw);
    steps.push(frameStep(this.input, draw !== undefined));
    return { intent: `${this.existing ? "Completar" : "Desenhar"} o diagrama ${this.input.title}`.slice(0, 200), steps, nodes: this.knowledge, notes: this.notes };
  }

  /** Ligações podem apontar também para nós que o diagrama já tinha. */
  private includeExistingNodes() {
    for (const old of this.existing?.nodes ?? []) {
      if (!this.nodeIdOf.has(old.id)) this.nodeIdOf.set(old.id, old.id);
      if (!this.unitOf.has(old.id) && old.semanticEntityId) this.unitOf.set(old.id, old.semanticEntityId);
    }
  }

  /** Ligações viram relações (verificadas quando vistas no código da origem) e arestas do diagrama. */
  private linkEdges(): PlannedEdge[] {
    const drawn = new Set<string>();
    return (this.input.edges ?? []).flatMap((e, i) => {
      const source = this.endpoint(e.from, `edges[${i}].from`);
      const target = this.endpoint(e.to, `edges[${i}].to`);
      if (drawn.has(`${source}>${target}`)) return [];
      drawn.add(`${source}>${target}`);
      const relation = this.relate(e, source, target);
      const id = this.existing?.edges.find((x) => x.sourceNodeId === source && x.targetNodeId === target)?.id ?? idOf("edg", source.slice(3), target.slice(3));
      return [{ id, sourceNodeId: source, targetNodeId: target, ...(e.label ? { label: e.label } : {}), semanticRelationId: relation.id }];
    });
  }

  /** O nó de uma ponta da ligação, pelo id que o modelo deu ou pelo id final. */
  private endpoint(ref: string, at: string): string {
    const node = this.nodeIdOf.get(ref) ?? this.nodeIdOf.get(`nd_${slug(ref)}`);
    if (!node || !this.unitOf.has(node)) throw new Error(`${at} '${ref}' não é um nó deste diagrama.`);
    return node;
  }

  /** A relação da ligação: a que já liga as duas unidades, ou uma nova, vista (vai na observação da origem) ou suposta. */
  private relate(e: ShowDiagramEdge, source: string, target: string) {
    const type = relationType(e.type, this.input.kind);
    const sourceId = this.unitOf.get(source)!;
    const targetId = this.unitOf.get(target)!;
    const known = this.snapshot.semantic.relations.find((r) => r.sourceId === sourceId && r.targetId === targetId && r.type === type);
    const relation = { id: known?.id ?? idOf("rel", slug(sourceId, 25), type.replace(/^x-/, "x_"), slug(targetId, 25)), type, sourceId, targetId };
    const observed = e.seen ? this.observedFrom.get(source) : undefined;
    if (observed) {
      const step = this.observations.find((s) => s.id === observed)!;
      step.arguments.relations = [...((step.arguments.relations as unknown[]) ?? []), relation];
    } else if (!known) {
      this.inferredRelations.push(relation);
    }
    return relation;
  }

  /** Uma observação já registrada (mesma evidência, entidade verificada, nenhuma relação nova) não se repete. */
  private freshObservations(): BatchStepInput[] {
    const { evidence, relations } = this.snapshot.semantic;
    const evidenceIds = new Set(evidence.map((e) => e.id));
    const verified = (id: string) => relations.some((x) => x.id === id && x.status === "verified");
    return this.observations.filter((o) => {
      const args = o.arguments as { entity: { id: string }; evidence: { id: string }; relations?: { id: string }[] };
      const recorded = evidenceIds.has(args.evidence.id) && this.entityById.get(args.entity.id)?.status === "verified";
      return !(recorded && (args.relations ?? []).every((r) => verified(r.id)));
    });
  }
}
