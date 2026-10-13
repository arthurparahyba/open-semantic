export { WorkspaceStore, emptySnapshot, type ChangeListener, type CreateWorkspaceOptions } from "./store.js";
export { findFreeSpot, overlaps, GAP, placeNew, regionAt, boundsOfRects, REGION_PADDING, type PlacementRequest } from "./placement.js";
export { FileWorkspacePersistence, WorkspaceFolderPersistence, autosave, type PersistStatus, type WorkspacePersistence } from "./persistence.js";
export { DIAGRAM_HEADER, DIAGRAM_PADDING, contentSize } from "./diagramSize.js";
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
