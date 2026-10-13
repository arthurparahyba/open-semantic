// Ponta a ponta do workspace como pasta: escolha na primeira abertura, repositório trazido pela conversa
// (com confirmação) e diagrama salvo dentro do próprio repositório. Provedor roteirizado no lugar do Claude.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = process.env.OPEN_SEMANTIC_SCREENSHOT_DIR;

let dataDir: string;
let repoDir: string;
let workspaceDir: string;
let scriptFile: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-ws-"));
  repoDir = await mkdtemp(join(tmpdir(), "minha-app-"));
  await mkdir(join(repoDir, "api"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), "# Minha aplicação\n");
  workspaceDir = join(dataDir, "Meu workspace");
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(
    scriptFile,
    JSON.stringify([
      {
        text: "Vou trazer a pasta para o workspace.",
        toolCalls: [
          {
            id: "tu_1",
            name: "run_batch",
            input: {
              intent: "Trazer minha-app para o workspace",
              steps: [{ id: "add", operation: "workspace.add_project", arguments: { projectId: "prj_minhaapp", name: "minha-app", rootPath: repoDir } }],
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tu_2",
            name: "run_batch",
            input: {
              intent: "Desenhar a arquitetura",
              steps: [
                {
                  id: "dg",
                  operation: "diagram.create",
                  arguments: {
                    diagramId: "dgm_arch",
                    title: "Arquitetura",
                    kind: "architecture",
                    projectId: "prj_minhaapp",
                    nodes: [
                      { id: "nd_web", label: "Web", kind: "module" },
                      { id: "nd_api", label: "API", kind: "module" },
                    ],
                    edges: [{ id: "edg_web_api", sourceNodeId: "nd_web", targetNodeId: "nd_api", label: "HTTP" }],
                    layout: { algorithm: "layered", direction: "LR" },
                  },
                },
              ],
            },
          },
        ],
      },
      { text: "Trouxe minha-app e desenhei a arquitetura." },
    ]),
  );
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

const launch = () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  return electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_DEFAULT_WORKSPACE: workspaceDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
};

test("workspace como pasta: escolha, repositório pela conversa e diagrama dentro do repositório", async () => {
  let app = await launch();
  let page = await app.firstWindow();
  const shot = async (name: string) => {
    if (screenshots) await page.screenshot({ path: join(screenshots, name) });
  };

  // Primeira abertura: escolher a pasta do workspace.
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(page.getByTestId("welcome-default")).toContainText(workspaceDir);
  await shot("ws-1-boas-vindas.png");
  await page.getByTestId("welcome-default").click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Meu workspace");
  await expect(page.getByRole("heading", { name: "Comece pela conversa" })).toBeVisible();
  expect(existsSync(join(workspaceDir, ".open-semantic", "workspace.json"))).toBe(true);
  await shot("ws-2-workspace-vazio.png");

  // Pela conversa: o agente pede para trazer a pasta e espera a confirmação.
  await page.getByTestId("chat-input").fill(`trabalhe com ${repoDir}`);
  await page.getByTestId("chat-send").click();
  // A confirmação aparece na caixa flutuante acima da mensagem, sem precisar abrir o histórico.
  const card = page.getByTestId("dock-confirm");
  await expect(card).toBeVisible();
  await expect(card).toContainText(repoDir);
  await expect(card).toContainText(".open-semantic/");
  await shot("ws-3-confirmacao.png");
  await card.getByRole("button", { name: "Aprovar" }).click();
  await expect(card).toHaveCount(0);
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("desenhei a arquitetura");
  await expect(page.locator('[data-diagram-id="dgm_arch"]')).toBeVisible();
  await expect(page.locator('[data-project-id="prj_minhaapp"]')).toHaveAttribute("data-active", "true");
  // Sem pedido do usuário, nenhum Explorer é aberto.
  await expect(page.getByTestId("mod-explorer")).toHaveCount(0);
  await expect(page.getByTestId("persist")).toHaveText("Salvo");
  await shot("ws-4-diagrama.png");

  // O diagrama mora no repositório; o workspace guarda só a referência e o lugar no canvas.
  const diagramFile = join(repoDir, ".open-semantic", "diagrams", "dgm_arch.json");
  await expect.poll(() => existsSync(diagramFile)).toBe(true);
  expect(JSON.parse(await readFile(diagramFile, "utf8"))).toMatchObject({ format: "open-semantic/diagram", title: "Arquitetura" });
  const ws = JSON.parse(await readFile(join(workspaceDir, ".open-semantic", "workspace.json"), "utf8"));
  expect(ws.diagrams).toEqual([]);
  expect(ws.canvas.objects.map((o: { id: string }) => o.id)).toContain("dgm_arch");
  await app.close();

  // Reabrir: o app lembra a pasta do workspace e traz o diagrama do repositório.
  app = await launch();
  page = await app.firstWindow();
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("workspace-name")).toHaveText("Meu workspace");
  await expect(page.locator('[data-diagram-id="dgm_arch"]')).toBeVisible();
  await app.close();
});
