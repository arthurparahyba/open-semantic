export { WorkspaceStore, emptySnapshot, type CommitListener, type CreateWorkspaceOptions } from "./store.js";
export {
  applyCommit,
  withoutBefore,
  type ChangeKind,
  type Collection,
  type CollectionItems,
  type Commit,
  type CommitSummary,
  type StoreChange,
  type StoreChangeAfter,
} from "./commits.js";
export { commitEvents, type EventContext } from "./events.js";
export type { Removed } from "./removal.js";
export { activeProject } from "./projects.js";
export * from "./layout/index.js";
export { dropOrphanBlocks } from "./orphanBlocks.js";
export { FileWorkspacePersistence, WorkspaceFolderPersistence, autosave, type PersistStatus, type WorkspacePersistence } from "./persistence.js";
export { CAPTION_LINE, DIAGRAM_HEADER, DIAGRAM_PADDING, captionLines, contentSize, diagramSize } from "./diagramSize.js";
export {
  workspaceHandlers,
  workspacePreconditions,
  placedBy,
  suffixOf,
  requireEntities,
  DEFAULT_REGION_SIZE,
  type WorkspaceHandlerDeps,
} from "./handlers.js";
export {
  REPO_DIR,
  RepoWriter,
  mergeRepoContent,
  readRepoContent,
  splitSnapshot,
  statPaths,
  storesInRepo,
  type RepoContent,
} from "./repoStore.js";
export {
  GROUP_PADDING,
  REPOSITORY_PADDING,
  ancestry,
  anchorsOf,
  contextGroups,
  parentsOf,
  placeAnchored,
  repositoryUnit,
  unitItems,
  type AnchorDoc,
  type ContextGroup,
} from "./layout/anchoring.js";
export { blockHandlers, placeInFlow, type BlockHandlerDeps } from "./blockHandlers.js";
export { layerHandlers, keepNewDiagramsInActiveLayer, BORN_IN_LAYER, elementExists, inLayer, mergeMembers, type LayerHandlerDeps } from "./layerHandlers.js";
export { activeLayerOf, childMarks, hiddenObjects, layerTree, litObjects, type LayerMark, type LayerNode } from "./layerView.js";
export { SPECS_DIR, SpecWriter, isSpecLayer, renderSpec, specFiles, specSlug } from "./specs.js";
