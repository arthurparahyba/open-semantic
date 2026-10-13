// Vários projetos no mesmo workspace: o agente trabalha no último aberto, e o usuário pode tirar um projeto.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contractValidator } from "@open-semantic/protocol";

import { activeProject, createCore, scriptedPlan, summarizeWorkspace, type Core } from "../src/index.js";

const validateSnapshot = contractValidator("workspace.schema.json");
const user = { kind: "user" as const, id: "arthur" };
const agent = { kind: "agent" as const, id: "claude" };

let dataDir: string;
let petclinic: string;
let tests: string;
let core: Core;
let seq = 0;

const op = (operation: string, args: Record<string, unknown>, actor: typeof user | typeof agent = user) =>
  core.dispatcher.dispatch({ operationId: `act_prj_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor } });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  petclinic = await mkdtemp(join(tmpdir(), "petclinic-"));
  tests = await mkdtemp(join(tmpdir(), "tests-"));
  await mkdir(join(petclinic, "src"));
  await writeFile(join(petclinic, "pom.xml"), "<project/>\n");
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0 });
  expect((await op("workspace.add_project", { projectId: "prj_petclinic", name: "spring-petclinic", rootPath: petclinic })).status).toBe("succeeded");
  expect((await op("workspace.add_project", { projectId: "prj_tests", name: "tests", rootPath: tests })).status).toBe("succeeded");
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, petclinic, tests].map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

describe("Projeto ativo", () => {
  it("é o último aberto, aparece no resumo do agente e é onde os roteiros trabalham", () => {
    const snap = core.store.snapshot();
    expect(snap.workspace.activeProjectId).toBe("prj_tests");
    expect(activeProject(snap)!.id).toBe("prj_tests");
    expect(summarizeWorkspace(snap).activeProjectId).toBe("prj_tests");
    const plan = scriptedPlan("arquitetura", snap);
    expect(plan.steps[0]!.request.arguments.projectId).toBe("prj_tests");
    expect(validateSnapshot(snap), JSON.stringify(validateSnapshot.errors)).toBe(true);
  });

  it("reabrir uma pasta que já estava no workspace volta a torná-la ativa", async () => {
    expect((await op("workspace.add_project", { projectId: "prj_petclinic", name: "spring-petclinic", rootPath: petclinic })).status).toBe("succeeded");
    expect(core.store.snapshot().workspace.activeProjectId).toBe("prj_petclinic");
    expect((await op("workspace.set_active_project", { projectId: "prj_tests" })).status).toBe("succeeded");
    expect(core.store.snapshot().workspace.activeProjectId).toBe("prj_tests");
  });

  it("o agente não escolhe o projeto ativo nem tira projetos", async () => {
    expect((await op("workspace.set_active_project", { projectId: "prj_petclinic" }, agent)).status).toBe("rejected");
    expect((await op("workspace.remove_project", { projectId: "prj_petclinic" }, agent)).status).toBe("rejected");
    expect(core.store.snapshot().projects).toHaveLength(2);
  });
});

describe("Tirar um projeto do workspace", () => {
  it("tira o projeto e o que depende dele, mantém o resto válido e não toca nos arquivos", async () => {
    // O fluxo de referência roda no petclinic (ativo naquela hora).
    await op("workspace.set_active_project", { projectId: "prj_petclinic" });
    const result = await core.agent.run(scriptedPlan("arquitetura", core.store.snapshot()));
    expect(result.status).toBe("completed");
    await op("workspace.set_active_project", { projectId: "prj_tests" });
    // Um Explorer do outro projeto precisa sobreviver.
    const testsRoot = core.store.snapshot().projects.find((p) => p.id === "prj_tests")!.rootRef;
    expect((await op("mod.create", { modId: "mod_tests_explorer", type: "explorer", title: "tests", config: { rootRef: testsRoot } })).status).toBe("succeeded");

    const removed = await op("workspace.remove_project", { projectId: "prj_petclinic" });
    expect(removed.status, JSON.stringify(removed.error)).toBe("succeeded");
    // Entidades: backend, frontend e a unidade do repositório.
    expect(removed.output!.removed).toMatchObject({ mods: 1, diagrams: 1, entities: 3 });

    const snap = core.store.snapshot();
    expect(validateSnapshot(snap), JSON.stringify(validateSnapshot.errors)).toBe(true);
    expect(snap.projects.map((p) => p.id)).toEqual(["prj_tests"]);
    expect(snap.workspace.projectIds).toEqual(["prj_tests"]);
    expect(snap.workspace.activeProjectId).toBe("prj_tests");
    expect(snap.mods.map((m) => m.id)).toEqual(["mod_tests_explorer"]);
    expect(snap.diagrams).toHaveLength(0);
    // Fica só a unidade do repositório que continua no workspace.
    expect(snap.semantic.entities.map((e) => e.id)).toEqual(["sem_tests_repo"]);
    expect(snap.semantic.relations).toHaveLength(0);
    expect(snap.semantic.evidence.map((e) => e.id)).toEqual(["evd_tests_repo"]);
    expect(snap.artifacts.every((a) => a.projectId === "prj_tests")).toBe(true);
    expect(snap.canvas.objects.map((o) => o.id)).toEqual(["mod_tests_explorer"]);
    // A região fica (é só uma moldura), sem o vínculo com o que saiu.
    expect(snap.canvas.regions[0]!.semanticEntityIds ?? []).toEqual([]);
    // Nada no disco muda.
    expect(existsSync(join(petclinic, "backend"))).toBe(true);
    expect(existsSync(join(petclinic, "pom.xml"))).toBe(true);
  });

  it("tirar o último projeto deixa o workspace vazio e válido", async () => {
    await op("workspace.remove_project", { projectId: "prj_petclinic" });
    await op("workspace.remove_project", { projectId: "prj_tests" });
    const snap = core.store.snapshot();
    expect(snap.projects).toHaveLength(0);
    expect(snap.workspace.activeProjectId).toBeUndefined();
    expect(validateSnapshot(snap), JSON.stringify(validateSnapshot.errors)).toBe(true);
  });
});
