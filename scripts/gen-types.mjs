// Gera packages/protocol/src/generated/contracts.ts a partir de contracts/schemas.
// Todos os $defs dos arquivos são reunidos num único schema (referências entre
// arquivos viram referências locais), para que cada tipo seja emitido uma vez só.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "contracts/schemas");
const outFile = join(root, "packages/protocol/src/generated/contracts.ts");

const defs = {};
const owner = {};
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort()) {
  const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8"));
  for (const [name, def] of Object.entries(schema.$defs ?? {})) {
    if (owner[name]) throw new Error(`$def "${name}" definido em ${owner[name]} e ${file}`);
    owner[name] = file;
    defs[name] = def;
  }
  // O schema raiz do workspace é o snapshot completo.
  if (schema.type === "object" && schema.properties) {
    const { $schema: _schema, $id: _id, $defs: _defs, ...rootSchema } = schema;
    defs.WorkspaceSnapshot = rootSchema;
  }
}

// "common.schema.json#/$defs/X" e "#/$defs/X" → "#/$defs/X".
// Objetos livres ({"type": "object"} sem propriedades) viram Record<string, unknown> em vez de {}.
function rewrite(node) {
  if (Array.isArray(node)) return node.map(rewrite);
  if (node && typeof node === "object") {
    const out = {};
    if (node.type === "object" && !node.properties && !("additionalProperties" in node)) out.additionalProperties = true;
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "$ref" && typeof v === "string" ? v.replace(/^[a-z-]+\.schema\.json#/, "#") : rewrite(v);
    }
    return out;
  }
  return node;
}

// Títulos fazem o gerador usar o nome do $def como nome do tipo.
const bundled = { $defs: {} };
for (const [name, def] of Object.entries(rewrite(defs))) {
  const { title: _title, ...rest } = def;
  bundled.$defs[name] = { title: name, ...rest };
}

const ts = await compile({ title: "OpenSemanticContracts", type: "object", additionalProperties: false, ...bundled }, "OpenSemanticContracts", {
  bannerComment:
    "/* Gerado por scripts/gen-types.mjs a partir de contracts/schemas. Não edite à mão: rode `pnpm gen:types`. */",
  unreachableDefinitions: true,
  additionalProperties: false,
  strictIndexSignatures: true,
  format: true,
  style: { singleQuote: false, printWidth: 110 },
});

writeFileSync(outFile, ts);
console.log(`ok: ${Object.keys(bundled.$defs).length} tipos → ${outFile.replace(root + "/", "")}`);
