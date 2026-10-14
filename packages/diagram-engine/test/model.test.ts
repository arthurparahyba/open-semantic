import { describe, expect, it } from "vitest";

import type { DiagramModel } from "@open-semantic/protocol";

import { applyPatch, closeBpmnPaths, computeLayout } from "../src/index.js";

function base(): DiagramModel {
  return {
    id: "dgm_arch",
    title: "Arquitetura",
    kind: "architecture",
    nodes: [
      { id: "nd_front", label: "Frontend", kind: "module" },
      { id: "nd_back", label: "Backend", kind: "module" },
    ],
    edges: [{ id: "edg_fb1", sourceNodeId: "nd_front", targetNodeId: "nd_back", label: "HTTP" }],
    layout: { algorithm: "layered", direction: "LR", nodes: {} },
    revision: 1,
  };
}

describe("applyPatch", () => {
  it("aplica ops em ordem e devolve o que mudou", () => {
    const { model, summary } = applyPatch(base(), [
      { op: "add_node", node: { id: "nd_db1", label: "Banco", kind: "data_store" } },
      { op: "add_edge", edge: { id: "edg_bd1", sourceNodeId: "nd_back", targetNodeId: "nd_db1" } },
      { op: "update_node", nodeId: "nd_back", set: { label: "API" } },
    ]);
    expect(model.nodes.map((n) => n.label)).toEqual(["Frontend", "API", "Banco"]);
    expect(summary).toMatchObject({ addedNodes: ["nd_db1"], addedEdges: ["edg_bd1"], updatedNodes: ["nd_back"] });
  });

  it("é atômico: uma op inválida não aplica nenhuma e aponta o índice", () => {
    const original = base();
    expect(() =>
      applyPatch(original, [
        { op: "add_node", node: { id: "nd_db1", label: "Banco", kind: "data_store" } },
        { op: "add_edge", edge: { id: "edg_xx1", sourceNodeId: "nd_db1", targetNodeId: "nd_fantasma" } },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENTS", argumentPath: "/ops/1" }));
    expect(original).toEqual(base());
  });

  it("remover um nó remove suas arestas e o tira do layout", () => {
    const start = base();
    start.layout.nodes = { nd_front: { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } } };
    start.layout.pinned = ["nd_front"];
    const { model, summary } = applyPatch(start, [{ op: "remove_node", nodeId: "nd_front" }]);
    expect(model.edges).toEqual([]);
    expect(model.layout.nodes).toEqual({});
    expect(model.layout.pinned).toEqual([]);
    expect(summary.removedEdges).toEqual(["edg_fb1"]);
  });

  it("reaplicar o mesmo add_node não duplica", () => {
    const op = { op: "add_node" as const, node: { id: "nd_db1", label: "Banco", kind: "data_store" } };
    const once = applyPatch(base(), [op]).model;
    const twice = applyPatch(once, [op]);
    expect(twice.model.nodes).toHaveLength(3);
    expect(twice.summary.addedNodes).toEqual([]);
  });

  it("reaplicar o mesmo nó ou aresta com as chaves em outra ordem não é \"outro conteúdo\" (B8)", () => {
    const once = applyPatch(base(), [{ op: "add_node", node: { id: "nd_db1", label: "Banco", kind: "data_store" } }]).model;
    const again = applyPatch(once, [
      { op: "add_node", node: { kind: "data_store", label: "Banco", id: "nd_db1" } },
      { op: "add_edge", edge: { label: "HTTP", targetNodeId: "nd_back", sourceNodeId: "nd_front", id: "edg_fb1" } },
    ]);
    expect(again.model.nodes).toHaveLength(3);
    expect(again.summary).toMatchObject({ addedNodes: [], addedEdges: [] });
  });
});

describe("computeLayout", () => {
  it("layered LR põe a origem da aresta à esquerda do destino", async () => {
    const layout = await computeLayout(base(), { algorithm: "layered", direction: "LR" });
    expect(layout.nodes.nd_front!.position.x).toBeLessThan(layout.nodes.nd_back!.position.x);
  });

  it("relayout não move nós fixados pelo usuário", async () => {
    const model = base();
    model.layout = await computeLayout(model, { algorithm: "layered", direction: "LR" });
    model.layout.nodes.nd_back = { ...model.layout.nodes.nd_back!, position: { x: 900, y: 500 } };
    model.layout.pinned = ["nd_back"];
    const next = await computeLayout(model, { algorithm: "layered", direction: "TB" });
    expect(next.nodes.nd_back!.position).toEqual({ x: 900, y: 500 });
    expect(next.pinned).toEqual(["nd_back"]);
  });
});

describe("BPMN fechado e tela sem campos soltos", () => {
  const node = (id: string, kind: string, attributes?: Record<string, unknown>) => ({ id, label: id, kind, ...(attributes ? { attributes } : {}) }) as DiagramModel["nodes"][number];
  const edge = (id: string, s: string, t: string) => ({ id, sourceNodeId: s, targetNodeId: t }) as DiagramModel["edges"][number];

  it("tarefa sem saída ganha uma seta para o fim", () => {
    const { edges } = closeBpmnPaths([node("nd_ini", "start"), node("nd_salva", "task"), node("nd_fim", "end")], [edge("e1", "nd_ini", "nd_salva")]);
    expect(edges.map((e) => `${e.sourceNodeId}>${e.targetNodeId}`)).toEqual(["nd_ini>nd_salva", "nd_salva>nd_fim"]);
  });

  it("sem fim, cria um", () => {
    const { nodes, edges } = closeBpmnPaths([node("nd_ini", "start"), node("nd_salva", "task")], [edge("e1", "nd_ini", "nd_salva")]);
    expect(nodes.at(-1)).toMatchObject({ id: "nd_fim", kind: "end" });
    expect(edges.at(-1)).toMatchObject({ sourceNodeId: "nd_salva", targetNodeId: "nd_fim" });
  });

  it("campo sem parent entra no formulário, antes dos botões", async () => {
    const nodes = [
      node("nd_tela", "screen"),
      node("nd_nome", "input", { parent: "nd_tela" }),
      node("nd_salvar", "button", { parent: "nd_tela" }),
      node("nd_categoria", "select"),
    ];
    const layout = await computeLayout({ nodes, edges: [], kind: "wireframe", layout: { algorithm: "manual", nodes: {} } }, { algorithm: "wireframe" });
    const tela = layout.nodes.nd_tela!;
    const cat = layout.nodes.nd_categoria!;
    expect(cat.position.y + cat.size.height).toBeLessThanOrEqual(tela.position.y + tela.size.height);
    expect(cat.position.y).toBeLessThan(layout.nodes.nd_salvar!.position.y);
  });
});
