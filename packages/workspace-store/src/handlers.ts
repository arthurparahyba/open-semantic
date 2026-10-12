import {
  OperationError,
  SCHEMA_BASE_URI,
  type Actor,
  type Camera,
  type OperationHandler,
  type PreconditionEvaluator,
  type Project,
  type Region,
} from "@open-semantic/protocol";

import { repositoryUnit } from "./anchoring.js";
import { placeNew, regionAt } from "./placement.js";
import type { WorkspaceStore } from "./store.js";

export const DEFAULT_REGION_SIZE = { width: 600, height: 720 } as const;

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });

export interface WorkspaceHandlerDeps {
  store: WorkspaceStore;
  /** Confere no disco que o caminho absoluto existe e é um diretório. */
  isDirectory(absolutePath: string): Promise<boolean>;
  /** Traz para o workspace o `.open-semantic/` de um repositório recém-adicionado (diagramas e conhecimento de quem já trabalhou nele). */
  importRepo?(projectId: string): Promise<void>;
  /** Pasta onde os clones ficam (`<workspace>/repos`). Sem ela, `workspace.clone_repository` não existe. */
  reposDir?: string;
  /** Clona `url` em `targetDir`. Lança com uma mensagem legível se falhar. */
  cloneRepository?(url: string, targetDir: string): Promise<void>;
  /** Diretório pessoal, para entender `~/` nos caminhos que o usuário dita. */
  homeDir?: string;
}

/** Endereços que aceitamos clonar: https (GitHub, GitLab etc.) ou git@host:dono/repo. */
export const CLONE_URL = /^(https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~\/-]+?|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+?)(\.git)?\/?$/;

/** Nome de pasta a partir do endereço do repositório: https://github.com/dono/xpto.git → xpto. */
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/\.git\/?$/, "").replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
}

export function suffixOf(id: string): string {
  return id.slice(id.indexOf("_") + 1);
}

/** Operações do Workspace Store. Ver docs/funcionalidades/01-workspace-e-canvas.md. */
export function workspaceHandlers({ store, isDirectory, importRepo, reposDir, cloneRepository, homeDir }: WorkspaceHandlerDeps): OperationHandler[] {
  const findByRoot = (rootPath: string) =>
    store.read().projects.find((p) => p.location.kind === "local" && p.location.rootPath.replace(/\/+$/, "") === rootPath.replace(/\/+$/, ""));
  const expand = (path: string) => (homeDir && (path === "~" || path.startsWith("~/")) ? homeDir + path.slice(1) : path);

  /** Coloca a pasta no workspace como projeto ativo e traz o que o repositório já sabe de si. */
  const addProject = async (projectId: string, name: string, rootPath: string, capabilities: Project["roots"][number]["capabilities"] | undefined, actor: Actor, operationId: string, now: () => Date) => {
    const suffix = suffixOf(projectId);
    const rootId = `root_${suffix}`;
    const rootArtifactId = `art_${suffix}_root`;
    const project: Project = {
      id: projectId,
      name,
      location: { kind: "local", rootPath },
      roots: [{ id: rootId, path: "", capabilities: capabilities ?? ["read", "write"], commandPolicy: { mode: "confirm_all" } }],
      rootRef: rootArtifactId,
      revision: 1,
    };
    store.transact(() => {
      store.addProject(project);
      // A pasta que acabou de entrar vira o projeto em que o agente trabalha.
      store.setActiveProject(projectId);
      store.upsertArtifact({
        id: rootArtifactId,
        projectId,
        kind: "directory",
        locator: { rootId, path: "" },
        validity: { status: "valid", checkedAt: now().toISOString() },
        provenance: { source: "user_statement", actor, operationId, recordedAt: now().toISOString() },
      });
    });
    await importRepo?.(projectId);
    // Unidade de contexto do repositório (doc 09). Se o repositório já trouxe a sua, vale a dele.
    if (!repositoryUnit(store.read(), projectId)) {
      const at = now().toISOString();
      const evidenceId = `evd_${suffix}_repo`;
      store.transact(() => {
        store.addEvidence({ id: evidenceId, kind: "directory_listing", artifactId: rootArtifactId, summary: `Raiz do repositório ${name}.`, status: "current", observedAt: at });
        store.putEntity({
          id: `sem_${suffix}_repo`,
          kind: "repository",
          name,
          projectId,
          artifactIds: [rootArtifactId],
          status: "verified",
          provenance: { source: "user_statement", actor, operationId, recordedAt: at, evidenceIds: [evidenceId] },
          revision: 1,
        });
      });
    }
    return { projectId, rootArtifactId, rootId };
  };
  return [
    {
      operation: "workspace.get_snapshot",
      argumentsSchema: { type: "object", additionalProperties: false },
      handle: () => ({ output: { snapshot: store.snapshot() }, changes: [] }),
    },

    {
      // O usuário abre pastas pela interface; o agente pode pedir pela conversa, e a política exige a confirmação.
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
        // O usuário abre pastas pela interface; o agente pode pedir, e a política exige a confirmação do usuário.
        if (request.authorization.actor.kind !== "user" && request.authorization.actor.kind !== "agent") {
          throw new OperationError("UNAUTHORIZED", "Somente o usuário ou o agente (com confirmação) adicionam pastas ao workspace.");
        }
        const rootPath = expand(args.rootPath as string);
        if (!rootPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rootPath)) {
          throw new OperationError("INVALID_ARGUMENTS", "Use o caminho completo da pasta (por exemplo /Users/voce/projetos/xpto ou ~/projetos/xpto).", {
            argumentPath: "/rootPath",
          });
        }
        const existing = store.project(args.projectId as string) ?? findByRoot(rootPath);
        if (existing) {
          const sameRoot = existing.location.kind === "local" && existing.location.rootPath === rootPath;
          if (!sameRoot) {
            throw new OperationError("PRECONDITION_FAILED", "Já existe um projeto com esse id em outra pasta.", {
              targetId: existing.id,
            });
          }
          return;
        }
        if (!(await isDirectory(rootPath))) {
          throw new OperationError("REFERENCE_INVALID", "A pasta não existe ou não é um diretório.", {
            argumentPath: "/rootPath",
          });
        }
      },
      async handle(args, { request, now }) {
        const rootPath = expand(args.rootPath as string);
        // A mesma pasta não entra duas vezes: volta a ser o projeto ativo.
        const existing = store.project(args.projectId as string) ?? findByRoot(rootPath);
        if (existing) {
          if (store.read().workspace.activeProjectId !== existing.id) store.transact(() => store.setActiveProject(existing.id));
          return {
            output: { projectId: existing.id, rootArtifactId: existing.rootRef, rootId: existing.roots[0]!.id },
            changes: [{ id: existing.id, change: "unchanged" }],
          };
        }
        const projectId = args.projectId as string;
        const out = await addProject(
          projectId,
          args.name as string,
          rootPath,
          args.capabilities as Project["roots"][number]["capabilities"] | undefined,
          request.authorization.actor,
          request.operationId,
          now,
        );
        return {
          output: out,
          changes: [
            { id: projectId, change: "created", revision: 1 },
            { id: out.rootArtifactId, change: "created" },
          ],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      // Clona um repositório para dentro do workspace (<workspace>/repos/<nome>) e o adiciona como projeto ativo.
      operation: "workspace.clone_repository",
      argumentsSchema: {
        type: "object",
        required: ["projectId", "url"],
        properties: {
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          url: { type: "string", minLength: 8, maxLength: 400 },
          name: { type: "string", pattern: "^[A-Za-z0-9._-]{1,100}$" },
        },
        additionalProperties: false,
      },
      async check(args, { request }) {
        if (request.authorization.actor.kind !== "user" && request.authorization.actor.kind !== "agent") {
          throw new OperationError("UNAUTHORIZED", "Somente o usuário ou o agente (com confirmação) clonam repositórios.");
        }
        if (!reposDir || !cloneRepository) throw new OperationError("UNKNOWN_OPERATION", "Este workspace não clona repositórios.");
        if (!CLONE_URL.test(args.url as string)) {
          throw new OperationError("INVALID_ARGUMENTS", "Endereço de repositório inválido. Use https://… ou git@host:dono/repo.", { argumentPath: "/url" });
        }
        if (store.project(args.projectId as string)) {
          throw new OperationError("PRECONDITION_FAILED", "Já existe um projeto com esse id.", { argumentPath: "/projectId" });
        }
      },
      async handle(args, { request, now }) {
        const name = (args.name as string | undefined) ?? repoNameFromUrl(args.url as string);
        const target = `${reposDir}/${name}`;
        // Já clonado antes (pelo mesmo workspace): reaproveita a pasta.
        const existing = findByRoot(target);
        if (existing) {
          if (store.read().workspace.activeProjectId !== existing.id) store.transact(() => store.setActiveProject(existing.id));
          return { output: { projectId: existing.id, rootArtifactId: existing.rootRef, rootId: existing.roots[0]!.id, path: target, cloned: false }, changes: [{ id: existing.id, change: "unchanged" }] };
        }
        let cloned = false;
        if (!(await isDirectory(target))) {
          try {
            await cloneRepository!(args.url as string, target);
          } catch (err) {
            throw new OperationError("INTERNAL", `Não consegui clonar ${args.url as string}: ${(err as Error).message}`, { retryable: true });
          }
          cloned = true;
        }
        const projectId = args.projectId as string;
        const out = await addProject(projectId, name, target, undefined, request.authorization.actor, request.operationId, now);
        return {
          output: { ...out, path: target, cloned },
          changes: [
            { id: projectId, change: "created", revision: 1 },
            { id: out.rootArtifactId, change: "created" },
          ],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      // O usuário reabriu uma pasta que já estava no workspace: ela volta a ser o projeto ativo.
      operation: "workspace.set_active_project",
      argumentsSchema: {
        type: "object",
        required: ["projectId"],
        properties: { projectId: ref("common.schema.json#/$defs/ProjectId") },
        additionalProperties: false,
      },
      check(args, { request }) {
        if (request.authorization.actor.kind !== "user") throw new OperationError("UNAUTHORIZED", "Somente o usuário escolhe o projeto ativo.");
        if (!store.project(args.projectId as string)) {
          throw new OperationError("REFERENCE_INVALID", "Esse projeto não está no workspace.", { argumentPath: "/projectId" });
        }
      },
      handle(args) {
        const projectId = args.projectId as string;
        if (store.read().workspace.activeProjectId === projectId) return { output: { projectId }, changes: [{ id: projectId, change: "unchanged" }] };
        store.transact(() => store.setActiveProject(projectId));
        return { output: { projectId }, changes: [{ id: projectId, change: "updated" }], workspaceRevision: store.revision };
      },
    },

    {
      // Tira o projeto do workspace. Os arquivos no disco não são tocados.
      operation: "workspace.remove_project",
      argumentsSchema: {
        type: "object",
        required: ["projectId"],
        properties: { projectId: ref("common.schema.json#/$defs/ProjectId") },
        additionalProperties: false,
      },
      check(args, { request }) {
        if (request.authorization.actor.kind !== "user") throw new OperationError("UNAUTHORIZED", "Somente o usuário pode tirar pastas do workspace.");
        if (!store.project(args.projectId as string)) {
          throw new OperationError("REFERENCE_INVALID", "Esse projeto não está no workspace.", { argumentPath: "/projectId" });
        }
      },
      handle(args) {
        const projectId = args.projectId as string;
        const removed = store.transact(() => store.removeProject(projectId));
        return { output: { projectId, removed }, changes: [{ id: projectId, change: "deleted" }], workspaceRevision: store.revision };
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
        const next = {
          ...current,
          position: args.position as Camera["center"],
          ...(args.size ? { size: args.size as typeof current.size } : {}),
          placedBy: placedBy(request.authorization.actor),
        };
        // Soltar um objeto dentro de uma região o vincula a ela; soltar fora desfaz o vínculo.
        const region = regionAt(store.read().canvas.regions, next);
        if (region) next.regionId = region.id;
        else delete next.regionId;
        const placed = store.transact(() => store.placeObject(next));
        return {
          output: { position: placed.position, size: placed.size },
          changes: [{ id: placed.id, change: "updated", revision: placed.revision ?? 0 }],
          workspaceRevision: store.revision,
        };
      },
    },


    {
      operation: "region.create",
      argumentsSchema: {
        type: "object",
        required: ["regionId", "title"],
        properties: {
          regionId: ref("common.schema.json#/$defs/RegionId"),
          title: { type: "string", minLength: 1 },
          semanticEntityIds: { type: "array", items: ref("common.schema.json#/$defs/SemanticEntityId"), uniqueItems: true },
          color: { type: "string" },
          bounds: ref("common.schema.json#/$defs/Rect"),
          placement: {
            type: "object",
            properties: {
              strategy: { const: "free_space_near" },
              anchorIds: { type: "array", items: ref("common.schema.json#/$defs/VisualTargetId") },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      check(args) {
        requireEntities(store, args.semanticEntityIds as string[] | undefined, "/semanticEntityIds");
        const existing = store.region(args.regionId as string);
        if (existing && existing.title !== args.title) {
          throw new OperationError("PRECONDITION_FAILED", "Já existe uma região com esse id e outro título; use region.update.", {
            targetId: existing.id,
          });
        }
      },
      handle(args) {
        const regionId = args.regionId as string;
        const existing = store.region(regionId);
        if (existing) {
          return { output: { regionId, bounds: existing.bounds }, changes: [{ id: regionId, change: "unchanged", revision: existing.revision ?? 1 }] };
        }
        const placement = (args.placement ?? {}) as { anchorIds?: string[] };
        const bounds =
          (args.bounds as Region["bounds"] | undefined) ??
          placeNew(store.read(), DEFAULT_REGION_SIZE, { anchorIds: placement.anchorIds ?? [] }).rect;
        const region: Region = {
          id: regionId,
          title: args.title as string,
          bounds,
          ...(args.semanticEntityIds ? { semanticEntityIds: args.semanticEntityIds as string[] } : {}),
          ...(args.color ? { color: args.color as string } : {}),
        };
        const saved = store.transact(() => store.putRegion(region));
        return {
          output: { regionId, bounds: saved.bounds },
          changes: [{ id: regionId, change: "created", revision: saved.revision ?? 1 }],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      operation: "region.update",
      argumentsSchema: {
        type: "object",
        required: ["regionId"],
        properties: {
          regionId: ref("common.schema.json#/$defs/RegionId"),
          title: { type: "string", minLength: 1 },
          bounds: ref("common.schema.json#/$defs/Rect"),
          semanticEntityIds: { type: "array", items: ref("common.schema.json#/$defs/SemanticEntityId"), uniqueItems: true },
          color: { type: "string" },
        },
        additionalProperties: false,
      },
      check(args) {
        requireRegion(store, args.regionId as string);
        requireEntities(store, args.semanticEntityIds as string[] | undefined, "/semanticEntityIds");
      },
      handle(args) {
        const current = requireRegion(store, args.regionId as string);
        const { regionId: _id, ...patch } = args;
        const next = { ...current, ...(patch as Partial<Region>) };
        if (JSON.stringify(next) === JSON.stringify(current)) {
          return { changes: [{ id: current.id, change: "unchanged", revision: current.revision ?? 1 }] };
        }
        const saved = store.transact(() => store.putRegion(next));
        return { output: { bounds: saved.bounds }, changes: [{ id: saved.id, change: "updated", revision: saved.revision ?? 1 }], workspaceRevision: store.revision };
      },
    },

    {
      // Remove só a moldura: os objetos de dentro continuam no canvas.
      operation: "region.delete",
      argumentsSchema: {
        type: "object",
        required: ["regionId"],
        properties: { regionId: ref("common.schema.json#/$defs/RegionId") },
        additionalProperties: false,
      },
      handle(args) {
        const regionId = args.regionId as string;
        if (!store.region(regionId)) return { changes: [{ id: regionId, change: "unchanged" }] };
        store.transact(() => store.deleteRegion(regionId));
        return { changes: [{ id: regionId, change: "deleted" }], workspaceRevision: store.revision };
      },
    },

  ];
}

function requireRegion(store: WorkspaceStore, id: string): Region {
  const region = store.region(id);
  if (!region) throw new OperationError("TARGET_NOT_FOUND", `Região ${id} não existe.`, { targetId: id });
  return region;
}

/** Vínculos semânticos precisam apontar para entidades que existem (nunca referências inventadas). */
export function requireEntities(store: WorkspaceStore, ids: string[] | undefined, argumentPath: string) {
  for (const [i, id] of (ids ?? []).entries()) {
    if (!store.entity(id)) {
      throw new OperationError("REFERENCE_INVALID", `Entidade semântica '${id}' não existe.`, {
        argumentPath: `${argumentPath}/${i}`,
        targetId: id,
      });
    }
  }
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
