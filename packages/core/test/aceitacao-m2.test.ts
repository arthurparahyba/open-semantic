// Testes de aceitação do M2: protocolo de lotes, diagramas e navegação, com o agente roteirizado.
// Critérios da V0.1 §7 (D1, D3, D4, D5, E1–E5) e de docs/funcionalidades/03, 04 e 06.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isVisible } from "@open-semantic/navigator";
import { contractValidator, type WorkspaceSnapshot } from "@open-semantic/protocol";

import { AGENT, createCore, scriptedPlan, summarizeBatch, type AgentActivity, type Core } from "../src/index.js";

const contracts = join(import.meta.dirname, "../../../contracts");
const validateSnapshot = contractValidator("workspace.schema.json");
const user = { kind: "user" as const, id: "arthur" };
const VIEWPORT = { width: 1400, height: 860 };

let dataDir: string;
let projectDir: string;
let core: Core;
let activities: AgentActivity[];
let seq = 0;

async function op(operation: string, args: Record<string, unknown>, actor: { kind: "user" | "agent"; id: string } = user) {
  return core.dispatcher.dispatch({ operationId: `act_m2_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor } });
}

async function openProject() {
  const r = await op("workspace.add_project", { projectId: "prj_minhaapp", name: "MinhaAplicacao", rootPath: projectDir });
  expect(r.status).toBe("succeeded");
}

const plan = (script: string) => scriptedPlan(script, core.store.snapshot());
const snap = () => core.store.snapshot();

beforeEach(async () => {
  seq = 0;
  activities = [];
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  await mkdir(join(projectDir, "frontend"));
  await writeFile(join(projectDir, "README.md"), "# minha app\n");
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0, onActivity: (a) => activities.push(a) });
  core.setViewport(VIEWPORT);
  await openProject();
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir].map((d) => rm(d, { recursive: true, force: true })));
});

describe("Fluxo de referência: “crie o backend, abra o Explorer e mostre a arquitetura”", () => {
  it("o agente roteirizado executa o lote e chega ao estado de workspace-apos-lote.json", async () => {
    const result = await core.agent.run(plan("arquitetura"));
    expect(result.status, JSON.stringify(result.steps, null, 1)).toBe("completed");
    expect(existsSync(join(projectDir, "backend"))).toBe(true);

    const actual = snap();
    expect(validateSnapshot(actual), JSON.stringify(validateSnapshot.errors)).toBe(true);
    const expected = JSON.parse(readFileSync(join(contracts, "exemplos/workspace-apos-lote.json"), "utf8")) as WorkspaceSnapshot;
    expect(normalize(actual)).toEqual(normalize(expected));

    // Geometria: o Explorer fica dentro da região e tudo o que foi enquadrado está visível.
    const region = actual.canvas.regions.find((r) => r.id === "rgn_backend")!;
    const explorer = actual.canvas.objects.find((o) => o.id === "mod_backend_explorer")!;
    expect(explorer.position.x).toBeGreaterThanOrEqual(region.bounds.position.x);
    expect(explorer.position.x + explorer.size.width).toBeLessThanOrEqual(region.bounds.position.x + region.bounds.size.width);
    expect(explorer.position.y + explorer.size.height).toBeLessThanOrEqual(region.bounds.position.y + region.bounds.size.height);
    for (const id of ["dgm_arch", "mod_backend_explorer"]) {
      const o = actual.canvas.objects.find((x) => x.id === id)!;
      expect(isVisible(o, actual.navigation.camera, VIEWPORT), id).toBe(true);
    }
    // Camadas da esquerda para a direita: Frontend antes de Backend.
    const layout = actual.diagrams[0]!.layout.nodes;
    expect(layout.nd_frontend!.position.x).toBeLessThan(layout.nd_backend!.position.x);
  });

  it("E4: cada passo vira um ActionRecord com batchId e turnId, e a procedência aponta a operação", async () => {
    const p = plan("arquitetura");
    await core.agent.run(p);
    const records = core.log.records.filter((r) => r.batchId === p.batchId);
    expect(records.map((r) => r.stepId)).toEqual(["mk_backend", "sem_backend", "infer_arch", "region", "explorer", "diagram", "frame"]);
    expect(records.every((r) => r.turnId === p.turnId && r.actor.kind === "agent")).toBe(true);
    const backend = snap().semantic.entities.find((e) => e.id === "sem_backend")!;
    expect(backend.provenance.operationId).toBe(p.steps[1]!.request.operationId);
    const dir = snap().artifacts.find((a) => "path" in a.locator && a.locator.path === "backend")!;
    expect(dir.provenance?.operationId).toBe(p.steps[0].request.operationId);
  });

  it("a narração afirma o que foi feito e marca a suposição como inferida", async () => {
    await core.agent.run(plan("arquitetura"));
    const summary = activities.at(-1)!.summary!;
    expect(summary).toMatch(/^Feito: criar a pasta backend\//);
    expect(summary).toMatch(/inferido/);
    expect(summary).not.toMatch(/Não feito/);
  });
});

describe("E. Protocolo e confiabilidade", () => {
  it("E1: a operação inválida do exemplo é rejeitada com explicação estruturada e nada muda", async () => {
    const example = JSON.parse(readFileSync(join(contracts, "exemplos/operacao-rejeitada.json"), "utf8"));
    const before = snap().workspace.revision;
    const result = await core.dispatcher.dispatch(example.request);
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "REFERENCE_INVALID", argumentPath: "/config/rootRef", targetId: "art_etc_passwd", retryable: false },
      changes: [],
    });
    expect(snap().workspace.revision).toBe(before);
  });

  it("E2: o resultado devolve o efeito real (ids e posições criados)", async () => {
    const result = await core.agent.run(plan("arquitetura"));
    expect(result.steps.mk_backend?.output).toMatchObject({ artifacts: [{ path: "backend", kind: "directory" }] });
    expect(result.steps.explorer?.output).toMatchObject({ modId: "mod_backend_explorer", position: expect.any(Object) });
    expect(result.steps.diagram?.changes).toEqual([{ id: "dgm_arch", change: "created", revision: 1 }]);
  });

  it("E3: reenviar o lote é replay; um lote novo com os mesmos objetos não duplica nada", async () => {
    const p = plan("arquitetura");
    await core.agent.run(p);
    const count = () => {
      const s = snap();
      return [s.mods.length, s.diagrams.length, s.canvas.regions.length, s.canvas.objects.length, s.semantic.entities.length, s.semantic.relations.length];
    };
    const before = count();
    const replay = await core.batches.run(p);
    expect(Object.values(replay.steps).every((r) => r?.replayed)).toBe(true);
    const fresh = await core.agent.run(plan("arquitetura"));
    expect(fresh.status).toBe("completed");
    expect(fresh.steps.explorer?.changes?.[0]?.change).toBe("unchanged");
    expect(fresh.steps.diagram?.changes?.[0]?.change).toBe("unchanged");
    expect(count()).toEqual(before);
  });

  it("E5: remover um mod pelo agente espera a confirmação; recusar não executa, aprovar executa", async () => {
    await core.agent.run(plan("arquitetura"));
    const first = plan("remover_explorer");
    const waiting = await core.agent.run(first);
    expect(waiting.status).toBe("awaiting_confirmation");
    expect(activities.at(-1)!.confirmation?.items[0]?.summary).toMatch(/Remover/);
    expect(JSON.stringify(activities.at(-1))).not.toContain(waiting.steps.remove!.confirmation!.token);
    expect(snap().mods.some((m) => m.id === "mod_backend_explorer")).toBe(true);

    const declined = await core.agent.respond(first.batchId, false);
    expect(declined?.status).toBe("cancelled");
    expect(snap().mods.some((m) => m.id === "mod_backend_explorer")).toBe(true);
    expect(activities.at(-1)!.summary).toMatch(/você recusou/);

    const second = plan("remover_explorer");
    await core.agent.run(second);
    const approved = await core.agent.respond(second.batchId, true);
    expect(approved?.status).toBe("completed");
    expect(snap().mods.some((m) => m.id === "mod_backend_explorer")).toBe(false);
    // A4: o diretório real continua lá.
    expect(existsSync(join(projectDir, "backend"))).toBe(true);
  });

  it("um runtime que falha de propósito nunca vira sucesso na narração", async () => {
    await core.flush(); // o app ainda pode estar gravando o .open-semantic/ do repositório
    await rm(projectDir, { recursive: true, force: true }); // a pasta do projeto some: create_dir falha de verdade
    const p = plan("arquitetura");
    const result = await core.agent.run(p);
    expect(result.steps.mk_backend?.status).toBe("failed");
    expect(result.steps.explorer?.status).toBe("skipped");
    const summary = summarizeBatch(p, result);
    expect(summary).not.toMatch(/Feito: .*criar a pasta/);
    expect(summary).toMatch(/Não feito: criar a pasta backend\/: /);
    expect(summary).toMatch(/abrir um Explorer “Backend”: pulado/);
  });
});

describe("D. Diagramas e navegação", () => {
  it("D1: o diagrama criado pelo agente é editável (patch atômico, mover nó fixa sem tocar o Open Semantic)", async () => {
    await core.agent.run(plan("arquitetura"));
    const entityRevisions = () => snap().semantic.entities.map((e) => e.revision);
    const before = entityRevisions();

    const patched = await op("diagram.apply_patch", {
      diagramId: "dgm_arch",
      ops: [
        { op: "add_node", node: { id: "nd_banco", label: "Banco de dados", kind: "data_store" } },
        { op: "add_edge", edge: { id: "edg_back_db", sourceNodeId: "nd_backend", targetNodeId: "nd_banco" } },
      ],
    });
    expect(patched.status).toBe("succeeded");
    expect(snap().diagrams[0]!.nodes).toHaveLength(3);

    const bad = await op("diagram.apply_patch", {
      diagramId: "dgm_arch",
      ops: [
        { op: "remove_node", nodeId: "nd_banco" },
        { op: "add_edge", edge: { id: "edg_x01", sourceNodeId: "nd_banco", targetNodeId: "nd_backend" } },
      ],
    });
    expect(bad).toMatchObject({ status: "rejected", error: { argumentPath: "/ops/1" } });
    expect(snap().diagrams[0]!.nodes).toHaveLength(3);

    const moved = await op("diagram.move_node", { diagramId: "dgm_arch", nodeId: "nd_backend", position: { x: 600, y: 300 } });
    expect(moved.status).toBe("succeeded");
    const diagram = snap().diagrams[0]!;
    expect(diagram.layout.pinned).toContain("nd_backend");
    expect(diagram.layout.nodes.nd_backend!.position).toEqual({ x: 600, y: 300 });
    expect(entityRevisions()).toEqual(before);

    const relayout = await op("diagram.layout", { diagramId: "dgm_arch", algorithm: "layered", direction: "TB" });
    expect(relayout.status).toBe("succeeded");
    expect(snap().diagrams[0]!.layout.nodes.nd_backend!.position).toEqual({ x: 600, y: 300 });
  });

  it("D3: enquadrar por entidade semântica resolve para os objetos ligados a ela", async () => {
    await core.agent.run(plan("arquitetura"));
    await op("navigation.set_camera", { camera: { center: { x: -5000, y: -5000 }, zoom: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    await core.store.transact(() => core.store.updateNavigation({ control: { mode: "shared" } }));
    const result = await op("navigation.frame", { targets: { semanticEntityIds: ["sem_backend"] }, intent: "focus" }, AGENT);
    expect(result.status).toBe("succeeded");
    const framed = (result.output as { framedIds: string[] }).framedIds;
    expect(framed).toEqual(expect.arrayContaining(["mod_backend_explorer", "nd_backend", "rgn_backend"]));
    const nav = snap().navigation;
    const region = snap().canvas.regions[0]!;
    expect(isVisible(region.bounds, nav.camera, VIEWPORT)).toBe(true);

    const missing = await op("navigation.frame", { targets: { semanticEntityIds: ["sem_inexistente"] } }, AGENT);
    expect(missing).toMatchObject({ status: "rejected", error: { code: "TARGET_NOT_FOUND", details: { unresolved: ["sem_inexistente"] } } });
  });

  it("D4: o usuário interrompe e assume a câmera; o agente vira sugestão até o prazo acabar", async () => {
    await core.agent.run(plan("arquitetura"));
    await core.store.transact(() => core.store.setSettings({ userHoldMs: 150 }));
    const userCamera = { center: { x: -3000, y: 2000 }, zoom: 0.5 };
    await op("navigation.set_camera", { camera: userCamera });
    expect(snap().navigation.control.mode).toBe("user_hold");

    const held = await core.agent.run(plan("mostrar_backend"));
    expect(held.steps.frame?.output).toMatchObject({ deferred: true, reason: "Ver o backend" });
    expect(snap().navigation.camera).toEqual(userCamera);
    expect(activities.at(-1)!.summary).toMatch(/Não movi a câmera/);

    await new Promise((r) => setTimeout(r, 200));
    const moved = await core.agent.run(plan("mostrar_backend"));
    expect(moved.steps.frame?.output).toMatchObject({ deferred: false });
    expect(snap().navigation.camera).not.toEqual(userCamera);

    // Navegação automática desligada: sem prazo.
    await op("navigation.set_control", { mode: "user_locked" });
    await op("navigation.set_camera", { camera: userCamera });
    await new Promise((r) => setTimeout(r, 200));
    const locked = await core.agent.run(plan("mostrar_backend"));
    expect(locked.steps.frame?.output).toMatchObject({ deferred: true });
    expect((await op("navigation.set_control", { mode: "shared" }, AGENT)).status).toBe("rejected");
  });

  it("D4: cancelar um movimento em curso volta a idle e registra quem interrompeu", async () => {
    await core.close();
    const events: string[] = [];
    core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 10_000, onEvent: (e) => events.push(e.type) });
    core.setViewport(VIEWPORT);
    await core.agent.run(plan("arquitetura"));
    const nav = snap().navigation;
    expect(nav.motion.status).toBe("animating");
    const cancelled = await op("navigation.cancel", { navigationId: nav.motion.navigationId, camera: { center: { x: 1, y: 2 }, zoom: 1 } });
    expect(cancelled.output).toEqual({ cancelled: true });
    expect(snap().navigation.motion.status).toBe("idle");
    expect(snap().navigation.control.mode).toBe("user_hold");
    expect(events).toContain("navigation.cancelled");
  });

  it("D5: navegar não altera arquivos, mods, diagramas nem o Open Semantic", async () => {
    await core.agent.run(plan("arquitetura"));
    const fingerprint = () => {
      const s = snap();
      return JSON.stringify([s.mods, s.diagrams, s.semantic, s.canvas, s.artifacts.map((a) => a.id)]);
    };
    const before = fingerprint();
    const readme = await readFile(join(projectDir, "README.md"), "utf8");
    await op("navigation.overview", {}, AGENT);
    await op("navigation.frame", { targets: { visualIds: ["nd_frontend"] }, intent: "detail" }, AGENT);
    await op("navigation.frame", { targets: { regionId: "rgn_backend" } }, user);
    expect(fingerprint()).toBe(before);
    expect(await readFile(join(projectDir, "README.md"), "utf8")).toBe(readme);
  });
});

describe("Persistência do que o M2 cria", () => {
  it("regiões, diagramas e o Open Semantic voltam iguais ao reabrir", async () => {
    await core.agent.run(plan("arquitetura"));
    const before = snap();
    await core.close();
    core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0 });
    const after = snap();
    expect(after.diagrams).toEqual(before.diagrams);
    expect(after.canvas).toEqual(before.canvas);
    // No repositório os itens ficam em ordem de id (arquivos estáveis); a ordem não é parte do estado.
    const byId = (s: typeof before.semantic) =>
      Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...(v as { id: string }[])].sort((a, b) => a.id.localeCompare(b.id))]));
    expect(byId(after.semantic)).toEqual(byId(before.semantic));
    expect(after.navigation.camera).toEqual(before.navigation.camera);
  });
});

/** Compara a estrutura sem ids gerados, horários, revisões nem geometria exata. */
function normalize(s: WorkspaceSnapshot) {
  const pathOf = (artifactId: string) => {
    const a = s.artifacts.find((x) => x.id === artifactId);
    return a && "path" in a.locator ? a.locator.path : artifactId;
  };
  return {
    artifacts: s.artifacts
      .map((a) => ({ kind: a.kind, path: pathOf(a.id), status: a.validity.status }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    entities: s.semantic.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      status: e.status,
      source: e.provenance.source,
      confidence: e.provenance.confidence,
      artifacts: (e.artifactIds ?? []).map(pathOf),
      evidence: (e.provenance.evidenceIds ?? []).length,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    relations: s.semantic.relations.map((r) => ({
      id: r.id,
      type: r.type,
      sourceId: r.sourceId,
      targetId: r.targetId,
      attributes: r.attributes,
      status: r.status,
      source: r.provenance.source,
      confidence: r.provenance.confidence,
    })),
    evidence: s.semantic.evidence
      .map((e) => ({ kind: e.kind, artifact: e.artifactId && pathOf(e.artifactId), status: e.status }))
      .sort((a, b) => String(a.artifact).localeCompare(String(b.artifact))),
    mods: s.mods.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      root: pathOf(m.config.rootRef as string),
      semanticEntityIds: m.semanticEntityIds,
      lifecycle: m.lifecycle,
      createdBy: m.createdBy.kind,
    })),
    diagrams: s.diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      anchorIds: d.anchorIds,
      nodes: d.nodes,
      edges: d.edges,
      algorithm: d.layout.algorithm,
      direction: d.layout.direction,
      laidOut: Object.keys(d.layout.nodes).sort(),
    })),
    regions: s.canvas.regions.map((r) => ({ id: r.id, title: r.title, semanticEntityIds: r.semanticEntityIds })),
    objects: s.canvas.objects
      .map((o) => ({ id: o.id, kind: o.objectKind, regionId: o.regionId, placedBy: o.placedBy }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    focus: s.navigation.focus,
  };
}

