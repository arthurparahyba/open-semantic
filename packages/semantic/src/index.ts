// Open Semantic, parte mínima do M2: registrar observações (verificadas, com evidência) e inferências
// do agente, e consultar por nome. Revalidação, trace e vínculos com a interface entram no M3
// (docs/funcionalidades/05-open-semantic.md). O armazenamento é o snapshot do workspace (decisão D2).
import {
  OperationError,
  SCHEMA_BASE_URI,
  contractValidator,
  describeErrors,
  sameValue,
  type Change,
  type Evidence,
  type OperationHandler,
  type Provenance,
  type SemanticEntity,
  type SemanticRelation,
} from "@open-semantic/protocol";
import type { WorkspaceStore } from "@open-semantic/workspace-store";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });
const validateEntity = contractValidator("semantic.schema.json#/$defs/SemanticEntity");
const validateRelation = contractValidator("semantic.schema.json#/$defs/SemanticRelation");

const entityInput = {
  type: "object",
  required: ["id", "kind", "name"],
  properties: {
    id: ref("common.schema.json#/$defs/SemanticEntityId"),
    kind: ref("semantic.schema.json#/$defs/EntityKind"),
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    aliases: { type: "array", items: { type: "string" }, uniqueItems: true },
    projectId: ref("common.schema.json#/$defs/ProjectId"),
    artifactIds: { type: "array", items: ref("common.schema.json#/$defs/ArtifactId"), uniqueItems: true },
    attributes: { type: "object" },
  },
  additionalProperties: false,
};

const relationInput = {
  type: "object",
  required: ["id", "type", "sourceId", "targetId"],
  properties: {
    id: ref("common.schema.json#/$defs/RelationId"),
    type: ref("semantic.schema.json#/$defs/RelationType"),
    sourceId: ref("common.schema.json#/$defs/SemanticEntityId"),
    targetId: ref("common.schema.json#/$defs/SemanticEntityId"),
    attributes: { type: "object" },
  },
  additionalProperties: false,
};

type EntityInput = Pick<SemanticEntity, "id" | "kind" | "name"> &
  Partial<Pick<SemanticEntity, "description" | "aliases" | "projectId" | "artifactIds" | "attributes">>;
type RelationInput = Pick<SemanticRelation, "id" | "type" | "sourceId" | "targetId"> & Partial<Pick<SemanticRelation, "attributes">>;

/**
 * Evidências que sustentam uma observação: só inspeção, execução ou afirmação do usuário (doc 05, status `verified`).
 * `agent_reasoning` fica de fora de propósito: raciocínio do agente entra como inferência.
 */
export const OBSERVATION_EVIDENCE_KINDS = [
  "file_inspection",
  "directory_listing",
  "command_execution",
  "user_statement",
  "diagram_edit",
] as const;

export function semanticHandlers({ store }: { store: WorkspaceStore }): OperationHandler[] {
  const requireArtifact = (id: string, path: string) => {
    if (!store.artifact(id)) {
      throw new OperationError("REFERENCE_INVALID", `Artefato '${id}' não existe no workspace.`, { argumentPath: path, targetId: id });
    }
  };
  const requireArtifacts = (ids: string[] | undefined, path: string) => {
    for (const [i, id] of (ids ?? []).entries()) {
      if (!store.artifact(id)) {
        throw new OperationError("REFERENCE_INVALID", `Artefato '${id}' não existe no workspace.`, {
          argumentPath: `${path}/${i}`,
          targetId: id,
        });
      }
    }
  };

  const requireProject = (projectId: string | undefined, path: string) => {
    if (projectId && !store.project(projectId)) {
      throw new OperationError("REFERENCE_INVALID", `Projeto '${projectId}' não existe.`, { argumentPath: path, targetId: projectId });
    }
  };

  /** Grava a entidade se algo mudou; devolve a mudança. */
  const saveEntity = (next: SemanticEntity): Change => {
    if (!validateEntity(next)) {
      throw new OperationError("INVALID_ARGUMENTS", `Entidade fora do contrato: ${describeErrors(validateEntity.errors)}`);
    }
    const current = store.entity(next.id);
    if (current && sameKnowledge(current, next)) return { id: next.id, change: "unchanged", revision: current.revision };
    const saved = store.putEntity(next);
    return { id: saved.id, change: current ? "updated" : "created", revision: saved.revision };
  };

  const saveRelation = (next: SemanticRelation): Change => {
    if (!validateRelation(next)) {
      throw new OperationError("INVALID_ARGUMENTS", `Relação fora do contrato: ${describeErrors(validateRelation.errors)}`);
    }
    const current = store.relation(next.id);
    if (current && sameKnowledge(current, next)) return { id: next.id, change: "unchanged", revision: current.revision };
    const saved = store.putRelation(next);
    return { id: saved.id, change: current ? "updated" : "created", revision: saved.revision };
  };

  const merge = (input: EntityInput, current: SemanticEntity | undefined): Omit<SemanticEntity, "status" | "provenance" | "revision"> => {
    const artifactIds = [...new Set([...(current?.artifactIds ?? []), ...(input.artifactIds ?? [])])];
    return {
      ...(current ? stripKnowledge(current) : {}),
      ...input,
      artifactIds,
    };
  };

  return [
    {
      operation: "semantic.upsert_observation",
      argumentsSchema: {
        type: "object",
        required: ["entity", "evidence"],
        properties: {
          entity: entityInput,
          relations: { type: "array", items: relationInput },
          evidence: {
            type: "object",
            required: ["id", "kind", "summary"],
            properties: {
              id: ref("common.schema.json#/$defs/EvidenceId"),
              kind: { enum: OBSERVATION_EVIDENCE_KINDS },
              artifactId: ref("common.schema.json#/$defs/ArtifactId"),
              span: ref("semantic.schema.json#/$defs/Evidence/properties/span"),
              summary: { type: "string", minLength: 1, maxLength: 2000 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      check(args) {
        const entity = args.entity as EntityInput;
        const evidence = args.evidence as { id: string; kind: string; artifactId?: string };
        requireProject(entity.projectId, "/entity/projectId");
        requireArtifacts(entity.artifactIds, "/entity/artifactIds");
        if (evidence.artifactId) requireArtifact(evidence.artifactId, "/evidence/artifactId");
        if ((evidence.kind === "file_inspection" || evidence.kind === "directory_listing") && !evidence.artifactId) {
          throw new OperationError("INVALID_ARGUMENTS", "Evidência de inspeção precisa do artefato inspecionado.", {
            argumentPath: "/evidence/artifactId",
          });
        }
        const existing = store.evidence(evidence.id);
        if (existing && existing.summary !== (args.evidence as { summary: string }).summary) {
          throw new OperationError("PRECONDITION_FAILED", "Evidências são imutáveis; use um id novo.", { targetId: evidence.id });
        }
        checkRelationEnds(store, (args.relations as RelationInput[] | undefined) ?? [], [entity.id], "/relations");
      },
      handle(args, { request, now }) {
        const input = args.entity as EntityInput;
        const ev = args.evidence as Omit<Evidence, "status" | "observedAt" | "operationId">;
        const at = now().toISOString();
        const source = sourceFor(store, ev);
        const changes: Change[] = [];
        store.transact(() => {
          const evidence: Evidence = { ...ev, operationId: request.operationId, status: "current", observedAt: at };
          if (request.turnId) evidence.turnId = request.turnId;
          if (store.addEvidence(evidence)) changes.push({ id: evidence.id, change: "created" });
          const provenance = (current?: Provenance): Provenance => ({
            source,
            actor: request.authorization.actor,
            operationId: request.operationId,
            evidenceIds: [...new Set([...(current?.evidenceIds ?? []), ev.id])],
            recordedAt: at,
          });
          const current = store.entity(input.id);
          changes.push(saveEntity({ ...merge(input, current), status: "verified", provenance: provenance(current?.provenance), revision: 0 } as SemanticEntity));
          for (const rel of (args.relations as RelationInput[] | undefined) ?? []) {
            const existing = store.relation(rel.id);
            changes.push(saveRelation({ ...rel, status: "verified", provenance: provenance(existing?.provenance), revision: 0 } as SemanticRelation));
          }
        });
        return {
          output: { entityId: input.id, status: "verified" },
          changes,
          workspaceRevision: store.revision,
        };
      },
    },

    {
      operation: "semantic.upsert_inference",
      argumentsSchema: {
        type: "object",
        required: ["confidence", "rationale"],
        properties: {
          entities: { type: "array", items: entityInput },
          relations: { type: "array", items: relationInput },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string", minLength: 1, maxLength: 2000 },
        },
        anyOf: [{ required: ["entities"] }, { required: ["relations"] }],
        additionalProperties: false,
      },
      check(args) {
        const entities = (args.entities as EntityInput[] | undefined) ?? [];
        for (const [i, e] of entities.entries()) {
          requireProject(e.projectId, `/entities/${i}/projectId`);
          requireArtifacts(e.artifactIds, `/entities/${i}/artifactIds`);
        }
        checkRelationEnds(store, (args.relations as RelationInput[] | undefined) ?? [], entities.map((e) => e.id), "/relations");
      },
      handle(args, { request, now }) {
        const at = now().toISOString();
        const provenance: Provenance = {
          source: "agent_inference",
          actor: request.authorization.actor,
          operationId: request.operationId,
          ...(request.turnId ? { turnId: request.turnId } : {}),
          confidence: args.confidence as number,
          rationale: args.rationale as string,
          recordedAt: at,
        };
        const entities = (args.entities as EntityInput[] | undefined) ?? [];
        const relations = (args.relations as RelationInput[] | undefined) ?? [];
        const changes: Change[] = [];
        store.transact(() => {
          for (const input of entities) {
            const current = store.entity(input.id);
            // Uma inferência nunca rebaixa conhecimento verificado (critério C3).
            if (current?.status === "verified") {
              changes.push({ id: current.id, change: "unchanged", revision: current.revision });
              continue;
            }
            changes.push(saveEntity({ ...merge(input, current), status: "inferred", provenance, revision: 0 } as SemanticEntity));
          }
          for (const rel of relations) {
            const current = store.relation(rel.id);
            if (current?.status === "verified") {
              changes.push({ id: current.id, change: "unchanged", revision: current.revision });
              continue;
            }
            changes.push(saveRelation({ ...rel, status: "inferred", provenance, revision: 0 } as SemanticRelation));
          }
        });
        return {
          output: { entityIds: entities.map((e) => e.id), relationIds: relations.map((r) => r.id), status: "inferred" },
          changes,
          workspaceRevision: store.revision,
        };
      },
    },

    {
      // Busca simples por nome, apelido ou tipo, para o agente montar contexto. Consultas ricas entram no M3.
      operation: "semantic.query",
      readOnly: true,
      argumentsSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: ref("semantic.schema.json#/$defs/EntityKind"),
          ids: { type: "array", items: ref("common.schema.json#/$defs/SemanticEntityId") },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      handle(args) {
        const text = (args.text as string | undefined)?.toLowerCase();
        const ids = args.ids ? new Set(args.ids as string[]) : undefined;
        const { semantic } = store.read();
        const entities = semantic.entities
          .filter((e) => !ids || ids.has(e.id))
          .filter((e) => !args.kind || e.kind === args.kind)
          .filter((e) => !text || [e.name, ...(e.aliases ?? [])].some((n) => n.toLowerCase().includes(text)))
          .slice(0, (args.limit as number | undefined) ?? 50);
        const found = new Set(entities.map((e) => e.id));
        const relations = semantic.relations.filter((r) => found.has(r.sourceId) || found.has(r.targetId));
        return { output: { entities: structuredClone(entities), relations: structuredClone(relations) }, changes: [] };
      },
    },
  ];
}

function checkRelationEnds(store: WorkspaceStore, relations: RelationInput[], declared: string[], path: string) {
  const known = new Set(declared);
  for (const [i, rel] of relations.entries()) {
    for (const end of ["sourceId", "targetId"] as const) {
      const id = rel[end];
      if (!known.has(id) && !store.entity(id)) {
        throw new OperationError("REFERENCE_INVALID", `Relação '${rel.id}' aponta para a entidade inexistente '${id}'.`, {
          argumentPath: `${path}/${i}/${end}`,
          targetId: id,
        });
      }
    }
  }
}

/**
 * De onde veio o conhecimento verificado. Um diretório que o próprio agente criou por uma operação
 * conta como execução; um que já existia e foi inspecionado conta como inspeção.
 */
function sourceFor(store: WorkspaceStore, evidence: { kind: string; artifactId?: string }): Provenance["source"] {
  switch (evidence.kind) {
    case "command_execution":
      return "execution";
    case "user_statement":
      return "user_statement";
    case "diagram_edit":
      return "diagram_edit";
    default: {
      const artifact = evidence.artifactId ? store.artifact(evidence.artifactId) : undefined;
      return artifact?.provenance?.source === "execution" ? "execution" : "inspection";
    }
  }
}

function stripKnowledge<T extends { status: unknown; provenance: unknown; revision: unknown }>(value: T) {
  const { status: _s, provenance: _p, revision: _r, ...rest } = value;
  return rest;
}

/** Igual em conteúdo e status, ignorando quando e por qual operação foi registrado. */
function sameKnowledge(a: SemanticEntity | SemanticRelation, b: SemanticEntity | SemanticRelation): boolean {
  const norm = (x: SemanticEntity | SemanticRelation) => {
    const { operationId: _o, recordedAt: _r, turnId: _t, ...provenance } = x.provenance;
    return { ...stripKnowledge(x), status: x.status, provenance };
  };
  return sameValue(norm(a), norm(b));
}
