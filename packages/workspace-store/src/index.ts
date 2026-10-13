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
export { findFreeSpot, overlaps, GAP, placeNew, regionAt, boundsOfRects, REGION_PADDING, type PlacementRequest } from "./placement.js";
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
} from "./anchoring.js";
export { layerHandlers, keepNewDiagramsInActiveLayer, BORN_IN_LAYER, elementExists, inLayer, mergeMembers, type LayerHandlerDeps } from "./layerHandlers.js";
export { activeLayerOf, childMarks, layerTree, litObjects, type LayerMark, type LayerNode } from "./layerView.js";
