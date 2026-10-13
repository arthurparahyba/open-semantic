import {
  OperationError,
  SCHEMA_BASE_URI,
  compileWithContracts,
  describeErrors,
  sameValue,
  type ModInstance,
  type ModTypeDescriptor,
  type OperationHandler,
} from "@open-semantic/protocol";
import { placeNew, placedBy, repositoryUnit, requireEntities, type PlacementRequest, type WorkspaceStore } from "@open-semantic/workspace-store";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });

/** Catálogo do M1. Terminal e Tabela entram no M4 (docs/funcionalidades/02-mods.md). */
export const MOD_TYPES: ModTypeDescriptor[] = [
  {
    type: "explorer",
    version: 1,
    title: "Explorer",
    defaultSize: { width: 320, height: 480 },
    configSchema: ref("mod.schema.json#/$defs/ExplorerConfig"),
    uiStateSchema: ref("mod.schema.json#/$defs/ExplorerUiState"),
    capabilities: [
      { name: "explorer.navigate", description: "Muda a pasta atual.", requires: ["read"], idempotent: true, confirmation: "never" },
      { name: "explorer.reveal", description: "Expande e seleciona um artefato.", requires: ["read"], idempotent: true, confirmation: "never" },
    ],
  },
  {
    type: "editor",
    version: 1,
    title: "Editor de texto",
    defaultSize: { width: 560, height: 480 },
    configSchema: ref("mod.schema.json#/$defs/EditorConfig"),
    capabilities: [
      { name: "editor.open_file", requires: ["read"], idempotent: true, confirmation: "never" },
      { name: "editor.save", requires: ["write"], idempotent: true, confirmation: "policy" },
      { name: "editor.reload", requires: ["read"], idempotent: true, confirmation: "policy" },
    ],
  },
];

const descriptors = new Map(MOD_TYPES.map((d) => [d.type, d]));
const configValidators = new Map(MOD_TYPES.map((d) => [d.type, compileWithContracts(d.configSchema)]));
const uiValidators = new Map(
  MOD_TYPES.filter((d) => d.uiStateSchema).map((d) => [d.type, compileWithContracts(d.uiStateSchema!)]),
);

/** Referência a artefato que cada tipo exige na configuração, e o tipo de artefato esperado. */
const REQUIRED_ARTIFACT: Record<string, { key: string; kind: "directory" | "file" }> = {
  explorer: { key: "rootRef", kind: "directory" },
  editor: { key: "fileRef", kind: "file" },
};

export interface ModHandlerDeps {
  store: WorkspaceStore;
}

export function modHandlers({ store }: ModHandlerDeps): OperationHandler[] {
  const requireMod = (modId: string): ModInstance => {
    const mod = store.mod(modId);
    if (!mod) throw new OperationError("TARGET_NOT_FOUND", `Mod ${modId} não existe.`, { targetId: modId });
    return mod;
  };

  const validateConfig = (type: string, config: Record<string, unknown>) => {
    const validate = configValidators.get(type)!;
    if (!validate(config)) {
      throw new OperationError("INVALID_ARGUMENTS", `Configuração inválida para ${type}: ${describeErrors(validate.errors)}`, {
        argumentPath: "/config" + (validate.errors?.[0]?.instancePath ?? ""),
      });
    }
    const required = REQUIRED_ARTIFACT[type];
    if (required) {
      const artifactId = config[required.key] as string;
      const artifact = store.artifact(artifactId);
      if (!artifact) {
        throw new OperationError(
          "REFERENCE_INVALID",
          `${required.key} '${artifactId}' não existe no workspace. Referências a artefatos são criadas pelo Project Runtime.`,
          { argumentPath: `/config/${required.key}`, targetId: artifactId },
        );
      }
      if (artifact.kind !== required.kind) {
        throw new OperationError("REFERENCE_INVALID", `${required.key} precisa ser um ${required.kind === "file" ? "arquivo" : "diretório"}.`, {
          argumentPath: `/config/${required.key}`,
          targetId: artifactId,
        });
      }
      return artifact;
    }
    return undefined;
  };

  const validateUi = (type: string, uiState: Record<string, unknown>) => {
    const validate = uiValidators.get(type);
    if (validate && !validate(uiState)) {
      throw new OperationError("INVALID_ARGUMENTS", `Estado de interface inválido: ${describeErrors(validate.errors)}`, {
        argumentPath: "/uiState" + (validate.errors?.[0]?.instancePath ?? ""),
      });
    }
  };

  const lifecycle = (operation: "mod.close" | "mod.reopen", target: "active" | "closed"): OperationHandler => ({
    operation,
    argumentsSchema: {
      type: "object",
      required: ["modId"],
      properties: { modId: ref("common.schema.json#/$defs/ModId") },
      additionalProperties: false,
    },
    check: (args) => void requireMod(args.modId as string),
    handle(args) {
      const mod = requireMod(args.modId as string);
      if (mod.lifecycle === target) {
        return { output: { lifecycle: target }, changes: [{ id: mod.id, change: "unchanged", revision: mod.revision }] };
      }
      const saved = store.transact(() => {
        const object = store.canvasObject(mod.id);
        if (object) store.placeObject({ ...object, collapsed: target === "closed" });
        return store.putMod({ ...mod, lifecycle: target });
      });
      return {
        output: { lifecycle: target },
        changes: [{ id: saved.id, change: "updated", revision: saved.revision }],
        workspaceRevision: store.revision,
      };
    },
  });

  return [
    {
      operation: "mod.list_types",
      readOnly: true,
      argumentsSchema: { type: "object", additionalProperties: false },
      handle: () => ({ output: { types: MOD_TYPES }, changes: [] }),
    },

    {
      operation: "mod.create",
      argumentsSchema: {
        type: "object",
        required: ["modId", "type", "config"],
        properties: {
          modId: ref("common.schema.json#/$defs/ModId"),
          type: ref("mod.schema.json#/$defs/ModType"),
          title: { type: "string" },
          config: { type: "object" },
          uiState: { type: "object" },
          semanticEntityIds: { type: "array", items: ref("common.schema.json#/$defs/SemanticEntityId") },
          placement: {
            type: "object",
            properties: {
              strategy: { const: "free_space_near" },
              position: ref("common.schema.json#/$defs/Point"),
              anchorIds: { type: "array", items: ref("common.schema.json#/$defs/VisualTargetId") },
              regionId: ref("common.schema.json#/$defs/RegionId"),
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      check(args) {
        const type = args.type as string;
        if (!descriptors.has(type)) {
          throw new OperationError("CAPABILITY_NOT_SUPPORTED", `Tipo de mod '${type}' não está registrado.`, {
            argumentPath: "/type",
            details: { known: [...descriptors.keys()] },
          });
        }
        validateConfig(type, args.config as Record<string, unknown>);
        requireEntities(store, args.semanticEntityIds as string[] | undefined, "/semanticEntityIds");
        const regionId = (args.placement as { regionId?: string } | undefined)?.regionId;
        if (regionId && !store.region(regionId)) {
          throw new OperationError("REFERENCE_INVALID", `Região '${regionId}' não existe.`, { argumentPath: "/placement/regionId", targetId: regionId });
        }
        if (args.uiState) validateUi(type, args.uiState as Record<string, unknown>);
        const existing = store.mod(args.modId as string);
        if (existing && (existing.type !== type || !sameValue(existing.config, args.config))) {
          throw new OperationError("PRECONDITION_FAILED", "Já existe um mod com esse id e outra configuração; use mod.configure.", {
            targetId: existing.id,
          });
        }
      },
      handle(args, { request, now }) {
        const modId = args.modId as string;
        const existing = store.mod(modId);
        if (existing) {
          return { output: { modId, ...store.canvasObject(modId) }, changes: [{ id: modId, change: "unchanged", revision: existing.revision }] };
        }
        const type = args.type as string;
        const descriptor = descriptors.get(type)!;
        const config = args.config as Record<string, unknown>;
        const artifact = validateConfig(type, config);
        const size = descriptor.defaultSize ?? { width: 360, height: 480 };
        // O mod fica junto da unidade de contexto dele: a primeira entidade pedida ou o repositório do arquivo (doc 09).
        const unitId =
          (args.semanticEntityIds as string[] | undefined)?.[0] ?? (artifact ? repositoryUnit(store.read(), artifact.projectId)?.id : undefined);
        const { rect, regionId, grownRegion } = placeNew(store.read(), size, {
          ...((args.placement ?? {}) as PlacementRequest),
          ...(unitId ? { unitId } : {}),
        });
        const name = artifact && "rootId" in artifact.locator ? artifact.locator.path.split("/").pop() : undefined;

        const mod: ModInstance = {
          id: modId,
          type,
          typeVersion: descriptor.version,
          ...(artifact ? { projectId: artifact.projectId } : {}),
          title: (args.title as string | undefined) ?? (name || descriptor.title),
          config,
          ...(args.uiState ? { uiState: args.uiState as Record<string, unknown> } : {}),
          ...(args.semanticEntityIds ? { semanticEntityIds: args.semanticEntityIds as string[] } : {}),
          lifecycle: "active",
          revision: 0,
          createdBy: request.authorization.actor,
          createdAt: now().toISOString(),
        };
        const saved = store.transact(() => {
          const zIndex = Math.max(0, ...store.read().canvas.objects.map((o) => o.zIndex ?? 0)) + 1;
          if (grownRegion) store.putRegion(grownRegion);
          store.placeObject({
            id: modId,
            objectKind: "mod",
            ...rect,
            zIndex,
            ...(regionId ? { regionId } : {}),
            placedBy: placedBy(request.authorization.actor),
          });
          return store.putMod(mod);
        });
        return {
          output: { modId, position: rect.position, size: rect.size },
          changes: [{ id: modId, change: "created", revision: saved.revision }],
          workspaceRevision: store.revision,
        };
      },
    },

    {
      operation: "mod.configure",
      argumentsSchema: {
        type: "object",
        required: ["modId"],
        properties: {
          modId: ref("common.schema.json#/$defs/ModId"),
          config: { type: "object" },
          uiState: { type: "object" },
          title: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      check(args) {
        const mod = requireMod(args.modId as string);
        if (args.config) validateConfig(mod.type, { ...mod.config, ...(args.config as object) });
        if (args.uiState) validateUi(mod.type, { ...mod.uiState, ...(args.uiState as object) });
      },
      handle(args) {
        const mod = requireMod(args.modId as string);
        const next: ModInstance = {
          ...mod,
          ...(args.title ? { title: args.title as string } : {}),
          config: { ...mod.config, ...(args.config as object | undefined) },
          ...(args.uiState || mod.uiState ? { uiState: { ...mod.uiState, ...(args.uiState as object | undefined) } } : {}),
        };
        if (sameValue(next, mod)) {
          return { changes: [{ id: mod.id, change: "unchanged", revision: mod.revision }] };
        }
        const saved = store.transact(() => store.putMod(next));
        return {
          output: { revision: saved.revision },
          changes: [{ id: saved.id, change: "updated", revision: saved.revision }],
          workspaceRevision: store.revision,
        };
      },
    },

    lifecycle("mod.close", "closed"),
    lifecycle("mod.reopen", "active"),

    {
      // Remove a instância e sua posição. Nunca apaga arquivos (critério A4).
      operation: "mod.delete",
      argumentsSchema: {
        type: "object",
        required: ["modId"],
        properties: { modId: ref("common.schema.json#/$defs/ModId") },
        additionalProperties: false,
      },
      handle(args) {
        const modId = args.modId as string;
        if (!store.mod(modId)) return { changes: [{ id: modId, change: "unchanged" }] };
        store.transact(() => store.deleteMod(modId));
        return { changes: [{ id: modId, change: "deleted" }], workspaceRevision: store.revision };
      },
    },
  ];
}
