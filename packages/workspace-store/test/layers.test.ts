import { describe, expect, it } from "vitest";

import { Dispatcher, contractValidator, type DiagramModel } from "@open-semantic/protocol";

import { WorkspaceStore, layerHandlers } from "../src/index.js";

const validSnapshot = contractValidator("workspace.schema.json");
const agent = { kind: "agent" as const, id: "orchestrator" };
const user = { kind: "user" as const, id: "arthur" };

const diagram = (id: string, nodeIds: string[]): DiagramModel =>
  ({
    id,
    title: id,
    kind: "architecture",
    nodes: nodeIds.map((n) => ({ id: n, label: n, kind: "module" })),
    edges: [],
    layout: { algorithm: "layered", nodes: {} },
    revision: 0,
  }) as unknown as DiagramModel;

function setup() {
  const store = WorkspaceStore.create({ id: "ws_teste", name: "Teste" });
  store.transact(() => {
    store.putDiagram(diagram("dgm_infra", ["nd_cache", "nd_auth"]));
    store.putDiagram(diagram("dgm_tokens", ["nd_jwt"]));
    store.putDiagram(diagram("dgm_outra", []));
  });
  const dispatcher = new Dispatcher();
  for (const h of layerHandlers({ store })) dispatcher.register(h);
  let seq = 0;
  const op = (operation: string, args: Record<string, unknown>, actor: typeof agent | typeof user = agent) =>
    dispatcher.dispatch({ operationId: `act_lyr_${++seq}00`, operation, arguments: args, authorization: { actor } });
  return { store, op };
}

describe("camadas de assunto (doc 11)", () => {
  it("cria a camada ancorada num elemento da base, ativa e válida pelo contrato", async () => {
    const { store, op } = setup();
    const r = await op("layer.create", { layerId: "lyr_auth", name: "Autenticação", anchors: ["nd_auth"], members: [{ id: "dgm_tokens" }, { id: "turn_0001", weight: 0.4 }] });
    expect(r.status).toBe("succeeded");
    expect(store.activeLayer()?.id).toBe("lyr_auth");
    expect(store.layer("lyr_auth")).toMatchObject({ origin: "agent", members: [{ id: "dgm_tokens", weight: 1, addedBy: "agent" }, { id: "turn_0001", weight: 0.4 }] });
    expect(validSnapshot(store.snapshot()), JSON.stringify(validSnapshot.errors)).toBe(true);
  });

  it("recusa camada sem âncora ou com âncora fora da camada de baixo", async () => {
    const { op } = setup();
    expect((await op("layer.create", { layerId: "lyr_xxx", name: "X", anchors: [] })).status).toBe("rejected");
    await op("layer.create", { layerId: "lyr_auth", name: "Autenticação", anchors: ["nd_auth"], members: [{ id: "dgm_tokens" }] });
    const fora = await op("layer.create", { layerId: "lyr_cache", name: "Cache", parentId: "lyr_auth", anchors: ["nd_cache"] });
    expect(fora).toMatchObject({ status: "rejected", error: { code: "PRECONDITION_FAILED", argumentPath: "/anchors/0" } });
    const dentro = await op("layer.create", { layerId: "lyr_jwt", name: "JWT", parentId: "lyr_auth", anchors: ["nd_jwt"] });
    expect(dentro.status).toBe("succeeded");
  });

  it("camada de integração aceita âncoras em duas aplicações", async () => {
    const { store, op } = setup();
    await op("layer.create", { layerId: "lyr_integ", name: "Integração", anchors: ["nd_auth", "dgm_outra"] });
    expect(store.layer("lyr_integ")?.anchors).toEqual(["nd_auth", "dgm_outra"]);
  });

  it("desfazer devolve membros e filhas para a mãe e não apaga nada", async () => {
    const { store, op } = setup();
    await op("layer.create", { layerId: "lyr_infra", name: "Infra", anchors: ["dgm_infra"], members: [{ id: "dgm_infra" }] });
    await op("layer.create", { layerId: "lyr_auth", name: "Autenticação", parentId: "lyr_infra", anchors: ["nd_auth"], members: [{ id: "dgm_tokens" }] });
    await op("layer.create", { layerId: "lyr_jwt", name: "JWT", parentId: "lyr_auth", anchors: ["nd_jwt"] });
    await op("layer.activate", { layerId: "lyr_auth" });
    const r = await op("layer.dissolve", { layerId: "lyr_auth" });
    expect(r.status).toBe("succeeded");
    expect(store.layer("lyr_auth")).toBeUndefined();
    expect(store.layer("lyr_infra")?.members.map((m) => m.id)).toEqual(["dgm_infra", "dgm_tokens"]);
    expect(store.layer("lyr_jwt")?.parentId).toBe("lyr_infra");
    expect(store.activeLayer()?.id).toBe("lyr_infra");
    expect(store.diagram("dgm_tokens")).toBeDefined();
  });

  it("juntar une membros e âncoras e apaga a de origem", async () => {
    const { store, op } = setup();
    await op("layer.create", { layerId: "lyr_aaa", name: "A", anchors: ["nd_auth"], members: [{ id: "dgm_tokens", weight: 0.3 }] });
    await op("layer.create", { layerId: "lyr_bbb", name: "B", anchors: ["nd_cache"], members: [{ id: "dgm_tokens", weight: 0.9 }, { id: "dgm_outra" }] });
    expect((await op("layer.merge", { layerId: "lyr_aaa", sourceLayerId: "lyr_bbb" })).status).toBe("succeeded");
    expect(store.layer("lyr_bbb")).toBeUndefined();
    expect(store.layer("lyr_aaa")).toMatchObject({ anchors: ["nd_auth", "nd_cache"], members: [{ id: "dgm_tokens", weight: 0.9 }, { id: "dgm_outra" }] });
    expect(store.activeLayer()?.id).toBe("lyr_aaa");
  });

  it("membros do usuário ficam marcados; remover tira só da camada", async () => {
    const { store, op } = setup();
    await op("layer.create", { layerId: "lyr_aaa", name: "A", anchors: ["nd_auth"] });
    await op("layer.add_members", { layerId: "lyr_aaa", members: [{ id: "dgm_outra" }] }, user);
    expect(store.layer("lyr_aaa")?.members).toEqual([{ id: "dgm_outra", weight: 1, addedBy: "user" }]);
    await op("layer.remove_members", { layerId: "lyr_aaa", ids: ["dgm_outra"] });
    expect(store.layer("lyr_aaa")?.members).toEqual([]);
    expect(store.diagram("dgm_outra")).toBeDefined();
  });

  it("apagar um diagrama tira ele e seus nós das camadas", async () => {
    const { store, op } = setup();
    await op("layer.create", { layerId: "lyr_aaa", name: "A", anchors: ["nd_auth"], members: [{ id: "dgm_infra" }, { id: "dgm_outra" }] });
    store.transact(() => store.deleteDiagram("dgm_infra"));
    expect(store.layer("lyr_aaa")).toMatchObject({ anchors: [], members: [{ id: "dgm_outra" }] });
  });

  it("ativar sem camada volta para a base", async () => {
    const { store, op } = setup();
    await op("layer.create", { layerId: "lyr_aaa", name: "A", anchors: ["nd_auth"] });
    await op("layer.activate", {});
    expect(store.activeLayer()).toBeUndefined();
    expect(store.read().navigation.activeLayerId).toBeUndefined();
  });

  it("workspace antigo sem camadas abre com lista vazia", () => {
    const doc = WorkspaceStore.create({ id: "ws_teste", name: "Teste" }).snapshot();
    delete doc.layers;
    expect(new WorkspaceStore(doc).layers()).toEqual([]);
  });
});
