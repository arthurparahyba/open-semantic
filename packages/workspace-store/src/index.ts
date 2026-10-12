export { WorkspaceStore, emptySnapshot, type ChangeListener, type CreateWorkspaceOptions } from "./store.js";
export { findFreeSpot, overlaps, GAP, placeNew, regionAt, boundsOfRects, REGION_PADDING, type PlacementRequest } from "./placement.js";
export { FileWorkspacePersistence, autosave, type PersistStatus, type WorkspacePersistence } from "./persistence.js";
export {
  workspaceHandlers,
  workspacePreconditions,
  placedBy,
  suffixOf,
  requireEntities,
  DEFAULT_REGION_SIZE,
  type WorkspaceHandlerDeps,
} from "./handlers.js";
