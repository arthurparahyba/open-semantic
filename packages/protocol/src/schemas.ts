import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import common from "../../../contracts/schemas/common.schema.json" with { type: "json" };
import diagram from "../../../contracts/schemas/diagram.schema.json" with { type: "json" };
import mod from "../../../contracts/schemas/mod.schema.json" with { type: "json" };
import navigation from "../../../contracts/schemas/navigation.schema.json" with { type: "json" };
import operation from "../../../contracts/schemas/operation.schema.json" with { type: "json" };
import project from "../../../contracts/schemas/project.schema.json" with { type: "json" };
import semantic from "../../../contracts/schemas/semantic.schema.json" with { type: "json" };
import workspace from "../../../contracts/schemas/workspace.schema.json" with { type: "json" };

export const SCHEMA_BASE_URI = "https://schemas.open-semantic.invalid/v0.2/";

export const contractSchemas = [common, project, semantic, mod, diagram, navigation, workspace, operation];

// ajv-formats é CommonJS; o default import pode vir embrulhado conforme o carregador.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: Ajv2020,
) => void;

/** Cria um Ajv com todos os schemas de contracts/ registrados pelo $id. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  for (const schema of contractSchemas) ajv.addSchema(schema);
  return ajv;
}

const shared = createAjv();
const cache = new Map<string, ValidateFunction>();

/**
 * Validador para uma referência relativa à base, por exemplo
 * "operation.schema.json#/$defs/OperationRequest" ou "workspace.schema.json".
 */
export function contractValidator(ref: string): ValidateFunction {
  let fn = cache.get(ref);
  if (!fn) {
    fn = shared.compile({ $ref: SCHEMA_BASE_URI + ref });
    cache.set(ref, fn);
  }
  return fn;
}

/** Compila um schema avulso (por exemplo, o schema de argumentos de uma operação) que pode citar os contratos. */
export function compileWithContracts(schema: object): ValidateFunction {
  return shared.compile(schema);
}

/** Escolhe o erro mais útil para mostrar: o mais profundo, que costuma apontar o campo exato. */
export function primaryError(errors: ErrorObject[] | null | undefined): ErrorObject | undefined {
  if (!errors?.length) return undefined;
  return [...errors].sort((a, b) => b.instancePath.length - a.instancePath.length)[0];
}

export function describeErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "inválido";
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
    .join("; ");
}
