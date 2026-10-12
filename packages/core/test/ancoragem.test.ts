// Ancoragem e projeção do canvas (docs/funcionalidades/09-ancoragem-e-projecao.md): critérios de aceitação 1 a 6.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Rect } from "@open-semantic/protocol";
import { contractValidator } from "@open-semantic/protocol";
import { contextGroups, overlaps, repositoryUnit } from "@open-semantic/workspace-store";

import { createCore, type Core } from "../src/index.js";

const validateSnapshot = contractValidator("workspace.schema.json");
const user = { kind: "user" as const, id: "arthur" };
const agent = { kind: "agent" as const, id: "claude" };

let core: Core;
let workspaceDir: string;
let loja: string;
let pagamentos: string;
const dirs: string[] = [];
let seq = 0;

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const op = (operation: string, args: Record<string, unknown>, actor: typeof user | typeof agent = agent) =>
  core.dispatcher.dispatch({ operationId: `act_anc_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor } });
const ok = async (operation: string, args: Record<string, unknown>, actor: typeof user | typeof agent = agent) => {
  const result = await op(operation, args, actor);
  expect(result.status, `${operation}: ${JSON.stringify(result.error)}`).toBe("succeeded");
  return result;
};
const diagram = (diagramId: string, extra: Record<string, unknown> = {}) =>
  ok("diagram.create", {
    diagramId,
    title: diagramId,
    kind: "architecture",
    nodes: [
      { id: `nd_${diagramId.slice(4)}_a`, label: "A", kind: "module" },
      { id: `nd_${diagramId.slice(4)}_b`, label: "B", kind: "module" },
    ],
    edges: [],
    ...extra,
  });
const rectOf = (id: string): Rect => {
  const o = core.store.canvasObject(id)!;
  return { position: o.position, size: o.size };
};
const inside = (inner: Rect, outer: Rect) =>
  inner.position.x >= outer.position.x &&
  inner.position.y >= outer.position.y &&
  inner.position.x + inner.size.width <= outer.position.x + outer.size.width &&
  inner.position.y + inner.size.height <= outer.position.y + outer.size.height;
const groupOf = (unitId: string) => contextGroups(core.store.read()).find((g) => g.unitId === unitId);

beforeEach(async () => {
  workspaceDir = await tempDir("os-ws-");
  loja = await tempDir("loja-");
  pagamentos = await tempDir("pagamentos-");
  await writeFile(join(loja, "README.md"), "# loja\n");
  core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
  await ok("workspace.add_project", { projectId: "prj_loja", name: "loja", rootPath: loja }, user);
  await ok("workspace.add_project", { projectId: "prj_pagamentos", name: "pagamentos", rootPath: pagamentos }, user);
  await ok("workspace.set_active_project", { projectId: "prj_loja" }, user);
});

afterEach(async () => {
  await core.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("1. Unidade do repositório", () => {
  it("cada repositório ganha uma, e só uma, mesmo ao ser aberto por outro workspace", async () => {
    const units = core.store.read().semantic.entities.filter((e) => e.kind === "repository");
    expect(units.map((u) => [u.id, u.projectId, u.name])).toEqual([
      ["sem_loja_repo", "prj_loja", "loja"],
      ["sem_pagamentos_repo", "prj_pagamentos", "pagamentos"],
    ]);
    await core.close();

    // Outro workspace, outro id de projeto: a unidade vem do repositório, não nasce outra.
    core = await createCore({ workspaceDir: await tempDir("os-ws2-"), debounceMs: 5, animationMs: 0 });
    await ok("workspace.add_project", { projectId: "prj_outra", name: "loja", rootPath: loja }, user);
    const again = core.store.read().semantic.entities.filter((e) => e.kind === "repository");
    expect(again.map((u) => [u.id, u.projectId])).toEqual([["sem_loja_repo", "prj_outra"]]);
  });
});

describe("2. Todo diagrama nasce ancorado", () => {
  it("sem âncora vai para o repositório (o pedido ou o ativo); com âncora, para a unidade pedida", async () => {
    await diagram("dgm_geral");
    expect(core.store.diagram("dgm_geral")).toMatchObject({ projectId: "prj_loja", anchorIds: ["sem_loja_repo"] });
    await diagram("dgm_pag", { projectId: "prj_pagamentos" });
    expect(core.store.diagram("dgm_pag")!.anchorIds).toEqual(["sem_pagamentos_repo"]);

    await ok("semantic.upsert_inference", {
      entities: [{ id: "sem_checkout", kind: "concept", name: "Checkout lento", projectId: "prj_loja" }],
      confidence: 0.6,
      rationale: "Assunto aberto na conversa.",
    });
    await diagram("dgm_checkout", { anchorIds: ["sem_checkout"] });
    expect(core.store.diagram("dgm_checkout")).toMatchObject({ projectId: "prj_loja", anchorIds: ["sem_checkout"] });

    const bad = await op("diagram.create", { diagramId: "dgm_bad", title: "x", kind: "flow", nodes: [], edges: [], anchorIds: ["sem_nao_existe"] });
    expect(bad).toMatchObject({ status: "rejected", error: { code: "REFERENCE_INVALID", argumentPath: "/anchorIds/0" } });

    await ok("diagram.anchor", { diagramId: "dgm_geral", anchorIds: ["sem_checkout"] });
    expect(core.store.diagram("dgm_geral")!.anchorIds).toEqual(["sem_checkout"]);
    expect(validateSnapshot(core.store.snapshot()), JSON.stringify(validateSnapshot.errors)).toBe(true);
  });
});

describe("3 e 4. O canvas é uma projeção das âncoras", () => {
  it("itens da mesma unidade ficam juntos, cada repositório no seu grupo, sem nenhuma operação de layout", async () => {
    await ok("semantic.upsert_inference", {
      entities: [{ id: "sem_checkout", kind: "concept", name: "Checkout lento", projectId: "prj_loja" }],
      confidence: 0.6,
      rationale: "Assunto aberto na conversa.",
    });
    await diagram("dgm_loja_1");
    await diagram("dgm_checkout_1", { anchorIds: ["sem_checkout"] });
    await diagram("dgm_pag_1", { projectId: "prj_pagamentos" });
    await diagram("dgm_checkout_2", { anchorIds: ["sem_checkout"] });
    await diagram("dgm_loja_2");
    await diagram("dgm_pag_2", { projectId: "prj_pagamentos" });

    const loja = groupOf("sem_loja_repo")!;
    const checkout = groupOf("sem_checkout")!;
    const pag = groupOf("sem_pagamentos_repo")!;
    expect(loja).toMatchObject({ kind: "repository", name: "loja", depth: 0 });
    expect(checkout).toMatchObject({ name: "Checkout lento", depth: 1 });
    // Cada coisa dentro do seu grupo; o assunto dentro do repositório.
    for (const id of ["dgm_loja_1", "dgm_loja_2"]) expect(inside(rectOf(id), loja.bounds), id).toBe(true);
    for (const id of ["dgm_checkout_1", "dgm_checkout_2"]) expect(inside(rectOf(id), checkout.bounds), id).toBe(true);
    expect(inside(checkout.bounds, loja.bounds)).toBe(true);
    for (const id of ["dgm_pag_1", "dgm_pag_2"]) expect(inside(rectOf(id), pag.bounds), id).toBe(true);
    // Repositórios separados, e nada de um cai no grupo do outro.
    expect(overlaps(loja.bounds, pag.bounds)).toBe(false);
    for (const id of ["dgm_loja_1", "dgm_loja_2", "dgm_checkout_1", "dgm_checkout_2"]) expect(overlaps(rectOf(id), pag.bounds), id).toBe(false);
    // Nenhum objeto se sobrepõe a outro.
    const objects = core.store.read().canvas.objects;
    for (const a of objects) for (const b of objects) if (a.id < b.id) expect(overlaps(rectOf(a.id), rectOf(b.id)), `${a.id} × ${b.id}`).toBe(false);
  });

  it("o Explorer aberto pela interface entra no grupo do repositório dele", async () => {
    const root = core.store.project("prj_pagamentos")!.rootRef;
    await ok("mod.create", { modId: "mod_pag", type: "explorer", config: { rootRef: root } }, user);
    expect(inside(rectOf("mod_pag"), groupOf("sem_pagamentos_repo")!.bounds)).toBe(true);
  });
});

describe("5. O que temos sobre X?", () => {
  it("enquadrar a unidade mostra tudo o que está ancorado nela e dentro dela, e nada de outras", async () => {
    await ok("semantic.upsert_inference", {
      entities: [{ id: "sem_checkout", kind: "concept", name: "Checkout lento", projectId: "prj_loja" }],
      confidence: 0.6,
      rationale: "Assunto aberto na conversa.",
    });
    await diagram("dgm_loja_1");
    await diagram("dgm_checkout_1", { anchorIds: ["sem_checkout"] });
    await diagram("dgm_pag_1", { projectId: "prj_pagamentos" });

    const repo = await ok("navigation.frame", { targets: { semanticEntityIds: ["sem_loja_repo"] }, intent: "overview", reason: "O que temos sobre a loja" });
    const framed = (repo.output as { framedIds: string[] }).framedIds;
    expect(framed).toEqual(expect.arrayContaining(["dgm_loja_1", "dgm_checkout_1", "sem_loja_repo"]));
    expect(framed).not.toContain("dgm_pag_1");

    const subject = await ok("navigation.frame", { targets: { semanticEntityIds: ["sem_checkout"] }, intent: "focus", reason: "Checkout" });
    expect((subject.output as { framedIds: string[] }).framedIds).toEqual(expect.arrayContaining(["dgm_checkout_1"]));
    expect((subject.output as { framedIds: string[] }).framedIds).not.toContain("dgm_loja_1");
  });
});

describe("6. Âncoras e unidades persistem", () => {
  it("voltam iguais ao reabrir e chegam a outro workspace pelo repositório", async () => {
    await ok("semantic.upsert_inference", {
      entities: [{ id: "sem_checkout", kind: "concept", name: "Checkout lento", projectId: "prj_loja" }],
      confidence: 0.6,
      rationale: "Assunto aberto na conversa.",
    });
    await diagram("dgm_checkout_1", { anchorIds: ["sem_checkout"] });
    await core.close();

    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
    expect(core.store.diagram("dgm_checkout_1")!.anchorIds).toEqual(["sem_checkout"]);
    expect(groupOf("sem_checkout")).toBeDefined();
    await core.close();

    core = await createCore({ workspaceDir: await tempDir("os-ws3-"), debounceMs: 5, animationMs: 0 });
    await ok("workspace.add_project", { projectId: "prj_minha_loja", name: "loja", rootPath: loja }, user);
    const doc = core.store.read();
    expect(core.store.diagram("dgm_checkout_1")).toMatchObject({ projectId: "prj_minha_loja", anchorIds: ["sem_checkout"] });
    expect(repositoryUnit(doc, "prj_minha_loja")!.id).toBe("sem_loja_repo");
    // O grupo do assunto aparece dentro do grupo do repositório também aqui.
    expect(inside(groupOf("sem_checkout")!.bounds, groupOf("sem_loja_repo")!.bounds)).toBe(true);
  });
});
