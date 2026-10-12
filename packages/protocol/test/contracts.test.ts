// Mesmas checagens de contracts/validar.py, agora com o Ajv que o app usa.
// Garante que Python (jsonschema) e TypeScript (Ajv) concordam sobre os contratos.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { contractSchemas, contractValidator, describeErrors } from "../src/schemas.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/exemplos");
const load = (name: string) => JSON.parse(readFileSync(join(examples, name), "utf8"));

function expectValid(ref: string, value: unknown) {
  const validate = contractValidator(ref);
  const ok = validate(value);
  expect(ok, describeErrors(validate.errors)).toBe(true);
}

function expectInvalid(ref: string, value: unknown) {
  expect(contractValidator(ref)(value)).toBe(false);
}

describe("contratos", () => {
  it("registra os 8 schemas", () => {
    expect(contractSchemas).toHaveLength(8);
  });

  it("aceita os exemplos do fluxo de referência", () => {
    expectValid("workspace.schema.json", load("workspace-apos-lote.json"));
    expectValid("operation.schema.json#/$defs/BatchPlan", load("lote-referencia.json"));
    expectValid("operation.schema.json#/$defs/BatchResult", load("lote-resultado.json"));
    const rejected = load("operacao-rejeitada.json");
    expectValid("operation.schema.json#/$defs/OperationRequest", rejected.request);
    expectValid("operation.schema.json#/$defs/OperationResult", rejected.result);
  });

  it("recusa inferência do agente marcada como verificada (C3)", () => {
    const entity = load("workspace-apos-lote.json").semantic.entities[1];
    expect(entity.provenance.source).toBe("agent_inference");
    expectValid("semantic.schema.json#/$defs/SemanticEntity", entity);
    expectInvalid("semantic.schema.json#/$defs/SemanticEntity", { ...entity, status: "verified" });
  });

  it("recusa verificado sem evidência", () => {
    const entity = load("workspace-apos-lote.json").semantic.entities[0];
    expectValid("semantic.schema.json#/$defs/SemanticEntity", entity);
    const { evidenceIds: _, ...provenance } = entity.provenance;
    expectInvalid("semantic.schema.json#/$defs/SemanticEntity", { ...entity, provenance });
  });

  it.each(["../etc", "a/../b", "/etc/passwd", "C:/Windows", "a\\b"])("recusa caminho fora da raiz: %s", (path) => {
    expectInvalid("common.schema.json#/$defs/ProjectRelativePath", path);
  });

  it.each(["", "backend", "backend/src/server.js", "a..b"])("aceita caminho relativo: %s", (path) => {
    expectValid("common.schema.json#/$defs/ProjectRelativePath", path);
  });

  it("exige erro em resultados rejeitados", () => {
    expectInvalid("operation.schema.json#/$defs/OperationResult", {
      operationId: "act_x01",
      status: "rejected",
      completedAt: "2026-10-12T20:00:00Z",
    });
  });
});
