import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SemanticContextEngine, estimateTokens } from "../src/index.js";
import { syntheticWorkspace } from "./fixture.js";

const engine = new SemanticContextEngine();
engine.feed(syntheticWorkspace());

describe("motor de contexto", () => {
  it("não importa nada do resto do app", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const [, from] of source.matchAll(/from\s+"([^"]+)"/g)) expect(from, `${file} importa ${from}`).toMatch(/^\.\//);
    }
  });

  it("dá a mesma resposta para a mesma entrada", () => {
    const input = { text: "Como o portal fala com o back-end?", recent: [] };
    const a = engine.analyze(input);
    const b = engine.analyze(input);
    expect({ ...a, timings: undefined }).toEqual({ ...b, timings: undefined });
  });

  it("a resposta da pergunta rápida resolve o termo", () => {
    const asked = engine.analyze({ text: "Como o portal fala com o back-end?" });
    expect(asked.question?.term).toBe("backend");
    const answered = engine.analyze({ text: "Como o portal fala com o back-end?", choices: { backend: "sem_banco_api_cartoes" } });
    expect(answered.question).toBeUndefined();
    expect(answered.topics[0]!.unitIds).toContain("sem_banco_api_cartoes");
    expect(answered.topics[0]!.unitIds).not.toContain("sem_banco_api_contas");
  });

  it("atualiza o índice por item, sem reconstruir", () => {
    const local = new SemanticContextEngine();
    local.feed({ upsert: [{ id: "sem_a", kind: "unit", name: "Motor de busca", unitIds: ["sem_a"] }] });
    expect(local.search("busca")[0]?.ref).toBe("sem_a");
    local.feed({ upsert: [{ id: "sem_a", kind: "unit", name: "Motor de regras", unitIds: ["sem_a"] }] });
    expect(local.search("busca")).toEqual([]);
    local.feed({ remove: ["sem_a"] });
    expect(local.search("regras")).toEqual([]);
  });

  it("ignora itens rejeitados no assunto", () => {
    const local = new SemanticContextEngine();
    local.feed({
      upsert: [
        { id: "sem_velho", kind: "unit", name: "Gateway de pagamento", unitIds: ["sem_velho"], status: "rejected" },
        { id: "sem_novo", kind: "unit", name: "Gateway de pagamento v2", unitIds: ["sem_novo"] },
      ],
    });
    const r = local.analyze({ text: "Como funciona o gateway de pagamento?" });
    expect(r.topics.flatMap((t) => t.unitIds)).not.toContain("sem_velho");
  });

  it("monta um contexto pequeno com 30 repositórios, com o assunto primeiro", async () => {
    const relevance = engine.analyze({ text: "How does the payments service call antifraud?" });
    const pack = await engine.buildContext({
      relevance,
      content: { read: async (ref, level) => (ref === "sem_loja_antifraude" && level >= 1 ? "Evidência: chamada síncrona via HTTP." : undefined) },
    });
    expect(pack.tokens).toBeLessThanOrEqual(12_000);
    expect(pack.tokens).toBe(estimateTokens(pack.text));
    const main = pack.text.indexOf("Assunto principal");
    expect(main).toBeGreaterThanOrEqual(0);
    expect(pack.text.indexOf("Antifraude")).toBeGreaterThan(main);
    expect(pack.text).toContain("chamada síncrona");
    // Os outros repositórios aparecem só no mapa, uma linha cada.
    expect(pack.text).toContain("estoque");
    const again = await engine.buildContext({ relevance, content: { read: async () => undefined } });
    expect(again.text).toBe((await engine.buildContext({ relevance, content: { read: async () => undefined } })).text);
  });

  it("respeita um orçamento apertado cortando o mapa antes do assunto", async () => {
    const relevance = engine.analyze({ text: "Como o worker de faturamento consome a fila?" });
    const pack = await engine.buildContext({ relevance, budget: { context: 1_500 } });
    expect(pack.tokens).toBeLessThanOrEqual(1_500);
    expect(pack.text).toContain("Worker de faturamento");
    expect(pack.dropped.length).toBeGreaterThan(0);
  });
});

describe("pergunta só quando a dúvida é real", () => {
  it("não pergunta quando só um sinônimo casou (tela → web)", () => {
    const local = new SemanticContextEngine();
    local.feed({
      upsert: [
        { id: "sem_pc", kind: "unit", name: "spring-petclinic", unitKind: "repository", unitIds: ["sem_pc"] },
        { id: "sem_pc_web1", kind: "unit", name: "WebConfiguration", description: "idioma ?lang=", unitIds: ["sem_pc_web1"] },
        { id: "sem_pc_web2", kind: "unit", name: "Configuração", aliases: ["web"], description: "cache de vets, web, boas-vindas", unitIds: ["sem_pc_web2"] },
        { id: "sem_pc_boot", kind: "unit", name: "Bootstrap e Font Awesome via WebJars", aliases: ["web"], unitIds: ["sem_pc_boot"] },
      ],
      links: ["sem_pc_web1", "sem_pc_web2", "sem_pc_boot"].map((to) => ({ from: "sem_pc", to, type: "contains" })),
    } as never);
    const r = local.analyze({ text: "Apresente como é a tela inicial da aplicação" });
    expect(r.question).toBeUndefined();
  });
});
