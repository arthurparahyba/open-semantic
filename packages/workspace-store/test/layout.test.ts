// Layout semântico (docs/funcionalidades/13-layout-semantico.md): blocos de explicação, lugares pela relação
// (colado, embaixo, à direita) e a reorganização que respeita o que o usuário arrumou e a camada ativa.
import { describe, expect, it } from "vitest";

import { Dispatcher, contractValidator, type Arrangement, type DiagramModel } from "@open-semantic/protocol";

import { SPACING, WorkspaceStore, blockHandlers, planRebalance, workspaceHandlers } from "../src/index.js";

const validSnapshot = contractValidator("workspace.schema.json");
const agent = { kind: "agent" as const, id: "orchestrator" };
const user = { kind: "user" as const, id: "arthur" };
const size = { width: 400, height: 300 };

const diagram = (id: string, arrangement?: Arrangement): DiagramModel =>
  ({ id, title: id, kind: "architecture", nodes: [], edges: [], layout: { algorithm: "layered", nodes: {} }, revision: 0, ...(arrangement ? { arrangement } : {}) }) as DiagramModel;

function setup() {
  const store = WorkspaceStore.create({ id: "ws_teste", name: "Teste" });
  const dispatcher = new Dispatcher();
  for (const h of [...blockHandlers({ store }), ...workspaceHandlers({ store, isDirectory: async () => true })]) dispatcher.register(h);
  let seq = 0;
  const op = async (operation: string, args: Record<string, unknown>, actor: typeof agent | typeof user = agent) => {
    const r = await dispatcher.dispatch({ operationId: `act_lay_${++seq}00`, operation, arguments: args, authorization: { actor } });
    expect(r.status, JSON.stringify(r.error)).toBe("succeeded");
    return r.output as Record<string, unknown>;
  };
  /** Um diagrama já no canvas, onde for pedido. */
  const put = (id: string, x: number, y: number, arrangement?: Arrangement) =>
    store.transact(() => {
      store.putDiagram(diagram(id, arrangement));
      store.placeObject({ id, objectKind: "diagram", position: { x, y }, size, placedBy: "agent" });
    });
  const pos = (id: string) => store.canvasObject(id)!.position;
  return { store, op, put, pos };
}

describe("blocos de explicação", () => {
  it("cria título com descrição colado acima do diagrama, notas embaixo, e o snapshot segue o contrato", async () => {
    const { store, op, put, pos } = setup();
    put("dgm_infra", 0, 0);
    await op("block.create", {
      blocks: [
        { blockId: "blk_infra_intro", kind: "heading", title: "Infraestrutura", text: "Onde a aplicação roda.", arrangement: { relation: "annotates", targetId: "dgm_infra" } },
        { blockId: "blk_infra_n1", kind: "list", items: ["Cache em Redis", "Banco Postgres"], ordered: true, arrangement: { relation: "annotates", targetId: "dgm_infra", side: "below" } },
        { blockId: "blk_infra_n2", kind: "table", columns: ["Peça", "Papel"], rows: [["Redis", "cache"]], arrangement: { relation: "annotates", targetId: "dgm_infra", side: "below" } },
      ],
    });
    const intro = store.canvasObject("blk_infra_intro")!;
    expect(intro.objectKind).toBe("block");
    expect(intro.position.y + intro.size.height + SPACING.together).toBe(0);
    expect(intro.size.width).toBe(size.width);
    expect(pos("blk_infra_n1").y).toBe(size.height + SPACING.together);
    const n1 = store.canvasObject("blk_infra_n1")!;
    expect(pos("blk_infra_n2").y).toBe(n1.position.y + n1.size.height + SPACING.together);
    expect(validSnapshot(store.snapshot()), JSON.stringify(validSnapshot.errors)).toBe(true);
  });

  it("um título acima de um diagrama sem espaço em cima faz a seção descer", async () => {
    const { op, put, pos } = setup();
    put("dgm_passo1", 0, 0);
    put("dgm_passo2", 0, size.height + SPACING.near, { relation: "continues", targetId: "dgm_passo1" });
    await op("block.create", { blocks: [{ blockId: "blk_b_intro", kind: "heading", title: "Cache", arrangement: { relation: "annotates", targetId: "dgm_passo2" } }] });
    expect(pos("blk_b_intro").y).toBe(size.height + SPACING.near);
    expect(pos("dgm_passo2").y).toBeGreaterThan(size.height + SPACING.near);
  });

  it("a continuação vai embaixo de tudo que vem antes; o detalhe, à direita", async () => {
    const { op, put, pos } = setup();
    put("dgm_geral", 0, 0);
    await op("block.create", { blocks: [{ blockId: "blk_seq", kind: "text", text: "Detalhe do cache.", arrangement: { relation: "details", targetId: "dgm_geral" } }] });
    expect(pos("blk_seq")).toEqual({ x: size.width + SPACING.near, y: 0 });
    await op("block.create", { blocks: [{ blockId: "blk_next", kind: "heading", title: "Funcionalidade X", arrangement: { relation: "continues", targetId: "dgm_geral" } }] });
    expect(pos("blk_next")).toEqual({ x: 0, y: size.height + SPACING.near });
  });

  it("arrastar o diagrama leva os blocos colados; tirar o diagrama tira os blocos", async () => {
    const { store, op, put, pos } = setup();
    put("dgm_infra", 0, 0);
    await op("block.create", { blocks: [{ blockId: "blk_note", kind: "text", text: "Nota.", arrangement: { relation: "annotates", targetId: "dgm_infra", side: "below" } }] });
    const before = pos("blk_note");
    await op("canvas.place", { objectId: "dgm_infra", position: { x: 500, y: 40 } }, user);
    expect(pos("blk_note")).toEqual({ x: before.x + 500, y: before.y + 40 });
    store.transact(() => store.deleteDiagram("dgm_infra"));
    expect(store.block("blk_note")).toBeUndefined();
    expect(store.canvasObject("blk_note")).toBeUndefined();
  });

  it("recusa relação com algo que não está no canvas", async () => {
    const { store } = setup();
    const dispatcher = new Dispatcher();
    for (const h of blockHandlers({ store })) dispatcher.register(h);
    const r = await dispatcher.dispatch({
      operationId: "act_lay_x00",
      operation: "block.create",
      arguments: { blocks: [{ blockId: "blk_solto", kind: "text", text: "x", arrangement: { relation: "continues", targetId: "dgm_nada" } }] },
      authorization: { actor: agent },
    });
    expect(r.status).toBe("rejected");
  });
});

describe("reorganização", () => {
  it("fecha o buraco que sobrou quando um passo da explicação sai", () => {
    const { store, put } = setup();
    put("dgm_passo1", 0, 0);
    put("dgm_passo2", 0, 900, { relation: "continues", targetId: "dgm_passo1" });
    const moves = planRebalance(store.read());
    expect(moves).toEqual([{ objectId: "dgm_passo2", from: { x: 0, y: 900 }, to: { x: 0, y: size.height + SPACING.near } }]);
  });

  it("não mexe no que o usuário pôs à mão, a não ser no reorganizar tudo", () => {
    const { store, put } = setup();
    put("dgm_passo1", 0, 0);
    put("dgm_passo2", 0, 900, { relation: "continues", targetId: "dgm_passo1" });
    store.transact(() => store.placeObject({ ...store.canvasObject("dgm_passo2")!, placedBy: "user" }));
    expect(planRebalance(store.read())).toEqual([]);
    expect(planRebalance(store.read(), { all: true })).toHaveLength(1);
  });

  it("fica dentro da camada ativa", () => {
    const { store, put } = setup();
    put("dgm_passo1", 0, 0);
    put("dgm_passo2", 0, 900, { relation: "continues", targetId: "dgm_passo1" });
    expect(planRebalance(store.read(), { scope: new Set(["dgm_passo1"]) })).toEqual([]);
  });

  it("aplica o plano com canvas.rebalance e desfaz com canvas.arrange", async () => {
    const { op, put, pos } = setup();
    put("dgm_passo1", 0, 0);
    put("dgm_passo2", 600, 900, { relation: "continues", targetId: "dgm_passo1" });
    const preview = await op("canvas.rebalance", { preview: true });
    expect(pos("dgm_passo2")).toEqual({ x: 600, y: 900 });
    expect((preview.moves as unknown[]).length).toBe(1);
    const applied = await op("canvas.rebalance", {});
    expect(pos("dgm_passo2")).toEqual({ x: 0, y: size.height + SPACING.near });
    const moves = applied.moves as { objectId: string; from: { x: number; y: number } }[];
    await op("canvas.arrange", { moves: moves.map((m) => ({ objectId: m.objectId, position: m.from })) }, user);
    expect(pos("dgm_passo2")).toEqual({ x: 600, y: 900 });
  });
});
