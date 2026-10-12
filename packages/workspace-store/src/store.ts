import type {
  ArtifactReference,
  Camera,
  CanvasObject,
  DiagramModel,
  Evidence,
  ModInstance,
  NavigationState,
  Project,
  Region,
  SemanticEntity,
  SemanticRelation,
  WorkspaceSnapshot,
} from "@open-semantic/protocol";

export type ChangeListener = (revision: number) => void;

export interface CreateWorkspaceOptions {
  id: string;
  name: string;
  now?: () => Date;
}

/** Snapshot vazio e válido segundo contracts/schemas/workspace.schema.json. */
export function emptySnapshot({ id, name, now = () => new Date() }: CreateWorkspaceOptions): WorkspaceSnapshot {
  const at = now().toISOString();
  return {
    schemaVersion: "0.2",
    workspace: {
      id,
      name,
      revision: 0,
      projectIds: [],
      settings: { autoNavigate: true, userHoldMs: 4000, agentMayDeleteMods: false },
      createdAt: at,
      updatedAt: at,
    },
    projects: [],
    artifacts: [],
    semantic: { entities: [], relations: [], evidence: [] },
    mods: [],
    diagrams: [],
    canvas: { objects: [], regions: [] },
    navigation: {
      camera: { center: { x: 0, y: 0 }, zoom: 1 },
      focus: {},
      history: [],
      motion: { status: "idle" },
      control: { mode: "shared" },
    },
  };
}

/**
 * Fonte de verdade do que é visual e espacial (docs/funcionalidades/01-workspace-e-canvas.md).
 * Mudanças acontecem dentro de transact(); cada transação vira uma revisão do workspace.
 */
export class WorkspaceStore {
  private doc: WorkspaceSnapshot;
  private readonly listeners = new Set<ChangeListener>();
  private readonly now: () => Date;
  private depth = 0;
  private dirty = false;

  constructor(doc: WorkspaceSnapshot, options: { now?: () => Date } = {}) {
    this.doc = structuredClone(doc);
    this.now = options.now ?? (() => new Date());
    // Estado transitório não sobrevive a reabrir (V0.1 §2.4).
    this.doc.navigation.motion = { status: "idle" };
  }

  static create(options: CreateWorkspaceOptions): WorkspaceStore {
    return new WorkspaceStore(emptySnapshot(options), options.now ? { now: options.now } : {});
  }

  get id(): string {
    return this.doc.workspace.id;
  }

  get revision(): number {
    return this.doc.workspace.revision;
  }

  /** Cópia profunda para entregar a outros processos. */
  snapshot(): WorkspaceSnapshot {
    return structuredClone(this.doc);
  }

  /** Leitura sem cópia, para uso interno dos módulos. Não mutar. */
  read(): Readonly<WorkspaceSnapshot> {
    return this.doc;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Executa mutações e confirma uma única revisão nova se algo mudou. */
  transact<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
      if (this.depth === 0 && this.dirty) {
        this.dirty = false;
        this.doc.workspace.revision++;
        this.doc.workspace.updatedAt = this.now().toISOString();
        const revision = this.doc.workspace.revision;
        for (const listener of this.listeners) listener(revision);
      }
    }
  }

  private touch() {
    if (this.depth === 0) throw new Error("mutação fora de transact()");
    this.dirty = true;
  }

  // ---------- projetos ----------
  project(id: string): Project | undefined {
    return this.doc.projects.find((p) => p.id === id);
  }

  addProject(project: Project) {
    this.touch();
    this.doc.projects.push(structuredClone(project));
    if (!this.doc.workspace.projectIds.includes(project.id)) this.doc.workspace.projectIds.push(project.id);
  }

  /** Projeto em que o agente trabalha quando o pedido não diz outro. */
  activeProject(): Project | undefined {
    const id = this.doc.workspace.activeProjectId;
    return (id && this.project(id)) || this.doc.projects[this.doc.projects.length - 1];
  }

  setActiveProject(id: string) {
    this.touch();
    this.doc.workspace.activeProjectId = id;
  }

  /**
   * Tira um projeto do workspace (os arquivos no disco não mudam). Sai junto tudo que só existe por causa dele:
   * referências a arquivos, mods que mostram esses arquivos, diagramas e conhecimento do projeto.
   * O que sobra perde só os vínculos com o que saiu.
   */
  removeProject(id: string): { artifacts: number; mods: number; diagrams: number; entities: number } {
    this.touch();
    const doc = this.doc;
    const artifacts = new Set(doc.artifacts.filter((a) => a.projectId === id).map((a) => a.id));
    const modGone = (m: ModInstance) =>
      m.projectId === id || ["rootRef", "fileRef", "cwdRef", "artifactId"].some((k) => typeof m.config[k] === "string" && artifacts.has(m.config[k] as string));
    const mods = new Set(doc.mods.filter(modGone).map((m) => m.id));
    const diagrams = new Set(doc.diagrams.filter((d) => d.projectId === id).map((d) => d.id));
    const entities = new Set(doc.semantic.entities.filter((e) => e.projectId === id).map((e) => e.id));
    const relations = new Set(doc.semantic.relations.filter((r) => entities.has(r.sourceId) || entities.has(r.targetId)).map((r) => r.id));
    const evidence = new Set(doc.semantic.evidence.filter((ev) => ev.artifactId !== undefined && artifacts.has(ev.artifactId)).map((ev) => ev.id));
    const dropEvidence = <T extends { provenance: { evidenceIds?: string[] } }>(x: T): T => {
      if (x.provenance.evidenceIds) x.provenance.evidenceIds = x.provenance.evidenceIds.filter((e) => !evidence.has(e));
      return x;
    };

    doc.projects = doc.projects.filter((p) => p.id !== id);
    doc.workspace.projectIds = doc.workspace.projectIds.filter((p) => p !== id);
    if (doc.workspace.activeProjectId === id) {
      const last = doc.workspace.projectIds[doc.workspace.projectIds.length - 1];
      if (last) doc.workspace.activeProjectId = last;
      else delete doc.workspace.activeProjectId;
    }
    doc.artifacts = doc.artifacts.filter((a) => !artifacts.has(a.id));
    doc.mods = doc.mods.filter((m) => !mods.has(m.id));
    for (const m of doc.mods) if (m.semanticEntityIds) m.semanticEntityIds = m.semanticEntityIds.filter((e) => !entities.has(e));
    doc.diagrams = doc.diagrams.filter((d) => !diagrams.has(d.id));
    for (const d of doc.diagrams) {
      for (const n of d.nodes) if (n.semanticEntityId && entities.has(n.semanticEntityId)) delete n.semanticEntityId;
      for (const e of d.edges) if (e.semanticRelationId && relations.has(e.semanticRelationId)) delete e.semanticRelationId;
    }
    doc.semantic.entities = doc.semantic.entities.filter((e) => !entities.has(e.id)).map(dropEvidence);
    for (const e of doc.semantic.entities) if (e.artifactIds) e.artifactIds = e.artifactIds.filter((a) => !artifacts.has(a));
    doc.semantic.relations = doc.semantic.relations.filter((r) => !relations.has(r.id)).map(dropEvidence);
    doc.semantic.evidence = doc.semantic.evidence.filter((ev) => !evidence.has(ev.id));
    doc.canvas.objects = doc.canvas.objects.filter((o) => !mods.has(o.id) && !diagrams.has(o.id));
    for (const r of doc.canvas.regions) if (r.semanticEntityIds) r.semanticEntityIds = r.semanticEntityIds.filter((e) => !entities.has(e));
    const gone = (x: string) => mods.has(x) || diagrams.has(x) || entities.has(x) || relations.has(x) || artifacts.has(x);
    const focus = doc.navigation.focus as { targetIds?: string[]; highlightIds?: string[] };
    if (focus.targetIds) focus.targetIds = focus.targetIds.filter((t) => !gone(t));
    if (focus.highlightIds) focus.highlightIds = focus.highlightIds.filter((t) => !gone(t));
    return { artifacts: artifacts.size, mods: mods.size, diagrams: diagrams.size, entities: entities.size };
  }

  // ---------- artefatos ----------
  artifact(id: string): ArtifactReference | undefined {
    return this.doc.artifacts.find((a) => a.id === id);
  }

  findArtifact(projectId: string, rootId: string, path: string): ArtifactReference | undefined {
    return this.doc.artifacts.find(
      (a) =>
        a.projectId === projectId && "rootId" in a.locator && a.locator.rootId === rootId && a.locator.path === path,
    );
  }

  upsertArtifact(artifact: ArtifactReference) {
    this.touch();
    const i = this.doc.artifacts.findIndex((a) => a.id === artifact.id);
    if (i >= 0) this.doc.artifacts[i] = structuredClone(artifact);
    else this.doc.artifacts.push(structuredClone(artifact));
  }

  // ---------- mods ----------
  mod(id: string): ModInstance | undefined {
    return this.doc.mods.find((m) => m.id === id);
  }

  /** Grava a instância incrementando a revisão dela. */
  putMod(mod: ModInstance): ModInstance {
    this.touch();
    const i = this.doc.mods.findIndex((m) => m.id === mod.id);
    const next = structuredClone(mod);
    next.revision = i >= 0 ? this.doc.mods[i]!.revision + 1 : 1;
    if (i >= 0) {
      next.updatedAt = this.now().toISOString();
      this.doc.mods[i] = next;
    } else this.doc.mods.push(next);
    return next;
  }

  deleteMod(id: string): boolean {
    const i = this.doc.mods.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.touch();
    this.doc.mods.splice(i, 1);
    this.removeCanvasObject(id);
    return true;
  }

  // ---------- canvas ----------
  canvasObject(id: string): CanvasObject | undefined {
    return this.doc.canvas.objects.find((o) => o.id === id);
  }

  placeObject(object: CanvasObject): CanvasObject {
    this.touch();
    const i = this.doc.canvas.objects.findIndex((o) => o.id === object.id);
    const next = structuredClone(object);
    next.revision = i >= 0 ? (this.doc.canvas.objects[i]!.revision ?? 0) + 1 : 1;
    if (i >= 0) this.doc.canvas.objects[i] = next;
    else this.doc.canvas.objects.push(next);
    return next;
  }

  removeCanvasObject(id: string) {
    const i = this.doc.canvas.objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    this.touch();
    this.doc.canvas.objects.splice(i, 1);
  }

  // ---------- regiões ----------
  region(id: string): Region | undefined {
    return this.doc.canvas.regions.find((r) => r.id === id);
  }

  putRegion(region: Region): Region {
    this.touch();
    const i = this.doc.canvas.regions.findIndex((r) => r.id === region.id);
    const next = structuredClone(region);
    next.revision = i >= 0 ? (this.doc.canvas.regions[i]!.revision ?? 0) + 1 : 1;
    if (i >= 0) this.doc.canvas.regions[i] = next;
    else this.doc.canvas.regions.push(next);
    return next;
  }

  /** Remove a região; os objetos dentro dela continuam no canvas, só perdem o vínculo. */
  deleteRegion(id: string): boolean {
    const i = this.doc.canvas.regions.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.touch();
    this.doc.canvas.regions.splice(i, 1);
    for (const o of this.doc.canvas.objects) if (o.regionId === id) delete o.regionId;
    return true;
  }

  // ---------- diagramas ----------
  diagram(id: string): DiagramModel | undefined {
    return this.doc.diagrams.find((d) => d.id === id);
  }

  /** Grava o diagrama incrementando a revisão dele. */
  putDiagram(diagram: DiagramModel): DiagramModel {
    this.touch();
    const i = this.doc.diagrams.findIndex((d) => d.id === diagram.id);
    const next = structuredClone(diagram);
    next.revision = i >= 0 ? this.doc.diagrams[i]!.revision + 1 : 1;
    if (i >= 0) this.doc.diagrams[i] = next;
    else this.doc.diagrams.push(next);
    return next;
  }

  deleteDiagram(id: string): boolean {
    const i = this.doc.diagrams.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.touch();
    this.doc.diagrams.splice(i, 1);
    this.removeCanvasObject(id);
    return true;
  }

  // ---------- Open Semantic (armazenamento no snapshot; ver decisão D2) ----------
  entity(id: string): SemanticEntity | undefined {
    return this.doc.semantic.entities.find((e) => e.id === id);
  }

  relation(id: string): SemanticRelation | undefined {
    return this.doc.semantic.relations.find((r) => r.id === id);
  }

  evidence(id: string): Evidence | undefined {
    return this.doc.semantic.evidence.find((e) => e.id === id);
  }

  putEntity(entity: SemanticEntity): SemanticEntity {
    this.touch();
    const list = this.doc.semantic.entities;
    const i = list.findIndex((e) => e.id === entity.id);
    const next = structuredClone(entity);
    next.revision = i >= 0 ? list[i]!.revision + 1 : 1;
    if (i >= 0) list[i] = next;
    else list.push(next);
    return next;
  }

  putRelation(relation: SemanticRelation): SemanticRelation {
    this.touch();
    const list = this.doc.semantic.relations;
    const i = list.findIndex((r) => r.id === relation.id);
    const next = structuredClone(relation);
    next.revision = i >= 0 ? list[i]!.revision + 1 : 1;
    if (i >= 0) list[i] = next;
    else list.push(next);
    return next;
  }

  /** Evidências são imutáveis: gravar de novo o mesmo id não altera nada. */
  addEvidence(evidence: Evidence): boolean {
    if (this.evidence(evidence.id)) return false;
    this.touch();
    this.doc.semantic.evidence.push(structuredClone(evidence));
    return true;
  }

  // ---------- navegação ----------
  setCamera(camera: Camera) {
    this.touch();
    this.doc.navigation.camera = structuredClone(camera);
  }

  /** Substitui partes do estado de navegação (câmera, foco, histórico, movimento, controle). */
  updateNavigation(patch: Partial<NavigationState>) {
    this.touch();
    this.doc.navigation = { ...this.doc.navigation, ...structuredClone(patch) };
  }

  setSettings(patch: Partial<WorkspaceSnapshot["workspace"]["settings"]>) {
    this.touch();
    this.doc.workspace.settings = { ...this.doc.workspace.settings, ...patch };
  }

  // ---------- consultas genéricas ----------
  /** Revisão de qualquer objeto com id; undefined se não existe. */
  revisionOf(id: string): number | undefined {
    if (id === this.doc.workspace.id) return this.doc.workspace.revision;
    const found =
      this.mod(id) ??
      this.project(id) ??
      this.diagram(id) ??
      this.region(id) ??
      this.entity(id) ??
      this.relation(id) ??
      this.canvasObject(id);
    if (found) return found.revision ?? 0;
    if (this.artifact(id) || this.evidence(id)) return 0;
    return undefined;
  }

  exists(id: string): boolean {
    return this.revisionOf(id) !== undefined;
  }
}
