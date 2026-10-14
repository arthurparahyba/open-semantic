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

/** Operações do Project Runtime: leitura, gravação, criação de arquivo e comandos (doc 07). */
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
      agent: {
        guide: "{projectId, rootId, path} creates a folder. Output: /output/artifacts/0/id is the folder's artifactId.",
        describe: (args) => `criar a pasta ${String(args.path)}/`,
      },
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
      agent: {
        guide: "{artifactId, content, expectedContentHash?} overwrites an existing file (needs confirmation). Pass the contentHash from read_file.",
        describe: () => "gravar alterações em um arquivo",
        confirm: () => ({ risk: "high", summary: "Gravar alterações em um arquivo do projeto.", reversible: false }),
      },
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
    {
      operation: "project.create_file",
      agent: {
        guide: "{projectId, rootId, path, content} creates a NEW file (and its folders) with this content (needs confirmation). Fails if the file exists: change an existing file with read_file then project.write_file.",
        describe: (args) => `criar o arquivo ${String(args.path)}`,
        confirm: (args) => ({ risk: "medium", summary: `Criar o arquivo ${String(args.path)} no projeto.`, reversible: false }),
      },
      argumentsSchema: {
        type: "object",
        required: ["projectId", "rootId", "path", "content"],
        properties: {
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          rootId: ref("common.schema.json#/$defs/RootId"),
          path: ref("common.schema.json#/$defs/ProjectRelativePath"),
          content: { type: "string" },
        },
        additionalProperties: false,
      },
      redact: (args) => ({ ...args, content: `[${String(args.content).length} caracteres]` }),
      async handle(args, { request }) {
        const target = { projectId: args.projectId as string, rootId: args.rootId as string, path: args.path as string };
        const { artifact, fingerprint } = await runtime.createFile(target, args.content as string, {
          actor: request.authorization.actor,
          operationId: request.operationId,
        });
        return { output: { artifactId: artifact.id, fingerprint }, changes: [{ id: artifact.id, change: "created" }] };
      },
    },
    {
      // Comando no projeto (doc 07, política de comandos): o usuário aprova o comando exato e a pasta.
      operation: "project.run_command",
      agent: {
        guide:
          "{projectId, rootId, command, cwd?, timeoutMs?} runs a shell command in the project (needs confirmation), e.g. the project's tests (./mvnw test, npm test). cwd is a folder relative to the root. Output: exitCode, timedOut and the end of the output.",
        describe: (args) => `rodar ${String(args.command)}`,
        confirm: (args) => ({
          risk: "high",
          summary: `Rodar no projeto${args.cwd ? ` (pasta ${String(args.cwd)})` : ""}: ${String(args.command)}`.slice(0, 500),
          reversible: false,
        }),
      },
      argumentsSchema: {
        type: "object",
        required: ["projectId", "rootId", "command"],
        properties: {
          projectId: ref("common.schema.json#/$defs/ProjectId"),
          rootId: ref("common.schema.json#/$defs/RootId"),
          command: { type: "string", minLength: 1, maxLength: 1000 },
          cwd: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
        },
        additionalProperties: false,
      },
      async handle(args) {
        const result = await runtime.runCommand(args.projectId as string, args.rootId as string, args.command as string, {
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
        });
        return { output: { ...result }, changes: [] };
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
