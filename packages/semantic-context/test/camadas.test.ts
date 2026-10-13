import { describe, expect, it } from "vitest";

import { SemanticContextEngine, type IndexDoc } from "../src/index.js";

const diagram = (id: string, name: string, nodes: string[]): IndexDoc[] => [
  { id, kind: "diagram", name, unitIds: ["sem_app"], diagramKind: "architecture" },
  ...nodes.map((n): IndexDoc => ({ id: `nd_${n}`, kind: "node", name: n, unitIds: ["sem_app"], diagramId: id, diagramKind: "architecture" })),
];

function setup() {
  const engine = new SemanticContextEngine();
  engine.feed({
    upsert: [
      { id: "sem_app", kind: "unit", name: "App", unitIds: ["sem_app"], unitKind: "repository" },
      ...diagram("dgm_infra", "Infraestrutura", ["cache", "autenticacao", "logs"]),
      ...diagram("dgm_auth", "Fluxo de login", ["login", "sessao"]),
      ...diagram("dgm_jwt", "Tokens JWT", ["assinatura", "expiracao", "refresh", "chaves", "rotacao"]),
    ],
    links: [],
  });
  return engine;
}

describe("contexto com camada ativa (doc 11)", () => {
  it("membros da camada vêm primeiro, o que é só das filhas fica fora e as outras camadas entram pelo nome", async () => {
    const engine = setup();
    const relevance = engine.analyze({ text: "como funciona o login?" });
    const layer = { name: "Autenticação", path: ["Infraestrutura"], members: [{ ref: "dgm_auth", weight: 1 }], hidden: ["dgm_jwt"], others: ["Tokens"] };
    const pack = await engine.buildContext({ relevance, layer });
    expect(pack.text).toContain('Você está na camada "Autenticação" (dentro de Infraestrutura).');
    expect(pack.text.indexOf("dgm_auth")).toBeLessThan(pack.text.indexOf("## Mapa do workspace"));
    expect(pack.text).not.toContain("dgm_jwt");
    expect(pack.text).toContain("Outras camadas: Tokens");
    const base = await engine.buildContext({ relevance });
    expect(pack.tokens).toBeLessThan(base.tokens);
  });

  it("na base só lista as camadas", async () => {
    const engine = setup();
    const relevance = engine.analyze({ text: "o que tem aqui?" });
    const pack = await engine.buildContext({ relevance, layer: { name: "", path: [], members: [], hidden: [], others: ["Infraestrutura"] } });
    expect(pack.text).toContain("## Camadas\nOutras camadas: Infraestrutura");
    expect(pack.text).not.toContain("Você está");
  });
});
