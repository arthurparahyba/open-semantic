// Ponta a ponta do M2 no app real: agente roteirizado cria backend, região, Explorer e diagrama;
// a câmera vai até eles; o usuário segura a câmera (sugestão em vez de movimento); confirmação de remoção.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = process.env.OPEN_SEMANTIC_SCREENSHOT_DIR;

let dataDir: string;
let projectDir: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "minha-app-"));
  await mkdir(join(projectDir, "frontend"), { recursive: true });
  await writeFile(join(projectDir, "frontend/index.html"), "<h1>Minha aplicação</h1>\n");
  await writeFile(join(projectDir, "README.md"), "# Minha aplicação\n");
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const args = [appRoot];
  // Root e runners de CI (AppArmor bloqueia o sandbox do Chromium no Ubuntu 24) não suportam o sandbox do Chromium.
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: projectDir },
  });
  const page = await app.firstWindow();
  return { app, page };
}

const snapshot = (page: Page) => page.evaluate(() => window.openSemantic.snapshot());
const shot = async (page: Page, name: string) => {
  if (screenshots) await page.screenshot({ path: join(screenshots, name) });
};
const lastBatch = (page: Page) => page.getByTestId("agent-batch").last();

test("o agente roteirizado monta a arquitetura, respeita a câmera do usuário e pede confirmação", async () => {
  const { app, page } = await launch();
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();

  // Os roteiros ficam recolhidos sob o chat.
  await page.locator(".agent-scripts summary").click();

  // Fluxo de referência.
  await page.locator('[data-script="arquitetura"]').click();
  await expect(lastBatch(page)).toHaveAttribute("data-status", "completed");
  await expect(lastBatch(page)).toContainText("Feito: criar a pasta backend/");
  expect(existsSync(join(projectDir, "backend"))).toBe(true);

  const diagram = page.getByTestId("diagram");
  await expect(diagram).toBeVisible();
  await expect(diagram.locator('[data-node-id="nd_frontend"]')).toBeVisible();
  await expect(diagram.locator('[data-edge-id="edg_front_back"]')).toHaveClass(/q-inferred/);
  await expect(diagram.locator('[data-node-id="nd_backend"]')).toHaveClass(/q-verified/);
  await expect(page.locator('[data-region-id="rgn_backend"]')).toBeVisible();
  await expect(page.locator('[data-mod-id="mod_backend_explorer"]')).toBeVisible();
  // Espera a animação da câmera terminar antes de fotografar.
  await expect.poll(async () => (await snapshot(page)).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(800);
  await shot(page, "m2-1-arquitetura.png");

  // Arrastar um nó do diagrama fixa a posição sem mudar o Open Semantic.
  const before = await snapshot(page);
  const node = diagram.locator('[data-node-id="nd_backend"]');
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).diagrams[0]!.layout.pinned).toContain("nd_backend");
  const after = await snapshot(page);
  expect(after.semantic).toEqual(before.semantic);

  // O usuário mexe na câmera: o pedido do agente vira sugestão.
  const canvas = page.getByTestId("canvas");
  const cbox = (await canvas.boundingBox())!;
  await page.mouse.move(cbox.x + 30, cbox.y + cbox.height - 40);
  await page.mouse.down();
  await page.mouse.move(cbox.x + 400, cbox.y + cbox.height - 300, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).navigation.control.mode).toBe("user_hold");
  const userCamera = (await snapshot(page)).navigation.camera;
  await page.locator('[data-script="mostrar_backend"]').click();
  await expect(lastBatch(page)).toContainText("Não movi a câmera");
  expect((await snapshot(page)).navigation.camera).toEqual(userCamera);
  await shot(page, "m2-2-sugestao.png");
  await lastBatch(page).getByRole("button", { name: /Ver o backend/ }).click();
  await expect.poll(async () => (await snapshot(page)).navigation.camera).not.toEqual(userCamera);

  // Remover um mod pelo agente pede confirmação; recusar não executa.
  await page.locator('[data-script="remover_explorer"]').click();
  await expect(page.getByTestId("confirm-card")).toBeVisible();
  await shot(page, "m2-3-confirmacao.png");
  await page.getByTestId("confirm-card").getByRole("button", { name: "Recusar" }).click();
  await expect(lastBatch(page)).toHaveAttribute("data-status", "cancelled");
  expect((await snapshot(page)).mods.some((m) => m.id === "mod_backend_explorer")).toBe(true);

  await page.locator('[data-script="remover_explorer"]').click();
  await page.getByTestId("confirm-card").getByRole("button", { name: "Aprovar" }).click();
  await expect(lastBatch(page)).toHaveAttribute("data-status", "completed");
  await expect(page.locator('[data-mod-id="mod_backend_explorer"]')).toHaveCount(0);
  expect(existsSync(join(projectDir, "backend"))).toBe(true);

  await app.close();
});
