import { describe, expect, it } from "vitest";

import type { DiagramModel } from "@open-semantic/protocol";

import { applyPatch, computeLayout } from "../src/index.js";

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
