// Métricas de código limpo do código de produção (sem testes e sem tipos gerados).
//
//   node scripts/metrics.mjs                    relatório: funções longas, complexas ou com muitos parâmetros, classes e arquivos
//   node scripts/metrics.mjs --check            falha se uma função nova passar dos limites (as exceções conhecidas estão em metrics-baseline.json)
//   node scripts/metrics.mjs --update-baseline  regrava as exceções; use quando uma função sair da lista
//
// A lista de exceções só diminui: o --check também falha quando uma exceção deixou de existir, para a lista acompanhar o código.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeFile, isTest, sourceFiles } from "./lib/code.mjs";

/** Limites por função (README, seção "Guardrails do CI"). */
export const LIMITS = { lines: 80, complexity: 15, params: 4, depth: 4 };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = join(root, "scripts", "metrics-baseline.json");

const analyzed = sourceFiles(root)
  .filter((f) => !isTest(f))
  .map((f) => analyzeFile(root, f));

/** Funções acima de algum limite, com chave estável "arquivo#nome" (repetições ganham #2, #3…). */
function violations() {
  const out = new Map();
  for (const { file, functions } of analyzed) {
    const seen = new Map();
    for (const fn of functions) {
      const broken = Object.keys(LIMITS).filter((rule) => fn[rule] > LIMITS[rule]);
      if (broken.length === 0) continue;
      const n = (seen.get(fn.name) ?? 0) + 1;
      seen.set(fn.name, n);
      out.set(`${file}#${fn.name}${n > 1 ? `#${n}` : ""}`, { fn, broken });
    }
  }
  return out;
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselineFile, "utf8")).exceptions;
  } catch {
    return {};
  }
}

function check() {
  const current = violations();
  const baseline = readBaseline();
  const errors = [];
  for (const [key, { fn, broken }] of current) {
    const allowed = new Set(baseline[key] ?? []);
    for (const rule of broken.filter((r) => !allowed.has(r))) {
      errors.push(`${key} (linha ${fn.line}): ${rule} ${fn[rule]}, limite ${LIMITS[rule]}`);
    }
  }
  const stale = Object.entries(baseline).flatMap(([key, rules]) => rules.filter((r) => !current.get(key)?.broken.includes(r)).map((r) => `${key}: ${r}`));
  if (errors.length > 0) {
    console.error("Funções acima dos limites (divida a função ou, se for mesmo uma exceção, rode pnpm metrics:baseline e explique no PR):");
    for (const e of errors) console.error(`  ${e}`);
  }
  if (stale.length > 0) {
    console.error("Exceções que não existem mais (rode pnpm metrics:baseline para tirá-las da lista):");
    for (const s of stale) console.error(`  ${s}`);
  }
  if (errors.length > 0 || stale.length > 0) process.exit(1);
  console.log(`Métricas ok: ${current.size} exceções conhecidas, nenhuma nova.`);
}

function updateBaseline() {
  const exceptions = Object.fromEntries([...violations()].sort(([a], [b]) => a.localeCompare(b)).map(([key, { broken }]) => [key, broken]));
  // Uma exceção por linha, para o diff do PR mostrar o que entrou e o que saiu.
  const lines = Object.entries(exceptions).map(([key, rules]) => `    ${JSON.stringify(key)}: ${JSON.stringify(rules)}`);
  const comment = "Funções acima dos limites de scripts/metrics.mjs que já existiam. A lista só diminui; gerada por pnpm metrics:baseline.";
  const text = `{\n  "$comment": ${JSON.stringify(comment)},\n  "limits": ${JSON.stringify(LIMITS)},\n  "exceptions": {\n${lines.join(",\n")}\n  }\n}\n`;
  writeFileSync(baselineFile, text);
  console.log(`${Object.keys(exceptions).length} exceções gravadas em scripts/metrics-baseline.json.`);
}

function report() {
  const fns = analyzed.flatMap(({ file, functions }) => functions.map((fn) => ({ ...fn, file })));
  const table = (rows, cols) => rows.map((r) => cols.map((c) => String(r[c])).join(" | ")).join("\n");
  console.log(`Arquivos de produção: ${analyzed.length} · funções: ${fns.length} · limites: ${JSON.stringify(LIMITS)}`);
  console.log(`\n## Funções com mais de ${LIMITS.lines} linhas\nlinhas | complexidade | parâmetros | nome | arquivo | linha`);
  console.log(table(fns.filter((f) => f.lines > LIMITS.lines).sort((a, b) => b.lines - a.lines), ["lines", "complexity", "params", "name", "file", "line"]));
  console.log(`\n## Complexidade acima de ${LIMITS.complexity}\ncomplexidade | linhas | aninhamento | nome | arquivo | linha`);
  console.log(table(fns.filter((f) => f.complexity > LIMITS.complexity).sort((a, b) => b.complexity - a.complexity), ["complexity", "lines", "depth", "name", "file", "line"]));
  console.log(`\n## Mais de ${LIMITS.params} parâmetros ou aninhamento acima de ${LIMITS.depth}\nparâmetros | aninhamento | nome | arquivo | linha`);
  console.log(table(fns.filter((f) => f.params > LIMITS.params || f.depth > LIMITS.depth), ["params", "depth", "name", "file", "line"]));
  const classes = analyzed.flatMap(({ file, classes: cs }) => cs.map((c) => ({ ...c, file })));
  console.log("\n## Classes\nlinhas | métodos | nome | arquivo");
  console.log(table(classes.sort((a, b) => b.lines - a.lines), ["lines", "methods", "name", "file"]));
  console.log("\n## Arquivos com mais de 400 linhas\nlinhas | arquivo");
  console.log(table(analyzed.filter((f) => f.lines > 400).sort((a, b) => b.lines - a.lines), ["lines", "file"]));
}

if (process.argv.includes("--check")) check();
else if (process.argv.includes("--update-baseline")) updateBaseline();
else report();
