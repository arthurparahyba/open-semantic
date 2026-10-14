// A camada de implementação vira um markdown em specs/ (doc 16): conversão fiel, sem inventar nada.
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@open-semantic/protocol";

import { emptySnapshot, handoffPrompt, isSpecLayer, renderSpec, specFiles, specSlug } from "../src/index.js";

const at = "2026-10-14T12:00:00.000Z";
const layer = (id: string, name: string, members: string[], parentId?: string) => ({
  id,
  name,
  ...(parentId ? { parentId } : {}),
  anchors: [],
  members: members.map((m) => ({ id: m, weight: 1, addedBy: "agent" as const })),
  origin: "agent" as const,
  createdAt: at,
  lastActiveAt: at,
});
const node = (id: string, label: string, kind: string, attributes?: Record<string, unknown>) => ({ id, label, kind, ...(attributes ? { attributes } : {}) });
const edge = (id: string, sourceNodeId: string, targetNodeId: string, label?: string) => ({ id, sourceNodeId, targetNodeId, ...(label ? { label } : {}) });
const diagram = (id: string, title: string, kind: string, nodes: unknown[], edges: unknown[]) =>
  ({ id, projectId: "prj_pet", title, kind, nodes, edges, layout: { algorithm: "layered", nodes: {} }, revision: 1 }) as unknown as WorkspaceSnapshot["diagrams"][number];
const place = (id: string, y: number) => ({ id, objectKind: "block" as const, position: { x: 0, y }, size: { width: 100, height: 50 }, placedBy: "agent" as const });

function petclinic(): WorkspaceSnapshot {
  const doc = emptySnapshot({ id: "wsp_teste", name: "Teste", now: () => new Date(at) });
  doc.diagrams = [
    diagram(
      "dgm_processo",
      "Cadastro de produto",
      "bpmn",
      [node("nd_i", "Início", "start", { layer: "Lojista" }), node("nd_f", "Preenche produto", "task", { layer: "Lojista" }), node("nd_v", "Dados válidos?", "gateway", { layer: "Sistema", mark: "passou" }), node("nd_fim", "Cadastrado", "end", { layer: "Sistema" })],
      [edge("e1", "nd_i", "nd_f"), edge("e2", "nd_f", "nd_v"), edge("e3", "nd_v", "nd_fim", "sim")],
    ),
    diagram("dgm_dados", "Dados", "er", [node("nd_produtos", "products", "table", { columns: ["id integer PK", "name varchar"] }), node("nd_pets", "pets", "table")], [edge("e4", "nd_produtos", "nd_pets", "1..N")]),
    diagram("dgm_tela", "Tela", "wireframe", [node("nd_scr", "Novo produto", "screen"), node("nd_nome", "Nome", "input", { parent: "nd_scr" }), node("nd_salvar", "Salvar", "button", { parent: "nd_scr" })], []),
  ];
  doc.blocks = [
    { id: "blk_titulo", kind: "heading", projectId: "prj_pet", title: "Cadastro de produto", text: "O lojista cadastra produtos para pets." },
    { id: "blk_criterios", kind: "table", projectId: "prj_pet", arrangement: { relation: "continues", targetId: "blk_passos" }, title: "Critérios de aceite", columns: ["Critério", "Origem", "Status"], rows: [["Dado | quando | então", "dgm_processo / nd_v", "passou"]] },
    { id: "blk_passos", kind: "list", projectId: "prj_pet", arrangement: { relation: "continues", targetId: "blk_titulo" }, title: "Passos", ordered: true, items: ["Abrir a tela", "Salvar"] },
  ] as WorkspaceSnapshot["blocks"];
  // A tabela foi arrastada para o topo à mão e entrou primeiro no canvas: a ordem vem das relações, não das coordenadas.
  doc.canvas.objects.push(place("blk_criterios", -500), place("blk_titulo", 0), place("blk_passos", 100));
  doc.layers = [layer("lyr_spec", "Produtos para pets", ["dgm_processo", "dgm_dados", "dgm_tela"]), layer("lyr_impl", "Implementação: Cadastro de produto", ["blk_criterios", "blk_titulo", "blk_passos"], "lyr_spec")];
  return doc;
}

describe("especificação em markdown", () => {
  it("só a camada de implementação vira arquivo, em specs/<assunto>.md do projeto dela", () => {
    const files = specFiles(petclinic());
    expect([...files.keys()]).toEqual(["prj_pet"]);
    expect(files.get("prj_pet")!.map((f) => f.path)).toEqual(["specs/cadastro-de-produto.md"]);
    expect(specSlug(layer("lyr_x", "Implementação: Atualização de preço", []))).toBe("atualizacao-de-preco");
  });

  it("converte blocos na ordem de leitura do layout semântico e diagramas em Mermaid, sem inventar conteúdo", () => {
    const doc = petclinic();
    const md = renderSpec(doc, doc.layers!.find((l) => l.id === "lyr_impl")!);
    expect(md.startsWith("# Cadastro de produto\n")).toBe(true);
    expect(md.indexOf("## Cadastro de produto")).toBeLessThan(md.indexOf("1. Abrir a tela"));
    expect(md.indexOf("1. Abrir a tela")).toBeLessThan(md.indexOf("| Critério | Origem | Status |"));
    expect(md).toContain("| Dado \\| quando \\| então | dgm_processo / nd_v | passou |");
    expect(md).toContain('## Diagramas da especificação (camada "Produtos para pets")');
    expect(md).toContain('subgraph g1["Lojista"]');
    expect(md).toContain('v{"Dados válidos?"}');
    expect(md).toContain('v -->|"sim"| fim');
    expect(md).toContain("- Dados válidos?: passou");
    expect(md).toContain("    integer id PK");
    expect(md).toContain('products ||--o{ pets : "1..N"');
    expect(md).toContain("- Novo produto (screen)\n  - Nome (input)\n  - Salvar (button)");
    expect(renderSpec(doc, doc.layers![1]!)).toBe(md);
  });
});

describe("pedido para o agente de código", () => {
  it("aponta para o arquivo da camada e não inventa nada além das regras fixas", () => {
    const prompt = handoffPrompt(layer("lyr_impl", "Implementação: Cadastro de produto", []));
    expect(prompt.split("\n")[0]).toBe("Implemente o que está especificado em specs/cadastro-de-produto.md.");
    expect(isSpecLayer(layer("lyr_x", "Produtos para pets", []))).toBe(false);
  });
});
