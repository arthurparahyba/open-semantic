import type {
  ArtifactReference,
  Block,
  Camera,
  CanvasObject,
  DiagramModel,
  Evidence,
  Layer,
  ModInstance,
  NavigationState,
  Project,
  Region,
  SemanticEntity,
  SemanticRelation,
  WorkspaceSnapshot,
} from "@open-semantic/protocol";

import { capture, deepFreeze, diff, freezeDocument, restore, type Captured } from "./changes.js";
import { COLLECTIONS, LISTS, type Collection, type CollectionItems, type Commit, type ListCollection, type StoreChange } from "./commits.js";
import { activeProject } from "./projects.js";
import { removeProjectFrom, type Removed } from "./removal.js";

export type CommitListener = (commit: Commit) => void;

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
    blocks: [],
    canvas: { objects: [], regions: [] },
    layers: [],
    navigation: {
      camera: { center: { x: 0, y: 0 }, zoom: 1 },
      focus: {},
      history: [],
      motion: { status: "idle" },
      control: { mode: "shared" },
    },
  };
}

const withoutArrangement = <T extends { arrangement?: unknown }>({ arrangement: _gone, ...item }: T): T => item as T;
const withoutRegion = ({ regionId: _left, ...object }: CanvasObject): CanvasObject => object;
const isWorkspaceChange = (c: StoreChange): c is Extract<StoreChange, { collection: "workspace" }> => c.collection === "workspace";

/**
 * Fonte de verdade do que é visual e espacial (docs/funcionalidades/01-workspace-e-canvas.md).
 * Mudanças acontecem dentro de transact(); cada transação vira um commit com o que mudou, avisado em onCommit.
 * A navegação (câmera, foco, histórico, movimento, controle) é estado de visualização: é salva, mas um commit
 * só dela não muda a revisão do documento. Objetos do store não mudam no lugar: cada mudança grava uma cópia nova.
 */
export class WorkspaceStore {
  private doc: WorkspaceSnapshot;
  private readonly listeners = new Set<CommitListener>();
  private readonly now: () => Date;
  private depth = 0;
  /** O que cada coleção tinha antes da transação em curso: a base do commit e do desfazer. */
  private readonly before = new Map<Collection, Captured>();
  private commits = 0;
  private readonly queue: Commit[] = [];
  private publishing = false;

  constructor(doc: WorkspaceSnapshot, options: { now?: () => Date } = {}) {
    this.doc = structuredClone(doc);
    this.now = options.now ?? (() => new Date());
    // Estado transitório não sobrevive a reabrir (V0.1 §2.4).
    this.doc.navigation.motion = { status: "idle" };
    this.doc.layers ??= [];
    this.doc.blocks ??= [];
    freezeDocument(this.doc);
  }

  static create(options: CreateWorkspaceOptions): WorkspaceStore {
    return new WorkspaceStore(emptySnapshot(options), options.now ? { now: options.now } : {});
  }

  get id(): string {
    return this.doc.workspace.id;
  }

  /** Revisão do documento. Mexer só na navegação não a muda. */
  get revision(): number {
    return this.doc.workspace.revision;
  }

  /** Quantos commits houve desde que o store foi aberto, de documento ou de visualização. */
  get sequence(): number {
    return this.commits;
  }

  /** Cópia profunda para entregar a outros processos. */
  snapshot(): WorkspaceSnapshot {
    return structuredClone(this.doc);
  }

  /** Leitura sem cópia, para uso interno dos módulos. Os objetos estão congelados: para mudar, grave uma cópia. */
  read(): Readonly<WorkspaceSnapshot> {
    return this.doc;
  }

  /** Recebe cada commit, na ordem em que aconteceram. */
  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Executa mutações e confirma um commit se algo mudou; transações aninhadas viram um commit só.
   * Se a função lançar erro, o que ela mudou é desfeito e nada é avisado.
   */
  transact<T>(fn: () => T): T {
    this.depth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error("transact() não aceita função assíncrona: as mudanças precisam acontecer dentro dela.");
    } catch (err) {
      if (--this.depth === 0) this.rollback();
      throw err;
    }
    if (--this.depth === 0) this.commit();
    return result;
  }

  private touch(...collections: Collection[]) {
    if (this.depth === 0) throw new Error("mutação fora de transact()");
    for (const c of collections) if (!this.before.has(c)) this.before.set(c, capture(this.doc, c));
  }

  private rollback() {
    for (const [collection, before] of this.before) restore(this.doc, collection, before);
    this.before.clear();
  }

  private commit() {
    const changes = COLLECTIONS.flatMap((c) => (this.before.has(c) ? diff(this.doc, c, this.before.get(c)!) : []));
    this.before.clear();
    if (changes.length === 0) return;
    const viewOnly = changes.every((c) => c.collection === "navigation");
    if (!viewOnly) this.bumpRevision(changes);
    for (const change of changes) deepFreeze(change.after);
    this.publish({ sequence: ++this.commits, revision: this.doc.workspace.revision, viewOnly, changes });
  }

  /** A revisão nova do documento entra no commit como mudança do workspace. */
  private bumpRevision(changes: StoreChange[]) {
    const before = this.doc.workspace;
    const after = { ...before, revision: before.revision + 1, updatedAt: this.now().toISOString() };
    this.doc.workspace = after;
    const own = changes.find(isWorkspaceChange);
    if (own) own.after = after;
    else changes.unshift({ collection: "workspace", id: after.id, kind: "updated", before, after });
  }

  /** Avisa na ordem dos commits, mesmo que alguém mude o store dentro do aviso. */
  private publish(commit: Commit) {
    this.queue.push(commit);
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) for (const listener of this.listeners) listener(next);
    } finally {
      this.publishing = false;
    }
  }

  /** Grava um item novo, ou no lugar do que tem o mesmo id. */
  private put<C extends ListCollection>(collection: C, item: CollectionItems[C]) {
    this.touch(collection);
    const list = LISTS[collection].get(this.doc);
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
  }

  private remove(collection: ListCollection, id: string): boolean {
    const list = LISTS[collection].get(this.doc) as { id: string }[];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.touch(collection);
    list.splice(i, 1);
    return true;
  }

  /** Mudança em bloco no documento, para quem traz conteúdo de fora (ex.: `.open-semantic/` de um repositório). */
  mutate(fn: (doc: WorkspaceSnapshot) => void) {
    this.touch(...COLLECTIONS);
    fn(this.doc);
  }

  // ---------- projetos ----------
  project(id: string): Project | undefined {
    return this.doc.projects.find((p) => p.id === id);
  }

  addProject(project: Project) {
    this.touch("projects", "workspace");
    this.doc.projects.push(structuredClone(project));
    const workspace = this.doc.workspace;
    if (!workspace.projectIds.includes(project.id)) this.doc.workspace = { ...workspace, projectIds: [...workspace.projectIds, project.id] };
  }

  /** Projeto em que o agente trabalha quando o pedido não diz outro. */
  activeProject(): Project | undefined {
    return activeProject(this.doc);
  }

  setActiveProject(id: string) {
    this.touch("workspace");
    this.doc.workspace = { ...this.doc.workspace, activeProjectId: id };
  }

  /** Tira um projeto do workspace e o que só existe por causa dele (ver removal.ts). Os arquivos no disco não mudam. */
  removeProject(id: string): Removed {
    this.touch(...COLLECTIONS);
    return removeProjectFrom(this.doc, id);
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
    this.put("artifacts", structuredClone(artifact));
  }

  // ---------- mods ----------
  mod(id: string): ModInstance | undefined {
    return this.doc.mods.find((m) => m.id === id);
  }

  /** Grava a instância incrementando a revisão dela. */
  putMod(mod: ModInstance): ModInstance {
    const current = this.mod(mod.id);
    const next = { ...structuredClone(mod), revision: current ? current.revision + 1 : 1 };
    if (current) next.updatedAt = this.now().toISOString();
    this.put("mods", next);
    return next;
  }

  deleteMod(id: string): boolean {
    if (!this.remove("mods", id)) return false;
    this.removeCanvasObject(id);
    this.forgetInLayers(new Set([id]));
    return true;
  }

  // ---------- canvas ----------
  canvasObject(id: string): CanvasObject | undefined {
    return this.doc.canvas.objects.find((o) => o.id === id);
  }

  placeObject(object: CanvasObject): CanvasObject {
    const next = { ...structuredClone(object), revision: (this.canvasObject(object.id)?.revision ?? 0) + 1 };
    this.put("canvas", next);
    return next;
  }

  removeCanvasObject(id: string) {
    this.remove("canvas", id);
  }

  // ---------- regiões ----------
  region(id: string): Region | undefined {
    return this.doc.canvas.regions.find((r) => r.id === id);
  }

  putRegion(region: Region): Region {
    const next = { ...structuredClone(region), revision: (this.region(region.id)?.revision ?? 0) + 1 };
    this.put("regions", next);
    return next;
  }

  /** Remove a região; os objetos dentro dela continuam no canvas, só perdem o vínculo. */
  deleteRegion(id: string): boolean {
    if (!this.remove("regions", id)) return false;
    this.touch("canvas");
    this.doc.canvas.objects = this.doc.canvas.objects.map((o) => (o.regionId === id ? withoutRegion(o) : o));
    return true;
  }

  // ---------- diagramas ----------
  diagram(id: string): DiagramModel | undefined {
    return this.doc.diagrams.find((d) => d.id === id);
  }

  /** Grava o diagrama incrementando a revisão dele. */
  putDiagram(diagram: DiagramModel): DiagramModel {
    const current = this.diagram(diagram.id);
    const next = { ...structuredClone(diagram), revision: current ? current.revision + 1 : 1 };
    this.put("diagrams", next);
    return next;
  }

  deleteDiagram(id: string): boolean {
    const nodeIds = this.diagram(id)?.nodes.map((n) => n.id) ?? [];
    if (!this.remove("diagrams", id)) return false;
    this.removeCanvasObject(id);
    this.forgetInLayers(new Set([id, ...nodeIds]));
    this.forgetArrangedOn(id);
    return true;
  }

  // ---------- blocos de explicação (docs/funcionalidades/13-layout-semantico.md) ----------
  blocks(): readonly Block[] {
    return this.doc.blocks ?? [];
  }

  block(id: string): Block | undefined {
    return this.blocks().find((b) => b.id === id);
  }

  /** Grava o bloco incrementando a revisão dele. */
  putBlock(block: Block): Block {
    const next = { ...structuredClone(block), revision: (this.block(block.id)?.revision ?? 0) + 1 };
    this.put("blocks", next);
    return next;
  }

  /** Tira o bloco do canvas; os blocos colados nele (annotates) saem junto. */
  deleteBlock(id: string): boolean {
    if (!this.remove("blocks", id)) return false;
    this.removeCanvasObject(id);
    this.forgetArrangedOn(id);
    return true;
  }

  /**
   * O alvo saiu: os blocos colados nele saem também; quem continuava ou detalhava o alvo perde só a relação.
   */
  private forgetArrangedOn(targetId: string) {
    for (const b of this.blocks().filter((x) => x.arrangement?.targetId === targetId)) {
      if (b.arrangement!.relation === "annotates") this.deleteBlock(b.id);
      else this.putBlock(withoutArrangement(b));
    }
    for (const d of this.doc.diagrams.filter((x) => x.arrangement?.targetId === targetId)) this.putDiagram(withoutArrangement(d));
  }

  // ---------- camadas de assunto (docs/funcionalidades/11-camadas.md) ----------
  layers(): readonly Layer[] {
    return this.doc.layers ?? [];
  }

  layer(id: string): Layer | undefined {
    return this.layers().find((l) => l.id === id);
  }

  /** Grava a camada incrementando a revisão dela. */
  putLayer(layer: Layer): Layer {
    const next = { ...structuredClone(layer), revision: (this.layer(layer.id)?.revision ?? 0) + 1 };
    this.put("layers", next);
    return next;
  }

  /** Tira só o recorte: os elementos continuam onde estão. */
  deleteLayer(id: string): boolean {
    if (!this.remove("layers", id)) return false;
    if (this.doc.navigation.activeLayerId === id) this.setActiveLayer(undefined);
    return true;
  }

  activeLayer(): Layer | undefined {
    const id = this.doc.navigation.activeLayerId;
    return id ? this.layer(id) : undefined;
  }

  /** Muda a camada ativa (estado de visualização); undefined volta para a base. */
  setActiveLayer(id: string | undefined) {
    this.touch("navigation");
    const { activeLayerId: _old, ...navigation } = this.doc.navigation;
    this.doc.navigation = id ? { ...navigation, activeLayerId: id } : navigation;
  }

  /** Elementos que saíram do workspace deixam de ser membros e âncoras. */
  private forgetInLayers(gone: Set<string>) {
    for (const layer of this.layers()) {
      const members = layer.members.filter((m) => !gone.has(m.id));
      const anchors = layer.anchors.filter((a) => !gone.has(a));
      if (members.length !== layer.members.length || anchors.length !== layer.anchors.length) this.put("layers", { ...layer, members, anchors });
    }
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
    const current = this.entity(entity.id);
    const next = { ...structuredClone(entity), revision: current ? current.revision + 1 : 1 };
    this.put("entities", next);
    return next;
  }

  putRelation(relation: SemanticRelation): SemanticRelation {
    const current = this.relation(relation.id);
    const next = { ...structuredClone(relation), revision: current ? current.revision + 1 : 1 };
    this.put("relations", next);
    return next;
  }

  /** Evidências são imutáveis: gravar de novo o mesmo id não altera nada. */
  addEvidence(evidence: Evidence): boolean {
    if (this.evidence(evidence.id)) return false;
    this.put("evidence", structuredClone(evidence));
    return true;
  }

  // ---------- navegação (estado de visualização) ----------
  setCamera(camera: Camera) {
    this.touch("navigation");
    this.doc.navigation = { ...this.doc.navigation, camera: structuredClone(camera) };
  }

  /** Substitui partes do estado de navegação (câmera, foco, histórico, movimento, controle). */
  updateNavigation(patch: Partial<NavigationState>) {
    this.touch("navigation");
    this.doc.navigation = { ...this.doc.navigation, ...structuredClone(patch) };
  }

  setSettings(patch: Partial<WorkspaceSnapshot["workspace"]["settings"]>) {
    this.touch("workspace");
    const workspace = this.doc.workspace;
    this.doc.workspace = { ...workspace, settings: { ...workspace.settings, ...patch } };
  }

  // ---------- consultas genéricas ----------
  /** Revisão de qualquer objeto com id; undefined se não existe. */
  revisionOf(id: string): number | undefined {
    if (id === this.doc.workspace.id) return this.doc.workspace.revision;
    const found =
      this.mod(id) ??
      this.project(id) ??
      this.diagram(id) ??
      this.block(id) ??
      this.region(id) ??
      this.layer(id) ??
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
