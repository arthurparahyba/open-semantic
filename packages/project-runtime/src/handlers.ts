import {
  OperationError,
  SCHEMA_BASE_URI,
  type Fingerprint,
  type OperationHandler,
  type PreconditionEvaluator,
} from "@open-semantic/protocol";

import type { ProjectRuntime } from "./runtime.js";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });
const artifactArg = { type: "object", required: ["artifactId"], properties: { artifactId: ref("common.schema.json#/$defs/ArtifactId") } };

/** Operações do Project Runtime disponíveis no M1 (leitura + gravação de arquivo existente). */
export function projectHandlers(runtime: ProjectRuntime): OperationHandler[] {
  return [
    {
      operation: "project.resolve",
      readOnly: true,
      argumentsSchema: {
        type: "object",
        required: ["projectId", "rootId", "path"],
        properties: {
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          rootId: ref("common.schema.json#/$defs/RootId"),
          path: { type: "string" },
        },
        additionalProperties: false,
      },
      async handle(args, { request }) {
        const artifact = await runtime.resolve(
          args.projectId as string,
          args.rootId as string,
          args.path as string,
          request.authorization.actor,
          request.operationId,
        );
        return { output: { artifact }, changes: [{ id: artifact.id, change: "unchanged" }] };
      },
    },
    {
      // Escrita leve: o agente pode criar diretórios sem confirmação (tabela de autorização em 06).
      operation: "project.create_dir",
      argumentsSchema: {
        type: "object",
        required: ["projectId", "rootId", "path"],
        properties: {
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          rootId: ref("common.schema.json#/$defs/RootId"),
          path: ref("common.schema.json#/$defs/ProjectRelativePath"),
        },
        additionalProperties: false,
      },
      async handle(args, { request }) {
        const { artifact, created } = await runtime.createDir(
          args.projectId as string,
          args.rootId as string,
          args.path as string,
          request.authorization.actor,
          request.operationId,
        );
        const path = "rootId" in artifact.locator ? artifact.locator.path : "";
        return {
          output: { artifacts: [{ id: artifact.id, path, kind: "directory" }] },
          changes: [{ id: artifact.id, change: created ? "created" : "unchanged" }],
        };
      },
    },
    {
      operation: "project.stat",
      readOnly: true,
      argumentsSchema: { ...artifactArg, additionalProperties: false },
      async handle(args) {
        const validity = await runtime.stat(args.artifactId as string);
        return { output: { validity }, changes: [] };
      },
    },
    {
      operation: "project.list_dir",
      readOnly: true,
      argumentsSchema: {
        ...artifactArg,
        properties: { ...artifactArg.properties, exclude: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      async handle(args, { request }) {
        const entries = await runtime.listDir(
          args.artifactId as string,
          (args.exclude as string[] | undefined) ?? undefined,
          request.authorization.actor,
        );
        return { output: { entries }, changes: [] };
      },
    },
    {
      operation: "project.read_file",
      readOnly: true,
      argumentsSchema: { ...artifactArg, additionalProperties: false },
      async handle(args) {
        const { content, fingerprint } = await runtime.readFile(args.artifactId as string);
        return { output: { content, fingerprint }, changes: [] };
      },
    },
    {
      operation: "project.write_file",
      argumentsSchema: {
        ...artifactArg,
        required: ["artifactId", "content"],
        properties: {
          ...artifactArg.properties,
          content: { type: "string" },
          expectedContentHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        },
        additionalProperties: false,
      },
      redact: (args) => ({ ...args, content: `[${String(args.content).length} caracteres]` }),
      async handle(args) {
        const fingerprint = await runtime.writeFile(
          args.artifactId as string,
          args.content as string,
          args.expectedContentHash as string | undefined,
        );
        return { output: { fingerprint }, changes: [{ id: args.artifactId as string, change: "updated" }] };
      },
    },
  ];
}

/** Avaliador da pré-condição artifact_unchanged. */
export function artifactUnchanged(runtime: ProjectRuntime): PreconditionEvaluator {
  return async (pre) => {
    if (pre.kind !== "artifact_unchanged") return { ok: false, message: "pré-condição inesperada" };
    try {
      return (await runtime.isUnchanged(pre.artifactId, pre.fingerprint as Fingerprint))
        ? { ok: true }
        : { ok: false, code: "EXTERNAL_CHANGE_CONFLICT", message: "O arquivo mudou fora do ambiente." };
    } catch (err) {
      return { ok: false, message: err instanceof OperationError ? err.message : String(err) };
    }
  };
}
