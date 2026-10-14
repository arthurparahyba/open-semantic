// Fronteiras entre pacotes: falha se o código de produção importar um pacote fora da tabela abaixo.
// Uso: node scripts/check-boundaries.mjs
//
// A tabela é a arquitetura em camadas: contratos embaixo, store no meio, módulos de domínio por cima e o núcleo
// juntando tudo. Mudar a tabela é uma decisão de arquitetura; o package.json de cada pacote acompanha.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeFile, isTest, packageOf, sourceFiles } from "./lib/code.mjs";

const DOMAIN = ["protocol", "workspace-store"];

/** O que cada pacote pode importar de @open-semantic/*. */
const ALLOWED = {
  protocol: [],
  llm: [],
  // O motor de contexto não conhece o app: recebe unidades e diagramas já montados (docs/funcionalidades/08).
  "semantic-context": [],
  "workspace-store": ["protocol"],
  "project-runtime": DOMAIN,
  "mod-runtime": DOMAIN,
  semantic: DOMAIN,
  "diagram-engine": DOMAIN,
  navigator: DOMAIN,
  core: [...DOMAIN, "project-runtime", "mod-runtime", "semantic", "semantic-context", "diagram-engine", "navigator", "llm"],
  desktop: ["core", "llm", "protocol", "navigator", "workspace-store"],
};

/** Pastas fora de packages/ que um pacote lê direto: os schemas de contracts/ são a fonte do protocolo. */
const OUTSIDE = { protocol: ["contracts/"] };

/** A interface roda no navegador: de @open-semantic/* só importa tipos, mais estes módulos sem Node. */
const BROWSER_DIRS = ["apps/desktop/src/renderer/", "apps/desktop/src/shared/", "apps/desktop/src/preload/"];
const BROWSER_VALUES = ["@open-semantic/navigator", "@open-semantic/workspace-store/anchoring", "@open-semantic/workspace-store/commits", "@open-semantic/workspace-store/layers", "@open-semantic/workspace-store/diagramShapes", "@open-semantic/workspace-store/projects", "@open-semantic/workspace-store/layout", "@open-semantic/workspace-store/specs"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = (pkg) => {
  const dir = pkg === "desktop" ? "apps/desktop" : `packages/${pkg}`;
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
};

const problems = [];

for (const [pkg, allowed] of Object.entries(ALLOWED)) {
  const declared = Object.keys(manifest(pkg).dependencies ?? {}).filter((d) => d.startsWith("@open-semantic/"));
  for (const dep of declared) {
    if (!allowed.includes(dep.slice("@open-semantic/".length))) problems.push(`${pkg}/package.json: ${dep} não está entre as dependências permitidas de ${pkg}`);
  }
}

for (const file of sourceFiles(root).filter((f) => !isTest(f))) {
  const pkg = packageOf(file);
  if (!pkg) continue;
  if (!ALLOWED[pkg]) {
    problems.push(`${file}: pacote '${pkg}' não está na tabela de scripts/check-boundaries.mjs`);
    continue;
  }
  const declared = manifest(pkg).dependencies ?? {};
  const browser = BROWSER_DIRS.some((d) => file.startsWith(d));
  for (const { from, typeOnly, line } of analyzeFile(root, file).imports) {
    const at = `${file}:${line}`;
    if (from.startsWith(".")) {
      const target = normalize(join(dirname(file), from));
      const outside = OUTSIDE[pkg]?.some((dir) => target.startsWith(dir));
      if (packageOf(target) !== pkg && !outside) problems.push(`${at}: '${from}' sai do pacote; importe pelo nome do pacote`);
      continue;
    }
    if (!from.startsWith("@open-semantic/")) continue;
    const dep = from.slice("@open-semantic/".length).split("/")[0];
    if (!ALLOWED[pkg].includes(dep)) problems.push(`${at}: ${pkg} não pode importar ${from}`);
    else if (!declared[`@open-semantic/${dep}`]) problems.push(`${at}: ${from} não está nas dependências de ${pkg}/package.json`);
    else if (browser && !typeOnly && !BROWSER_VALUES.includes(from)) problems.push(`${at}: a interface só importa tipos de ${from}`);
  }
}

if (problems.length > 0) {
  console.error("Fronteiras entre pacotes violadas:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("Fronteiras ok.");
