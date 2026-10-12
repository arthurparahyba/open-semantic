// Ponta a ponta da conversa (M2 parte 2) com um provedor roteirizado no lugar do Claude:
// o chat envia o pedido, o laço lê o projeto, executa lotes pelo mesmo executor e mostra custo e confirmação.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = process.env.OPEN_SEMANTIC_SCREENSHOT_DIR;

let dataDir: string;
let projectDir: string;
let scriptFile: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-chat-"));
  projectDir = await mkdtemp(join(tmpdir(), "minha-app-"));
  await mkdir(join(projectDir, "frontend"), { recursive: true });
  await writeFile(join(projectDir, "README.md"), "# Minha aplicação\n");
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(scriptFile, "[]");
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test("conversa: o agente lê o projeto, cria pelo executor, pede confirmação e mostra o custo", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_TEST_FOLDER: projectDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();
  const shot = async (name: string) => {
    if (screenshots) await page.screenshot({ path: join(screenshots, name) });
  };

  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();
  const snapshot = await page.evaluate(() => window.openSemantic.snapshot());
  const projectId = snapshot.projects[0]!.id;
  const rootId = snapshot.projects[0]!.roots[0].id;
  const bind = { $bind: { step: "mk", pointer: "/output/artifacts/0/id" } };

  await writeFile(
    scriptFile,
    JSON.stringify([
      { text: "Vou olhar a pasta do projeto.", toolCalls: [{ id: "tu_1", name: "list_dir", input: { path: "" } }] },
      {
        toolCalls: [
          {
            id: "tu_2",
            name: "run_batch",
            input: {
              intent: "Criar a pasta api e abrir um Explorer nela",
              steps: [
                { id: "mk", operation: "project.create_dir", arguments: { projectId, rootId, path: "api" } },
                {
                  id: "obs",
                  operation: "semantic.upsert_observation",
                  dependsOn: ["mk"],
                  arguments: {
                    entity: { id: "sem_api", kind: "module", name: "API", projectId, artifactIds: [bind] },
                    evidence: { id: "evd_api_dir", kind: "directory_listing", artifactId: bind, summary: "Pasta api/ criada." },
                  },
                },
                { id: "rg", operation: "region.create", dependsOn: ["obs"], arguments: { regionId: "rgn_api", title: "API", semanticEntityIds: ["sem_api"] } },
                {
                  id: "ex",
                  operation: "mod.create",
                  dependsOn: ["mk", "rg"],
                  arguments: { modId: "mod_api_explorer", type: "explorer", title: "API", config: { rootRef: bind }, placement: { regionId: "rgn_api" } },
                },
                { id: "fr", operation: "navigation.frame", dependsOn: ["ex"], arguments: { targets: { regionId: "rgn_api" }, intent: "focus", reason: "Ver a API" } },
              ],
            },
          },
        ],
      },
      { text: "Criei a pasta api/ e abri um Explorer nela, na região API." },
      { toolCalls: [{ id: "tu_3", name: "run_batch", input: { intent: "Remover o Explorer da API", steps: [{ id: "rm", operation: "mod.delete", arguments: { modId: "mod_api_explorer" } }] } }] },
      { text: "Removi o Explorer da API. A pasta continua no projeto." },
    ]),
  );

  // Primeiro pedido: lê, cria e responde.
  await page.getByTestId("chat-input").fill("crie uma pasta api e abra um explorer nela");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("Criei a pasta api/");
  await expect(page.getByTestId("agent-batch").last()).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("agent-batch").last()).toContainText("Feito: criar a pasta api/");
  await expect(page.locator(".chat-tool").first()).toContainText("Olhou a pasta");
  await expect(page.locator('[data-mod-id="mod_api_explorer"]')).toBeVisible();
  expect(existsSync(join(projectDir, "api"))).toBe(true);
  // 3 chamadas × (3000 × 0,10 + 400 × 0,50) / 1e6 = US$ 0,0015
  await expect(page.getByTestId("agent-cost")).toContainText("conversa US$ 0,0015");
  await expect(page.getByTestId("chat-input")).toHaveValue("");
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(800);
  await shot("m2-4-chat.png");

  // Segundo pedido: a remoção espera a confirmação; aprovar executa e o modelo recebe o resultado.
  await page.getByTestId("chat-input").fill("remova o explorer da api");
  await page.getByTestId("chat-input").press("Enter");
  await expect(page.getByTestId("confirm-card")).toBeVisible();
  await expect(page.getByTestId("chat-progress")).toContainText("esperando sua confirmação");
  await expect(page.getByTestId("chat-stop")).toBeVisible();
  await shot("m2-5-chat-confirmacao.png");
  await page.getByTestId("confirm-card").getByRole("button", { name: "Aprovar" }).click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("Removi o Explorer");
  await expect(page.locator('[data-mod-id="mod_api_explorer"]')).toHaveCount(0);
  expect(existsSync(join(projectDir, "api"))).toBe(true);

  // Configurações: a chave nunca aparece; uma chave mal formada é recusada.
  await page.getByTestId("agent-settings-button").click();
  const dialog = page.getByTestId("agent-settings");
  await expect(dialog).toContainText("provedor de teste");
  await expect(dialog.getByRole("radio", { name: /Claude Haiku 5\.5/ })).toBeChecked();
  await dialog.getByTestId("api-key-input").fill("não-é-chave");
  await dialog.getByRole("button", { name: "Salvar" }).first().click();
  await expect(dialog).toContainText("não parece uma chave");
  await dialog.getByTestId("max-cost-input").fill("0,25");
  await dialog.getByRole("button", { name: "Salvar" }).last().click();
  await expect(page.getByTestId("agent-cost")).toContainText("teto US$ 0,25 por pedido");
  await shot("m2-6-configuracoes.png");
  await dialog.getByRole("button", { name: "Fechar" }).click();

  // Nova conversa zera o histórico e o custo mostrado.
  await page.getByRole("button", { name: "Nova conversa" }).click();
  await expect(page.getByTestId("chat-user")).toHaveCount(0);
  await expect(page.getByTestId("agent-cost")).toContainText("conversa US$ 0 ");

  await app.close();
});
