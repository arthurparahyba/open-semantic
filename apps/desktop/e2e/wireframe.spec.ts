// Wireframe (docs/funcionalidades/12-tipos-de-diagrama.md): "como é a tela de X" vira a tela desenhada no canvas,
// montada pelo código da tela; o que foi lido no código fica sólido e o suposto, tracejado.
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
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-wire-"));
  projectDir = await mkdtemp(join(tmpdir(), "loja-"));
  await mkdir(join(projectDir, "web", "src"), { recursive: true });
  await writeFile(join(projectDir, "web", "src", "Home.tsx"), "export const Home = () => <><Header /><Sidebar /><OrdersTable /></>;\n");
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(scriptFile, "[]");
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test("como é a tela inicial: wireframe com elementos uns dentro dos outros", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: projectDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();

  const home = { path: "web/src/Home.tsx" };
  await writeFile(
    scriptFile,
    JSON.stringify([
      {
        toolCalls: [
          {
            id: "tu_1",
            name: "show_diagram",
            input: {
              diagramId: "dgm_loja_tela_inicial",
              title: "Tela inicial",
              kind: "wireframe",
              heading: "Tela inicial da loja",
              intro: "O que o usuário vê ao entrar, montado a partir de Home.tsx.",
              caption: "No topo, o logo, a busca e o botão Entrar; embaixo, o menu à esquerda e a tabela de pedidos.",
              source:
                "scr[Tela inicial]:screen\n  top[Topo]:header\n    logo[Logo]:image\n    busca[Buscar pedidos]:search\n    entrar[Entrar]:button\n  corpo[Corpo]:row\n    menu[Menu]:sidebar\n      l1[Pedidos]:link\n      l2[Clientes]:link\n    lista[Pedidos recentes]:main\n      filtro[Status]:select\n      tab[Tabela de pedidos]:table",
              evidence: { scr: { ...home, seen: "Componente Home." }, top: { ...home, seen: "<Header />" }, menu: { ...home, seen: "<Sidebar />" }, tab: { ...home, seen: "<OrdersTable />" } },
            },
          },
        ],
      },
      { text: "No topo, o logo, a busca e o botão Entrar; embaixo, o menu à esquerda e a tabela de pedidos." },
    ]),
  );
  await page.getByTestId("chat-input").fill("como é a tela inicial da loja quando o usuário acessa?");
  await page.getByTestId("chat-send").click();

  const diagram = page.locator('[data-diagram-id="dgm_loja_tela_inicial"]');
  await expect(diagram).toBeVisible();
  await expect(diagram.locator(".wire-node")).toHaveCount(12);
  await expect(diagram.locator('.wire-node[data-wire-kind="button"]')).toContainText("Entrar");
  await expect(diagram.locator(".diagram-edge")).toHaveCount(0);
  // O botão não foi lido no código: fica tracejado; o menu foi lido.
  await expect(diagram.locator('.wire-node[data-wire-kind="button"]')).toHaveClass(/q-inferred/);
  await expect(diagram.locator('.wire-node[data-wire-kind="sidebar"]')).toHaveClass(/q-verified/);

  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(600);
  if (screenshots) await page.screenshot({ path: join(screenshots, "wireframe-1-tela.png") });
  await app.close();
});
