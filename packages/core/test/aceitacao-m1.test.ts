// Testes de aceitação do M1, nomeados pelos critérios da V0.1 §7 (docs/especificacao-v0.1.md).
// Rodam os módulos reais compostos por createCore, com uma pasta de projeto temporária no disco.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActionRecord } from "@open-semantic/protocol";
import type { PersistStatus } from "@open-semantic/workspace-store";

import { JsonlActionLog, createCore, type Core } from "../src/index.js";

let dataDir: string;
let projectDir: string;
let outsideDir: string;
let core: Core;
let seq = 0;

const user = { kind: "user" as const, id: "arthur" };
const agent = { kind: "agent" as const, id: "orchestrator" };

async function op(operation: string, args: Record<string, unknown>, actor: { kind: "user" | "agent"; id: string } = user, extra = {}) {
  return core.dispatcher.dispatch({
    operationId: `act_t${String(++seq).padStart(4, "0")}`,
    operation,
    arguments: args,
    authorization: { actor },
    ...extra,
  });
}

async function openProject() {
  const r = await op("workspace.add_project", { projectId: "prj_app", name: "app", rootPath: projectDir });
  expect(r.status).toBe("succeeded");
  return r.output as { rootArtifactId: string; rootId: string };
}

async function resolve(path: string) {
  const r = await op("project.resolve", { projectId: "prj_app", rootId: "root_app", path });
  expect(r.status, JSON.stringify(r.error)).toBe("succeeded");
  return (r.output as { artifact: { id: string } }).artifact.id;
}

beforeEach(async () => {
  seq = 0;
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  outsideDir = await mkdtemp(join(tmpdir(), "os-fora-"));
  await mkdir(join(projectDir, "backend/src"), { recursive: true });
  await mkdir(join(projectDir, ".git"));
  await mkdir(join(projectDir, "node_modules/x"), { recursive: true });
  await writeFile(join(projectDir, "backend/src/server.js"), "console.log('oi')\n");
  await writeFile(join(projectDir, "README.md"), "# app\n");
  await writeFile(join(outsideDir, "segredo.txt"), "não pode\n");
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5 });
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir, outsideDir].map((d) => rm(d, { recursive: true, force: true })));
});

async function reopen() {
  await core.close();
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5 });
  await core.revalidated;
}

describe("A · workspace e persistência", () => {
  it("A1: cria workspace e adiciona mods ao canvas sem sobrepor", async () => {
    const { rootArtifactId } = await openProject();
    await op("mod.create", { modId: "mod_explorer", type: "explorer", config: { rootRef: rootArtifactId } });
    const file = await resolve("backend/src/server.js");
    await op("mod.create", { modId: "mod_editor", type: "editor", config: { fileRef: file }, placement: { anchorIds: ["mod_explorer"] } });

    const snap = core.store.snapshot();
    expect(snap.mods.map((m) => m.id)).toEqual(["mod_explorer", "mod_editor"]);
    const [a, b] = snap.canvas.objects;
    expect(a!.position.x + a!.size.width).toBeLessThanOrEqual(b!.position.x);
    expect(snap.mods[1]!.title).toBe("server.js");
  });

  it("A2: depois de fechar e reabrir, mods mantêm ids, configuração, posição e a câmera", async () => {
    const { rootArtifactId } = await openProject();
    await op("mod.create", { modId: "mod_explorer", type: "explorer", config: { rootRef: rootArtifactId } });
    await op("canvas.place", { objectId: "mod_explorer", position: { x: 900, y: 300 } });
    await op("mod.configure", { modId: "mod_explorer", uiState: { expanded: [rootArtifactId] } });
    await op("navigation.set_camera", { camera: { center: { x: 900, y: 300 }, zoom: 0.75 } });
    const before = core.store.snapshot();

    await reopen();
    const after = core.store.snapshot();
    expect(after.mods).toEqual(before.mods);
    expect(after.canvas).toEqual(before.canvas);
    expect(after.navigation.camera).toEqual({ center: { x: 900, y: 300 }, zoom: 0.75 });
    expect(after.canvas.objects[0]).toMatchObject({ position: { x: 900, y: 300 }, placedBy: "user" });
  });

  it("A3: fechar um mod não o exclui do workspace", async () => {
    const { rootArtifactId } = await openProject();
    await op("mod.create", { modId: "mod_explorer", type: "explorer", config: { rootRef: rootArtifactId } });
    expect((await op("mod.close", { modId: "mod_explorer" })).status).toBe("succeeded");
    await reopen();
    expect(core.store.mod("mod_explorer")).toMatchObject({ lifecycle: "closed", config: { rootRef: rootArtifactId } });
    expect(core.store.canvasObject("mod_explorer")?.collapsed).toBe(true);
    await op("mod.reopen", { modId: "mod_explorer" });
    expect(core.store.mod("mod_explorer")?.lifecycle).toBe("active");
  });

  it("A4: excluir um mod não apaga o arquivo associado", async () => {
    await openProject();
    const file = await resolve("backend/src/server.js");
    await op("mod.create", { modId: "mod_editor", type: "editor", config: { fileRef: file } });
    expect((await op("mod.delete", { modId: "mod_editor" })).changes).toEqual([{ id: "mod_editor", change: "deleted" }]);
    expect(core.store.mod("mod_editor")).toBeUndefined();
    expect(core.store.canvasObject("mod_editor")).toBeUndefined();
    expect(existsSync(join(projectDir, "backend/src/server.js"))).toBe(true);
  });

  it("o histórico de operações é gravado em disco (E4)", async () => {
    await openProject();
    await core.close();
    const lines = (await readFile(join(dataDir, ".open-semantic/history.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ operation: "workspace.add_project", status: "succeeded", actor: user });
    core = await createCore({ workspaceDir: dataDir, debounceMs: 5 });
  });

  it("o histórico guarda na memória só os registros mais recentes, e no disco todos (B6)", async () => {
    const file = join(dataDir, "outro.jsonl");
    const log = new JsonlActionLog(file, { limit: 2 });
    for (const id of ["act_h01", "act_h02", "act_h03"]) log.append({ id } as ActionRecord);
    expect(log.records.map((r) => r.id)).toEqual(["act_h02", "act_h03"]);
    await log.flush();
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("falha ao gravar o histórico aparece no indicador de salvamento (B6)", async () => {
    await core.close();
    const history = join(dataDir, ".open-semantic/history.jsonl");
    await rm(history, { force: true });
    await mkdir(history); // gravar num diretório falha, como num disco cheio
    const statuses: PersistStatus[] = [];
    core = await createCore({ workspaceDir: dataDir, debounceMs: 5, onPersist: (s) => statuses.push(s) });
    await openProject();
    await core.log.flush();
    expect(statuses).toContainEqual(expect.objectContaining({ state: "error", message: expect.stringMatching(/^O histórico de ações não foi gravado/) }));
  });
});

describe("B · mods funcionais", () => {
  it("B1: o Explorer navega pela raiz autorizada e mostra a estrutura real", async () => {
    const { rootArtifactId } = await openProject();
    const r = await op("project.list_dir", { artifactId: rootArtifactId });
    const entries = (r.output as { entries: { name: string; kind: string }[] }).entries;
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ["backend", "directory"],
      ["README.md", "file"],
    ]);
  });

  it("B1: caminhos fora da raiz são recusados, inclusive por link simbólico", async () => {
    const { rootArtifactId } = await openProject();
    await symlink(outsideDir, join(projectDir, "atalho"));
    const escape = await op("project.resolve", { projectId: "prj_app", rootId: "root_app", path: "../" });
    expect(escape.error?.code).toBe("PATH_OUTSIDE_ROOT");
    const viaLink = await op("project.resolve", { projectId: "prj_app", rootId: "root_app", path: "atalho/segredo.txt" });
    expect(viaLink.error?.code).toBe("PATH_OUTSIDE_ROOT");
    const listed = (await op("project.list_dir", { artifactId: rootArtifactId })).output as { entries: { name: string }[] };
    expect(listed.entries.map((e) => e.name)).not.toContain("atalho");
  });

  it("B1: criar pasta por um link para fora é recusado sem criar nada lá fora, em qualquer profundidade", async () => {
    await openProject();
    await symlink(outsideDir, join(projectDir, "atalho"));
    for (const path of ["atalho/x", "atalho/a/b", "atalho/a/b/c"]) {
      const r = await op("project.create_dir", { projectId: "prj_app", rootId: "root_app", path });
      expect(r.error?.code, path).toBe("PATH_OUTSIDE_ROOT");
    }
    expect(existsSync(join(outsideDir, "x"))).toBe(false);
    expect(existsSync(join(outsideDir, "a"))).toBe(false);
  });

  it("create_dir cria os intermediários dentro da raiz e repete sem erro", async () => {
    await openProject();
    const first = await op("project.create_dir", { projectId: "prj_app", rootId: "root_app", path: "./docs/adr/2026/" });
    expect(first.status, JSON.stringify(first.error)).toBe("succeeded");
    expect(first.output).toMatchObject({ artifacts: [{ path: "docs/adr/2026", kind: "directory" }] });
    expect(first.changes?.[0]?.change).toBe("created");
    expect(existsSync(join(projectDir, "docs/adr/2026"))).toBe(true);
    const again = await op("project.create_dir", { projectId: "prj_app", rootId: "root_app", path: "docs/adr/2026" });
    expect(again.changes?.[0]?.change).toBe("unchanged");
  });

  it("B4: o Editor salva com a impressão lida e detecta mudança externa em vez de sobrescrever", async () => {
    await openProject();
    const file = await resolve("backend/src/server.js");
    const read = (await op("project.read_file", { artifactId: file })).output as { fingerprint: { contentHash: string } };

    const saved = await op("project.write_file", {
      artifactId: file,
      content: "console.log('editado')\n",
      expectedContentHash: read.fingerprint.contentHash,
    });
    expect(saved.status).toBe("succeeded");

    await writeFile(join(projectDir, "backend/src/server.js"), "// mudou fora\n");
    const conflict = await op("project.write_file", {
      artifactId: file,
      content: "console.log('de novo')\n",
      expectedContentHash: (saved.output as { fingerprint: { contentHash: string } }).fingerprint.contentHash,
    });
    expect(conflict.status).toBe("failed");
    expect(conflict.error?.code).toBe("EXTERNAL_CHANGE_CONFLICT");
    expect(await readFile(join(projectDir, "backend/src/server.js"), "utf8")).toBe("// mudou fora\n");
  });

  it("B5: cada tipo declara capacidades e erros são verificáveis", async () => {
    const types = (await op("mod.list_types", {})).output as { types: { type: string; capabilities: unknown[] }[] };
    expect(types.types.map((t) => t.type)).toEqual(["explorer", "editor"]);
    expect(types.types.every((t) => t.capabilities.length > 0)).toBe(true);

    const { rootArtifactId } = await openProject();
    const unknown = await op("mod.create", { modId: "mod_term", type: "terminal", config: { cwdRef: rootArtifactId } });
    expect(unknown.error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    const wrongKind = await op("mod.create", { modId: "mod_edit", type: "editor", config: { fileRef: rootArtifactId } });
    expect(wrongKind.error).toMatchObject({ code: "REFERENCE_INVALID", argumentPath: "/config/fileRef" });
    const invented = await op("mod.create", { modId: "mod_expl", type: "explorer", config: { rootRef: "art_inventado" } });
    expect(invented.error?.code).toBe("REFERENCE_INVALID");
  });
});

describe("C4 · revalidação ao reabrir", () => {
  it("arquivo apagado com o app fechado aparece como 'missing'", async () => {
    await openProject();
    const file = await resolve("README.md");
    await reopen();
    await rm(join(projectDir, "README.md"));
    await reopen();
    expect(core.store.artifact(file)?.validity.status).toBe("missing");
  });
});

describe("E5 · limites do agente", () => {
  it("o agente só adiciona pastas e exclui mods com confirmação", async () => {
    const add = await op("workspace.add_project", { projectId: "prj_x01", name: "x", rootPath: projectDir }, agent);
    expect(add.status).toBe("confirmation_required");
    expect(core.store.project("prj_x01")).toBeUndefined();

    const { rootArtifactId } = await openProject();
    await op("mod.create", { modId: "mod_explorer", type: "explorer", config: { rootRef: rootArtifactId } }, agent);
    expect(core.store.canvasObject("mod_explorer")?.placedBy).toBe("agent");
    const del = await op("mod.delete", { modId: "mod_explorer" }, agent);
    expect(del.status).toBe("confirmation_required");
    expect(core.store.mod("mod_explorer")).toBeDefined();
  });
});
