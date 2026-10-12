// Avaliação do motor no CI: precisão (assunto principal, foco, pergunta) e latência, sobre um workspace
// sintético de 30 repositórios. Cada caso é uma mensagem com o resultado que uma pessoa esperaria.
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { SemanticContextEngine } from "../src/index.js";
import type { Relevance } from "../src/types.js";
import { syntheticWorkspace } from "./fixture.js";

interface Case {
  nome: string;
  texto: string;
  recentes?: string[];
  selecionados?: string[];
  /** Unidades que precisam estar no assunto principal. */
  assunto?: string[];
  /** Unidades que não podem estar no assunto principal. */
  foraDoAssunto?: string[];
  foco?: string;
  /** false: não pode perguntar. Lista: tem que perguntar com essas opções. */
  pergunta?: false | string[];
  suposicao?: string;
}

const cases = JSON.parse(readFileSync(new URL("./avaliacao/casos.json", import.meta.url), "utf8")) as Case[];

/** Os tempos são metas para a máquina do usuário; runners de CI compartilhados ganham folga. */
const SLACK = process.env.CI ? 2 : 1;

function check(c: Case, r: Relevance): string[] {
  const problems: string[] = [];
  const main = r.topics[0];
  if (c.pergunta === false && r.question) problems.push(`perguntou "${r.question.text}"`);
  if (Array.isArray(c.pergunta)) {
    if (!r.question) problems.push("não perguntou");
    else {
      const got = r.question.options.map((o) => o.ref).sort();
      if (JSON.stringify(got) !== JSON.stringify([...c.pergunta].sort())) problems.push(`opções ${got.join(", ")}`);
    }
  }
  for (const u of c.assunto ?? []) if (!main?.unitIds.includes(u)) problems.push(`faltou ${u} no assunto (${main?.unitIds.join(", ") ?? "nenhum"})`);
  for (const u of c.foraDoAssunto ?? []) if (main?.unitIds.includes(u)) problems.push(`${u} entrou no assunto`);
  if (c.foco && r.primaryTarget !== c.foco) problems.push(`foco em ${r.primaryTarget ?? "nada"}`);
  if (c.suposicao && !r.assumptions.some((a) => a.chosen === c.suposicao)) problems.push(`não supôs ${c.suposicao}`);
  return problems;
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

describe("avaliação do motor de contexto", () => {
  const engine = new SemanticContextEngine();
  let feedMs = 0;

  beforeAll(() => {
    const t = performance.now();
    engine.feed(syntheticWorkspace());
    feedMs = performance.now() - t;
    engine.analyze({ text: "aquecimento" });
  });

  it("indexa cerca de 50 mil itens", () => {
    expect(engine.size).toBeGreaterThan(45_000);
    console.log(`índice: ${engine.size} itens em ${feedMs.toFixed(0)} ms`);
  });

  it("acerta o assunto principal, o foco e a pergunta em pelo menos 90% dos casos", () => {
    const failures: string[] = [];
    for (const c of cases) {
      const r = engine.analyze({ text: c.texto, recent: c.recentes ?? [], focus: { selectedIds: c.selecionados ?? [] } });
      const problems = check(c, r);
      if (problems.length) failures.push(`✗ ${c.nome}: ${problems.join("; ")}`);
    }
    const precision = (cases.length - failures.length) / cases.length;
    console.log(`precisão: ${(precision * 100).toFixed(0)}% (${cases.length - failures.length} de ${cases.length})\n${failures.join("\n")}`);
    expect(precision, failures.join("\n")).toBeGreaterThanOrEqual(0.9);
  });

  it("pergunta em no máximo 1 de cada 5 mensagens", () => {
    const asked = cases.filter((c) => engine.analyze({ text: c.texto, recent: c.recentes ?? [], focus: { selectedIds: c.selecionados ?? [] } }).question);
    expect(asked.length / cases.length).toBeLessThanOrEqual(0.2);
  });

  it("analisa mensagens curtas em menos de 30 ms e textos de 2 mil palavras em menos de 80 ms", () => {
    const short: number[] = [];
    for (let i = 0; i < 5; i++) for (const c of cases) short.push(engine.analyze({ text: c.texto, recent: c.recentes ?? [] }).timings.analyzeMs);
    const long = cases.map((c) => c.texto).join(" ");
    const words = long.split(/\s+/).length;
    const longText = Array.from({ length: Math.ceil(2000 / words) }, () => long).join("\n");
    // No app o motor fica aberto e já compilado pelo JIT; as primeiras rodadas só aquecem.
    for (let i = 0; i < 3; i++) engine.analyze({ text: longText });
    const longMs: number[] = [];
    for (let i = 0; i < 7; i++) longMs.push(engine.analyze({ text: longText }).timings.analyzeMs);
    console.log(`latência curta: mediana ${percentile(short, 50)} ms, p95 ${percentile(short, 95)} ms; texto longo: mediana ${percentile(longMs, 50)} ms`);
    expect(percentile(short, 95)).toBeLessThan(30 * SLACK);
    expect(percentile(longMs, 50)).toBeLessThan(80 * SLACK);
  });
});
