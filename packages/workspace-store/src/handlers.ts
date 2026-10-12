import {
  OperationError,
  SCHEMA_BASE_URI,
  type Actor,
  type Camera,
  type OperationHandler,
  type PreconditionEvaluator,
  type Project,
} from "@open-semantic/protocol";

import type { WorkspaceStore } from "./store.js";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });

export interface WorkspaceHandlerDeps {
  store: WorkspaceStore;
  /** Confere no disco que o caminho absoluto existe e é um diretório. */
  isDirectory(absolutePath: string): Promise<boolean>;
}

export function suffixOf(id: string): string {
  return id.slice(id.indexOf("_") + 1);
}

/** Operações do Workspace Store. Ver docs/funcionalidades/01-workspace-e-canvas.md. */
export function workspaceHandlers({ store, isDirectory }: WorkspaceHandlerDeps): OperationHandler[] {
  return [
    {
      operation: "workspace.get_snapshot",
      argumentsSchema: { type: "object", additionalProperties: false },
      handle: () => ({ output: { snapshot: store.snapshot() }, changes: [] }),
    },

    {
      // Só o usuário escolhe pastas do disco; o agente nunca recebe nem envia caminhos absolutos.
      operation: "workspace.add_project",
      argumentsSchema: {
        type: "object",
        required: ["projectId", "name", "rootPath"],
        properties: {
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          name: { type: "string", minLength: 1 },
          rootPath: { type: "string", minLength: 1 },
          capabilities: {
            type: "array",
            items: ref("common.schema.json#/$defs/Capability"),
            uniqueItems: true,
            minItems: 1,
          },
        },
        additionalProperties: false,
      },
      async check(args, { request }) {
        if (request.authorization.actor.kind !== "user") {
          throw new OperationError("UNAUTHORIZED", "Somente o usuário pode adicionar pastas ao workspace.");
        }
        const existing = store.project(args.projectId as string);
        if (existing) {
          const sameRoot = existing.location.kind === "local" && existing.location.rootPath === args.rootPath;
          if (!sameRoot) {
            throw new OperationError("PRECONDITION_FAILED", "Já existe um projeto com esse id em outra pasta.", {
              targetId: existing.id,
            });
          }
          return;
        }
        if (!(await isDirectory(args.rootPath as string))) {
          throw new OperationError("REFERENCE_INVALID", "A pasta escolhida não existe ou não é um diretório.", {
            argumentPath: "/rootPath",
          });
        }
      },
      handle(args, { request, now }) {
        const projectId = args.projectId as string;
        const existing = store.project(projectId);
        if (existing) {
          return {
            output: { projectId, rootArtifactId: existing.rootRef, rootId: existing.roots[0]!.id },
            changes: [{ id: projectId, change: "unchanged" }],
          };
        }
        const suffix = suffixOf(projectId);
        const rootId = `root_${suffix}`;
        const rootArtifactId = `art_${suffix}_root`;
        const project: Project = {
          id: projectId,
          name: args.name as string,
          location: { kind: "local", rootPath: args.rootPath as string },
          roots: [
            {
              id: rootId,
              path: "",
              capabilities: (args.capabilities as Project["roots"][number]["capabilities"]) ?? ["read", "write"],
              commandPolicy: { mode: "confirm_all" },
            },
          ],
          rootRef: rootArtifactId,
          revision: 1,
        };
        store.transact(() => {
          store.addProject(project);
          store.upsertArtifact({
            id: rootArtifactId,
            projectId,
            kind: "directory",
            locator: { rootId, path: "" },
            validity: { status: "valid", checkedAt: now().toISOString() },
            provenance: {
              source: "user_statement",
              actor: request.authorization.actor,
              operationId: request.operationId,
              recordedAt: now().toISOString(),
            },
          });
        });
        return {
          output: { projectId, rootArtifactId, rootId },
          changes: [
            { id: projectId, change: "created", revision: 1 },
            { id: rootArtifactId, change: "created" },
          ],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      operation: "canvas.place",
      argumentsSchema: {
        type: "object",
        required: ["objectId", "position"],
        properties: {
          objectId: ref("common.schema.json#/$defs/CanvasObjectId"),
          position: ref("common.schema.json#/$defs/Point"),
          size: ref("common.schema.json#/$defs/Size"),
        },
        additionalProperties: false,
      },
      check(args) {
        if (!store.canvasObject(args.objectId as string)) {
          throw new OperationError("TARGET_NOT_FOUND", "Objeto não está no canvas.", { targetId: args.objectId as string });
        }
      },
      handle(args, { request }) {
        const current = store.canvasObject(args.objectId as string)!;
        const placed = store.transact(() =>
          store.placeObject({
            ...current,
            position: args.position as Camera["center"],
            ...(args.size ? { size: args.size as typeof current.size } : {}),
            placedBy: placedBy(request.authorization.actor),
          }),
        );
        return {
          output: { position: placed.position, size: placed.size },
          changes: [{ id: placed.id, change: "updated", revision: placed.revision ?? 0 }],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      // Câmera definida pelo usuário (pan/zoom), salva para ser restaurada ao reabrir.
      operation: "navigation.set_camera",
      argumentsSchema: {
        type: "object",
        required: ["camera"],
        properties: { camera: ref("navigation.schema.json#/$defs/Camera") },
        additionalProperties: false,
      },
      handle(args) {
        store.transact(() => store.setCamera(args.camera as Camera));
        return { changes: [{ id: store.id, change: "updated" }], workspaceRevision: store.revision };
      },
    },
  ];
}

export function placedBy(actor: Actor): "agent" | "user" {
  return actor.kind === "agent" ? "agent" : "user";
}

/**
 * Avalia pré-condições sobre o estado do workspace. `artifact_unchanged` é delegada ao Project Runtime.
 */
export function workspacePreconditions(
  store: WorkspaceStore,
  artifactUnchanged?: PreconditionEvaluator,
): PreconditionEvaluator {
  return (pre, request) => {
    switch (pre.kind) {
      case "exists":
        return store.exists(pre.targetId) ? { ok: true } : { ok: false, message: `${pre.targetId} não existe.` };
      case "not_exists":
        return store.exists(pre.targetId) ? { ok: false, message: `${pre.targetId} já existe.` } : { ok: true };
      case "revision_equals": {
        const current = store.revisionOf(pre.targetId);
        if (current === undefined) return { ok: false, message: `${pre.targetId} não existe.` };
        return current === pre.revision
          ? { ok: true }
          : { ok: false, code: "REVISION_CONFLICT", message: `${pre.targetId} está na revisão ${current}, esperada ${pre.revision}.` };
      }
      case "mod_lifecycle": {
        const mod = store.mod(pre.modId);
        if (!mod) return { ok: false, message: `${pre.modId} não existe.` };
        return mod.lifecycle === pre.lifecycle
          ? { ok: true }
          : { ok: false, message: `${pre.modId} está ${mod.lifecycle}, esperado ${pre.lifecycle}.` };
      }
      case "artifact_unchanged":
        return artifactUnchanged
          ? artifactUnchanged(pre, request)
          : { ok: false, message: "Nenhum runtime de projeto para conferir o artefato." };
    }
  };
}
