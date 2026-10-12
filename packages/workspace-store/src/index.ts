export { WorkspaceStore, emptySnapshot, type ChangeListener, type CreateWorkspaceOptions } from "./store.js";
export { findFreeSpot, overlaps, GAP } from "./placement.js";
export { FileWorkspacePersistence, autosave, type PersistStatus, type WorkspacePersistence } from "./persistence.js";
export { workspaceHandlers, workspacePreconditions, placedBy, suffixOf, type WorkspaceHandlerDeps } from "./handlers.js";
