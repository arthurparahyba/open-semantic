// Workspace como pasta: o que o app aprende sobre um repositório fica no `.open-semantic/` do próprio repositório,
// e os repositórios entram pela conversa (pasta local ou clone), sempre com a confirmação do usuário.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BatchPlan } from "@open-semantic/protocol";
import { contractValidator } from "@open-semantic/protocol";

import { AGENT, createCore, gitClone, scriptedPlan, type Core } from "../src/index.js";

const validateSnapshot = contractValidator("workspace.schema.json");
const user = { kind: "user" as const, id: "arthur" };

let workspaceDir: string;
let repoDir: string;
let core: Core;
const dirs: string[] = [];
let seq = 0;

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const op = (operation: string, args: Record<string, unknown>) =>
  core.dispatcher.dispatch({ operationId: `act_repo_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor: user } });
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** Lote de um passo só, como o agente mandaria pela conversa. */
const agentPlan = (operation: string, args: Record<string, unknown>): BatchPlan => {
  const run = `${++seq}`.padStart(6, "0");
  return {
    batchId: `bat_${run}`,
    intent: "Trazer um repositório",
    policy: { onStepFailure: "skip_dependents", validateFirst: true, confirmation: "upfront" },
    steps: [{ stepId: "add", request: { operationId: `act_${run}_001`, operation, arguments: args, authorization: { actor: AGENT } } }],
  };
};

beforeEach(async () => {
  workspaceDir = await tempDir("os-ws-");
  repoDir = await tempDir("os-repo-");
  await writeFile(join(repoDir, "README.md"), "# minha app\n");
  core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
});

afterEach(async () => {
  await core.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

describe("Workspace numa pasta", () => {
  it("guarda o próprio estado em <pasta>/.open-semantic/ e usa o nome da pasta", async () => {
    expect(existsSync(join(workspaceDir, ".open-semantic", "workspace.json"))).toBe(true);
    expect(core.store.snapshot().workspace.name).toBe(workspaceDir.split("/").pop());
    await op("workspace.add_project", { projectId: "prj_minhaapp", name: "minhaapp", rootPath: repoDir });
    await core.close();
    expect((await readFile(join(workspaceDir, ".open-semantic", "history.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
    expect(core.store.project("prj_minhaapp")?.location).toEqual({ kind: "local", rootPath: repoDir });
  });
});

describe("Diagramas e conhecimento dentro do repositório", () => {
  beforeEach(async () => {
    expect((await op("workspace.add_project", { projectId: "prj_minhaapp", name: "minhaapp", rootPath: repoDir })).status).toBe("succeeded");
    const result = await core.agent.run(scriptedPlan("arquitetura", core.store.snapshot()));
    expect(result.status).toBe("completed");
    await core.close();
  });

  it("vão para <repo>/.open-semantic/ e saem do arquivo do workspace", async () => {
    const meta = join(repoDir, ".open-semantic");
    expect(await readdir(join(meta, "diagrams"))).toEqual(["dgm_arch.json"]);
    const diagram = await readJson(join(meta, "diagrams", "dgm_arch.json"));
    expect(diagram).toMatchObject({ format: "open-semantic/diagram", version: 1, id: "dgm_arch", title: "Arquitetura" });
    const knowledge = await readJson(join(meta, "knowledge.json"));
    expect(knowledge.format).toBe("open-semantic/knowledge");
    const backend = knowledge.entities.find((e: { id: string }) => e.id === "sem_backend");
    // No repositório o arquivo aparece pelo caminho, que vale para quem clonar; o id de artefato é do workspace.
    expect(backend.artifactPaths).toEqual(["backend"]);
    expect(backend.artifactIds).toBeUndefined();
    expect(JSON.stringify(knowledge)).not.toContain(repoDir);

    const ws = await readJson(join(workspaceDir, ".open-semantic", "workspace.json"));
    expect(ws.diagrams).toEqual([]);
    expect(ws.semantic.entities).toEqual([]);
    // A disposição do canvas continua no workspace.
    expect(ws.canvas.objects.some((o: { id: string }) => o.id === "dgm_arch")).toBe(true);
  });

  it("voltam iguais ao reabrir o workspace", async () => {
    const before = await readJson(join(workspaceDir, ".open-semantic", "workspace.json"));
    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
    const snap = core.store.snapshot();
    expect(validateSnapshot(snap), JSON.stringify(validateSnapshot.errors)).toBe(true);
    expect(snap.diagrams.map((d) => d.id)).toEqual(["dgm_arch"]);
    expect(snap.semantic.entities.find((e) => e.id === "sem_backend")?.artifactIds).toHaveLength(1);
    const { position, size } = before.canvas.objects.find((o: { id: string }) => o.id === "dgm_arch");
    expect(snap.canvas.objects.find((o) => o.id === "dgm_arch")).toMatchObject({ position, size });
    expect(core.problems).toEqual([]);
  });

  it("outro workspace que abre o mesmo repositório recebe o contexto", async () => {
    const other = await tempDir("os-ws2-");
    core = await createCore({ workspaceDir: other, debounceMs: 5, animationMs: 0 });
    expect((await op("workspace.add_project", { projectId: "prj_clonado", name: "clonado", rootPath: repoDir })).status).toBe("succeeded");
    const snap = core.store.snapshot();
    expect(validateSnapshot(snap), JSON.stringify(validateSnapshot.errors)).toBe(true);
    expect(snap.diagrams.find((d) => d.id === "dgm_arch")?.projectId).toBe("prj_clonado");
    expect(snap.semantic.entities.find((e) => e.id === "sem_backend")?.projectId).toBe("prj_clonado");
    // O diagrama ganha lugar no canvas deste workspace.
    expect(snap.canvas.objects.some((o) => o.id === "dgm_arch")).toBe(true);
    const backendDir = snap.artifacts.find((a) => "rootId" in a.locator && a.locator.path === "backend");
    expect(backendDir?.kind).toBe("directory");
  });

  it("um diagrama trazido do repositório entra no canvas com o tamanho que teria se fosse criado aqui (B7)", async () => {
    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
    const created = await op("diagram.create", {
      diagramId: "dgm_mini",
      title: "Mini",
      // A legenda ocupa linhas embaixo dos nós: o tamanho lido do repositório também precisa contar com elas.
      caption: "A API recebe os pedidos do aplicativo e grava tudo no banco; o resto do sistema só lê o que ela publica.",
      kind: "architecture",
      projectId: "prj_minhaapp",
      nodes: [{ id: "nd_api", label: "API", kind: "service" }],
      edges: [],
      layout: { algorithm: "layered", direction: "LR" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe("succeeded");
    const size = core.store.canvasObject("dgm_mini")?.size;
    await core.close();

    core = await createCore({ workspaceDir: await tempDir("os-ws2-"), debounceMs: 5, animationMs: 0 });
    expect((await op("workspace.add_project", { projectId: "prj_clonado", name: "clonado", rootPath: repoDir })).status).toBe("succeeded");
    expect(core.store.canvasObject("dgm_mini")?.size).toEqual(size);
  });

  it("excluir o diagrama apaga o arquivo dele no repositório", async () => {
    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
    expect((await op("diagram.delete", { diagramId: "dgm_arch" })).status).toBe("succeeded");
    await core.close();
    expect(await readdir(join(repoDir, ".open-semantic", "diagrams"))).toEqual([]);
  });

  it("tirar o projeto do workspace não apaga nada do repositório", async () => {
    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
    expect((await op("workspace.remove_project", { projectId: "prj_minhaapp" })).status).toBe("succeeded");
    await core.close();
    expect(existsSync(join(repoDir, ".open-semantic", "diagrams", "dgm_arch.json"))).toBe(true);
    expect(existsSync(join(repoDir, ".open-semantic", "knowledge.json"))).toBe(true);
  });
});

describe("Repositórios pela conversa", () => {
  it("o agente adiciona uma pasta local só depois que o usuário confirma", async () => {
    const pending = await core.agent.run(agentPlan("workspace.add_project", { projectId: "prj_minhaapp", name: "minhaapp", rootPath: repoDir }));
    expect(pending.status).toBe("awaiting_confirmation");
    const card = core.agent.list().find((a) => a.confirmation)!;
    expect(card.confirmation!.items[0]!.summary).toContain(repoDir);
    expect(card.confirmation!.items[0]!.summary).toContain(".open-semantic/");
    expect(card.steps[0]!.label).toBe(`trazer a pasta ${repoDir} para o workspace`);
    expect(core.store.project("prj_minhaapp")).toBeUndefined();

    const done = await core.agent.respond(card.batchId, true);
    expect(done?.status).toBe("completed");
    expect(core.store.snapshot().workspace.activeProjectId).toBe("prj_minhaapp");
  });

  it("aceita ~ no caminho", async () => {
    const home = await tempDir("os-home-");
    await mkdir(join(home, "projetos", "app"), { recursive: true });
    await core.close();
    core = await createCore({ workspaceDir, homeDir: home, debounceMs: 5, animationMs: 0 });
    const result = await op("workspace.add_project", { projectId: "prj_app", name: "app", rootPath: "~/projetos/app" });
    expect(result.status).toBe("succeeded");
    expect(core.store.project("prj_app")?.location).toEqual({ kind: "local", rootPath: join(home, "projetos", "app") });
  });

  it("recusa caminho relativo", async () => {
    const result = await op("workspace.add_project", { projectId: "prj_app", name: "app", rootPath: "projetos/app" });
    expect(result.status).toBe("rejected");
    expect(result.error?.argumentPath).toBe("/rootPath");
  });

  it("clona um repositório para repos/ do workspace, com o contexto que já vem nele", async () => {
    // Um repositório "remoto" que já tem diagrama salvo por outra pessoa.
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    const origin = await tempDir("os-origin-");
    await op("workspace.add_project", { projectId: "prj_origem", name: "origem", rootPath: repoDir });
    await core.agent.run(scriptedPlan("arquitetura", core.store.snapshot()));
    await core.close();
    git(repoDir, "init", "-q");
    git(repoDir, "add", ".");
    git(repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "inicial");
    git(origin, "clone", "-q", "--bare", repoDir, join(origin, "app.git"));

    const workspace2 = await tempDir("os-ws-clone-");
    const urls: string[] = [];
    core = await createCore({
      workspaceDir: workspace2,
      debounceMs: 5,
      animationMs: 0,
      cloneRepository: (url, target) => {
        urls.push(url);
        return gitClone(join(origin, "app.git"), target);
      },
    });
    const pending = await core.agent.run(agentPlan("workspace.clone_repository", { projectId: "prj_app", url: "https://github.com/arthur/app" }));
    expect(pending.status).toBe("awaiting_confirmation");
    const card = core.agent.list().find((a) => a.confirmation)!;
    expect(card.confirmation!.items[0]!.summary).toContain("https://github.com/arthur/app");
    expect(urls).toEqual([]);

    const done = await core.agent.respond(card.batchId, true);
    expect(done?.status).toBe("completed");
    const target = join(workspace2, "repos", "app");
    expect(done?.steps.add?.output).toMatchObject({ projectId: "prj_app", path: target, cloned: true });
    expect(urls).toEqual(["https://github.com/arthur/app"]);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    const snap = core.store.snapshot();
    expect(snap.workspace.activeProjectId).toBe("prj_app");
    expect(snap.diagrams.find((d) => d.id === "dgm_arch")?.projectId).toBe("prj_app");
  });

  it("recusa endereço que não é de repositório", async () => {
    const result = await op("workspace.clone_repository", { projectId: "prj_app", url: "--upload-pack=touch /tmp/x" });
    expect(result.status).toBe("rejected");
    expect(result.error?.argumentPath).toBe("/url");
  });

  it("falha do git vira erro legível e não deixa projeto pela metade", async () => {
    await core.close();
    core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0, cloneRepository: () => Promise.reject(new Error("repository not found")) });
    const result = await op("workspace.clone_repository", { projectId: "prj_app", url: "https://github.com/arthur/nao-existe" });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("repository not found");
    expect(core.store.project("prj_app")).toBeUndefined();
  });
});
