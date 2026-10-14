// Implementar e validar (doc 16): o agente cria arquivos novos e roda comandos do projeto, sempre com confirmação.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCore, type Core } from "../src/index.js";

const user = { kind: "user" as const, id: "arthur" };
const agent = { kind: "agent" as const, id: "claude" };

let dataDir: string;
let projectDir: string;
let core: Core;
let seq = 0;

const op = (operation: string, args: Record<string, unknown>, actor: { kind: "user" | "agent"; id: string } = user) =>
  core.dispatcher.dispatch({ operationId: `act_exec_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor } });

const where = () => {
  const project = core.store.snapshot().projects.find((p) => p.id === "prj_petclinic")!;
  return { projectId: project.id, rootId: project.roots[0]!.id };
};

beforeEach(async () => {
  seq = 0;
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0 });
  expect((await op("workspace.add_project", { projectId: "prj_petclinic", name: "PetClinic", rootPath: projectDir })).status).toBe("succeeded");
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir].map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

describe("criar arquivo novo", () => {
  it("cria o arquivo e as pastas do caminho; não sobrescreve um que já existe", async () => {
    const path = "src/main/java/produto/Produto.java";
    const created = await op("project.create_file", { ...where(), path, content: "class Produto {}\n" });
    expect(created.status, JSON.stringify(created)).toBe("succeeded");
    expect(await readFile(join(projectDir, path), "utf8")).toBe("class Produto {}\n");
    const again = await op("project.create_file", { ...where(), path, content: "outro" });
    expect(again.status).not.toBe("succeeded");
    expect(await readFile(join(projectDir, path), "utf8")).toBe("class Produto {}\n");
  });

  it("o agente só cria depois da confirmação", async () => {
    const r = await op("project.create_file", { ...where(), path: "novo.txt", content: "x" }, agent);
    expect(r.status).toBe("confirmation_required");
  });
});

describe("rodar comando", () => {
  it("devolve o código de saída e a saída do comando", async () => {
    const r = await op("project.run_command", { ...where(), command: `node -e "console.log('3 testes ok'); process.exit(2)"` });
    expect(r.status, JSON.stringify(r)).toBe("succeeded");
    expect(r.output).toMatchObject({ exitCode: 2, timedOut: false });
    expect(String(r.output?.output)).toContain("3 testes ok");
  });

  it("para o comando no tempo limite", async () => {
    const r = await op("project.run_command", { ...where(), command: `node -e "setTimeout(() => {}, 20000)"`, timeoutMs: 1000 });
    expect(r.output).toMatchObject({ timedOut: true });
  });

  it("o agente só roda depois que o usuário aprova o comando exato", async () => {
    const r = await op("project.run_command", { ...where(), command: "./mvnw test" }, agent);
    expect(r.status).toBe("confirmation_required");
    expect(r.confirmation?.summary).toContain("./mvnw test");
  });
});
