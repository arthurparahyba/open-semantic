// Ponta a ponta das camadas de assunto (doc 11): overview primeiro; ao aprofundar, o agente abre uma camada
// filha ancorada no overview. O painel lista as camadas, o que é de fora esmaece, a âncora ganha marcador e
// desfazer a camada não apaga nada. Provedor roteirizado no lugar do Claude.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = process.env.OPEN_SEMANTIC_SCREENSHOT_DIR;

let dataDir: string;
let app: string;
let scriptFile: string;

const diagram = (diagramId: string, title: string, labels: string[]) => ({
  id: diagramId,
  operation: "diagram.create",
  arguments: {
    diagramId,
    title,
    kind: "architecture",
    projectId: "prj_app",
    nodes: labels.map((label, i) => ({ id: `nd_${diagramId.slice(4)}_${i}`, label, kind: "module" })),
    edges: [],
    layout: { algorithm: "layered", direction: "LR" },
  },
});

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-cam-"));
  app = await mkdtemp(join(tmpdir(), "app-"));
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(
    scriptFile,
    JSON.stringify([
      { toolCalls: [{ id: "tu_1", name: "run_batch", input: { intent: "Visão geral da infraestrutura", steps: [diagram("dgm_infra", "Infraestrutura", ["Cache", "Autenticação", "Logs"])] } }] },
      { text: "Esta é a infraestrutura: cache, autenticação e logs." },
      {
        toolCalls: [
          {
            id: "tu_2",
            name: "run_batch",
            input: {
              intent: "Aprofundar a autenticação",
              steps: [
                diagram("dgm_login", "Fluxo de login", ["Formulário", "Sessão", "Token"]),
                {
                  id: "camada",
                  operation: "layer.create",
                  dependsOn: ["dgm_login"],
                  arguments: { layerId: "lyr_auth", name: "Autenticação", anchors: ["nd_infra_1"], members: [{ id: "dgm_login" }] },
                },
              ],
            },
          },
        ],
      },
      { text: 'Criei a camada "Autenticação" com o fluxo de login.' },
    ]),
  );
});

test.afterAll(async () => {
  await Promise.all([dataDir, app].map((d) => rm(d, { recursive: true, force: true })));
});

test("camadas: aprofundar abre uma camada ancorada; desfazer não apaga nada", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const electronApp = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await electronApp.firstWindow();
  await page.getByTestId("history-toggle").click();
  const shot = async (name: string) => {
    if (screenshots) await page.screenshot({ path: join(screenshots, name) });
  };
  await expect(page.getByTestId("workspace-name")).toBeVisible();
  const added = await page.evaluate(
    (rootPath) => window.openSemantic.dispatch({ operationId: "act_e2e_add", operation: "workspace.add_project", arguments: { projectId: "prj_app", name: "app", rootPath } }),
    app,
  );
  expect(added.status).toBe("succeeded");

  await page.getByTestId("chat-input").fill("como é a infraestrutura?");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("cache, autenticação e logs");
  await expect(page.getByTestId("layers")).toHaveCount(0);

  await page.getByTestId("chat-input").fill("quero entender os meandros da autenticação");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("Criei a camada");
  await expect(page.getByTestId("layers")).toContainText("Autenticação");
  await expect(page.locator(".toast")).toContainText("Criei a camada “Autenticação”");
  const slot = (id: string) => page.locator(".mod-slot", { has: page.locator(`[data-diagram-id="${id}"]`) });
  await expect(slot("dgm_login")).toHaveAttribute("data-in-layer", "true");
  await expect(slot("dgm_infra")).toHaveClass(/is-dimmed/);
  await page.waitForTimeout(700);
  await shot("cam-1-camada.png");

  // Na base, o que nasceu na camada some; a âncora mostra o marcador da filha; clicar nele entra na camada.
  await page.getByTestId("layer-base").click();
  await expect(page.locator('[data-diagram-id="dgm_login"]')).toHaveCount(0);
  await expect(slot("dgm_infra")).not.toHaveClass(/is-dimmed/);
  await expect(slot("dgm_infra").getByTestId("layer-mark")).toContainText("Autenticação");
  await page.waitForTimeout(900);
  await shot("cam-2-base.png");
  await slot("dgm_infra").getByTestId("layer-mark").click();
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.activeLayerId).toBe("lyr_auth");
  await expect(page.locator('[data-diagram-id="dgm_login"]')).toBeVisible();

  // Desfazer tira só o recorte.
  await page.getByRole("button", { name: "Desfazer a camada Autenticação" }).click();
  await expect(page.getByTestId("layers")).toHaveCount(0);
  await expect(page.locator('[data-diagram-id="dgm_login"]')).toBeVisible();
  await expect(page.locator('[data-diagram-id="dgm_infra"]')).toBeVisible();
  await electronApp.close();
});
