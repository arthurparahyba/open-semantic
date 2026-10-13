// Commits do store: o que cada transact() mudou, por coleção. Sem dependências de Node, para a interface
// aplicar os commits na cópia dela do workspace (docs/funcionalidades/01-workspace-e-canvas.md, "Eventos").
import type {
  ArtifactReference,
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

/** O que cada coleção guarda. `workspace` e `navigation` são um objeto só; as outras são listas por id. */
export interface CollectionItems {
  workspace: WorkspaceSnapshot["workspace"];
  projects: Project;
  artifacts: ArtifactReference;
  entities: SemanticEntity;
  relations: SemanticRelation;
  evidence: Evidence;
  mods: ModInstance;
  diagrams: DiagramModel;
  regions: Region;
  canvas: CanvasObject;
  layers: Layer;
  navigation: NavigationState;
}

export type Collection = keyof CollectionItems;
export type ListCollection = Exclude<Collection, "workspace" | "navigation">;
export type ChangeKind = "created" | "updated" | "deleted";

/** Uma mudança confirmada. `before` e `after` são os próprios objetos do store, congelados: podem ser guardados sem cópia. */
export type StoreChange = {
  [C in Collection]: { collection: C; id: string; kind: ChangeKind; before?: CollectionItems[C]; after?: CollectionItems[C] };
}[Collection];

/** A mudança sem o valor anterior: o que a interface precisa para atualizar a cópia dela. */
export type StoreChangeAfter = {
  [C in Collection]: { collection: C; id: string; kind: ChangeKind; after?: CollectionItems[C] };
}[Collection];

interface CommitHeader {
  /** Conta os commits da sessão, de documento ou de visualização. Um número pulado quer dizer commit perdido. */
  sequence: number;
  /** Revisão do documento depois do commit. Um commit só de visualização não a muda. */
  revision: number;
  /** Só a navegação mudou (câmera, foco, histórico, movimento, controle). */
  viewOnly: boolean;
}

/** Uma transação confirmada do store. */
export interface Commit extends CommitHeader {
  changes: StoreChange[];
}

/** O commit como vai para a interface: sem os valores anteriores. */
export interface CommitSummary extends CommitHeader {
  changes: StoreChangeAfter[];
}

type Lists = { [C in ListCollection]: { get(doc: WorkspaceSnapshot): CollectionItems[C][]; set(doc: WorkspaceSnapshot, items: CollectionItems[C][]): void } };

/** Onde cada lista fica no documento. */
export const LISTS: Lists = {
  projects: { get: (d) => d.projects, set: (d, items) => void (d.projects = items) },
  artifacts: { get: (d) => d.artifacts, set: (d, items) => void (d.artifacts = items) },
  entities: { get: (d) => d.semantic.entities, set: (d, items) => void (d.semantic.entities = items) },
  relations: { get: (d) => d.semantic.relations, set: (d, items) => void (d.semantic.relations = items) },
  evidence: { get: (d) => d.semantic.evidence, set: (d, items) => void (d.semantic.evidence = items) },
  mods: { get: (d) => d.mods, set: (d, items) => void (d.mods = items) },
  diagrams: { get: (d) => d.diagrams, set: (d, items) => void (d.diagrams = items) },
  regions: { get: (d) => d.canvas.regions, set: (d, items) => void (d.canvas.regions = items) },
  canvas: { get: (d) => d.canvas.objects, set: (d, items) => void (d.canvas.objects = items) },
  // Workspaces antigos não têm camadas: a lista nasce vazia na primeira leitura.
  layers: { get: (d) => (d.layers ??= []), set: (d, items) => void (d.layers = items) },
};

/** As coleções na ordem do documento; as mudanças de um commit seguem esta ordem. */
export const COLLECTIONS: Collection[] = ["workspace", "projects", "artifacts", "entities", "relations", "evidence", "mods", "diagrams", "regions", "canvas", "layers", "navigation"];

export function isList(collection: Collection): collection is ListCollection {
  return collection !== "workspace" && collection !== "navigation";
}

export function withoutBefore(commit: Commit): CommitSummary {
  return {
    sequence: commit.sequence,
    revision: commit.revision,
    viewOnly: commit.viewOnly,
    changes: commit.changes.map(({ before: _before, ...change }) => change as StoreChangeAfter),
  };
}

/** Aplica um commit numa cópia do workspace sem reler o resto. Devolve uma cópia nova; a de entrada não muda. */
export function applyCommit(snapshot: WorkspaceSnapshot, commit: CommitSummary): WorkspaceSnapshot {
  const next: WorkspaceSnapshot = { ...snapshot, semantic: { ...snapshot.semantic }, canvas: { ...snapshot.canvas } };
  const byList = new Map<ListCollection, StoreChangeAfter[]>();
  for (const change of commit.changes) {
    if (change.collection === "workspace") next.workspace = change.after!;
    else if (change.collection === "navigation") next.navigation = change.after!;
    else if (byList.has(change.collection)) byList.get(change.collection)!.push(change);
    else byList.set(change.collection, [change]);
  }
  for (const [collection, changes] of byList) {
    const list = LISTS[collection] as { get(doc: WorkspaceSnapshot): { id: string }[]; set(doc: WorkspaceSnapshot, items: { id: string }[]): void };
    list.set(next, applyToList(list.get(next), changes));
  }
  return next;
}

/** Novos vão para o fim (como no store), alterados ficam no lugar, excluídos saem. */
function applyToList<T extends { id: string }>(items: T[], changes: StoreChangeAfter[]): T[] {
  const out = items.slice();
  const index = new Map(out.map((item, i) => [item.id, i]));
  const deleted = new Set<string>();
  for (const change of changes) {
    if (change.kind === "deleted") {
      deleted.add(change.id);
      continue;
    }
    const after = change.after as unknown as T;
    const i = index.get(change.id);
    if (i === undefined) index.set(change.id, out.push(after) - 1);
    else out[i] = after;
  }
  return deleted.size ? out.filter((item) => !deleted.has(item.id)) : out;
}
