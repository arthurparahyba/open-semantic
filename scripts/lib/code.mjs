// Leitura do código TypeScript do repositório para as checagens do CI (métricas e fronteiras entre pacotes).
// Usa o parser do oxc que vem com o rolldown, porque o TypeScript 7 não tem API em JavaScript.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAst } from "rolldown/parseAst";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const DECISION_TYPES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "LogicalExpression",
]);
const NESTING_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
]);

export const isTest = (file) => /(^|\/)(test|e2e)\//.test(file) || /\.(test|spec)\.tsx?$/.test(file);

/** Arquivos .ts e .tsx versionados, sem os gerados e as declarações. */
export function sourceFiles(root) {
  return execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("/generated/") && !f.endsWith(".d.ts"));
}

/** Pacote dono de um arquivo: o nome da pasta em packages/ ou apps/. */
export const packageOf = (file) => file.match(/^(?:packages|apps)\/([^/]+)\//)?.[1];

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") out.push(child);
    }
  }
  return out;
}

function keyName(key) {
  if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") return key.name;
  if (key?.type === "Literal") return String(key.value);
  return "[computado]";
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Complexidade ciclomática e aninhamento de uma função, sem contar as funções dentro dela. */
function measure(fn) {
  let complexity = 1;
  let depth = 0;
  const walk = (node, level) => {
    for (const child of children(node)) {
      if (FUNCTION_TYPES.has(child.type)) continue;
      if (DECISION_TYPES.has(child.type) || (child.type === "SwitchCase" && child.test)) complexity++;
      const next = NESTING_TYPES.has(child.type) ? level + 1 : level;
      depth = Math.max(depth, next);
      walk(child, next);
    }
  };
  walk(fn.body ?? fn, 0);
  return { complexity, depth };
}

/** Handler registrado como objeto ({ operation: "x.y", handle() {...} }): as funções levam o nome da operação. */
const operationName = (node) =>
  node.properties.find((p) => p.type === "Property" && keyName(p.key) === "operation" && p.value?.type === "Literal")?.value.value;

/**
 * Funções, classes e imports de um arquivo. Cada função tem nome estável (método, variável ou operação)
 * para que a lista de exceções das métricas sobreviva a mudanças de linha.
 */
export function analyzeFile(root, file) {
  const src = readFileSync(join(root, file), "utf8");
  const lineOf = lineIndex(src);
  const ast = parseAst(src, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }, file);
  const out = { file, lines: src.split("\n").length, functions: [], classes: [], imports: [] };
  const lines = (node) => lineOf(node.end) - lineOf(node.start) + 1;

  const visit = (node, name) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source) {
          const typeOnly = node.importKind === "type" || node.exportKind === "type" || (node.specifiers?.length > 0 && node.specifiers.every((s) => s.importKind === "type" || s.exportKind === "type"));
          out.imports.push({ from: node.source.value, typeOnly, line: lineOf(node.start) });
        }
        break;
      case "ImportExpression":
        if (node.source?.type === "Literal") out.imports.push({ from: node.source.value, typeOnly: false, line: lineOf(node.start) });
        break;
      case "ClassDeclaration":
      case "ClassExpression": {
        const className = node.id?.name ?? name ?? "(anônima)";
        const methods = node.body.body.filter((m) => m.type === "MethodDefinition");
        out.classes.push({ name: className, line: lineOf(node.start), lines: lines(node), methods: methods.length });
        for (const member of node.body.body) {
          if (member.type === "MethodDefinition") visit(member.value, `${className}.${keyName(member.key)}`);
          else visit(member, name);
        }
        return;
      }
      case "VariableDeclarator":
        if (node.init && FUNCTION_TYPES.has(node.init.type)) return visit(node.init, node.id?.name);
        break;
      case "Property":
        if (node.value && FUNCTION_TYPES.has(node.value.type)) return visit(node.value, keyName(node.key));
        break;
      case "ObjectExpression": {
        const operation = operationName(node);
        if (!operation) break;
        for (const p of node.properties) {
          if (p.type === "Property" && p.value && FUNCTION_TYPES.has(p.value.type)) visit(p.value, `${operation}.${keyName(p.key)}`);
          else visit(p, name);
        }
        return;
      }
    }
    if (FUNCTION_TYPES.has(node.type)) {
      const fnName = node.id?.name ?? name ?? "(anônima)";
      out.functions.push({ name: fnName, line: lineOf(node.start), lines: lines(node), params: node.params.length, ...measure(node) });
      for (const child of children(node)) visit(child, `${fnName} › (interna)`);
      return;
    }
    for (const child of children(node)) visit(child, name);
  };
  visit(ast, undefined);
  return out;
}
