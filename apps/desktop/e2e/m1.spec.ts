// Ponta a ponta do M1 no app Electron real: abrir pasta → Explorer → Editor → salvar → fechar → reabrir.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await mkdir(join(projectDir, "backend/src"), { recursive: true });
  await mkdir(join(projectDir, "frontend"), { recursive: true });
  await writeFile(join(projectDir, "backend/src/server.js"), "import http from 'node:http';\n\nhttp.createServer((req, res) => res.end('ok')).listen(3000);\n");
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
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_TEST_FOLDER: projectDir },
  });
  const page = await app.firstWindow();
  return { app, page };
}

const snapshot = (page: Page) => page.evaluate(() => window.openSemantic.snapshot());
const shot = async (page: Page, name: string) => {
  if (screenshots) await page.screenshot({ path: join(screenshots, name) });
};

test("abre pasta, edita arquivo e reencontra tudo ao reabrir", async () => {
  let { app, page } = await launch();
  await expect(page.getByRole("heading", { name: "Comece abrindo uma pasta" })).toBeVisible();
  await shot(page, "1-vazio.png");

  // Abrir pasta → Explorer com a estrutura real.
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  const explorer = page.getByTestId("mod-explorer");
  await expect(explorer).toBeVisible();
  await expect(explorer.locator('[data-path="backend"]')).toBeVisible();
  await expect(explorer.locator('[data-path="README.md"]')).toBeVisible();
  await explorer.locator('[data-path="backend"]').click();
  await explorer.locator('[data-path="backend/src"]').click();
  await expect(explorer.locator('[data-path="backend/src/server.js"]')).toBeVisible();

  // Clicar no arquivo abre o Editor ao lado.
  await explorer.locator('[data-path="backend/src/server.js"]').click();
  const editor = page.getByTestId("mod-editor");
  await expect(editor).toBeVisible();
  await expect(editor.locator(".cm-content")).toContainText("createServer");

  // Editar e salvar com Ctrl+S (critério B4).
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// editado no Open Semantic\n");
  await expect(editor.getByTestId("editor-state")).toHaveText("● não salvo");
  await page.keyboard.press("Control+s");
  await expect(editor.getByTestId("editor-state")).toHaveText("salvo");
  expect(await readFile(join(projectDir, "backend/src/server.js"), "utf8")).toContain("// editado no Open Semantic");

  // Mover o Explorer arrastando o título.
  const header = explorer.locator(".mod-header");
  const box = (await header.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 60 - 120, box.y + 15 + 90, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("persist")).toHaveText("Salvo");
  await page.waitForTimeout(800); // câmera é salva com atraso
  await expect(page.getByTestId("persist")).toHaveText("Salvo");
  await shot(page, "2-explorer-e-editor.png");

  const before = await snapshot(page);
  expect(before.mods.map((m) => m.type).sort()).toEqual(["editor", "explorer"]);
  const movedExplorer = before.canvas.objects.find((o) => o.id === before.mods.find((m) => m.type === "explorer")!.id)!;
  expect(movedExplorer.placedBy).toBe("user");

  // Fechar e reabrir: mesmos ids, configurações, posições e câmera (critério A2).
  await app.close();
  ({ app, page } = await launch());
  await expect(page.getByTestId("mod-explorer")).toBeVisible();
  await expect(page.getByTestId("mod-editor")).toBeVisible();
  const after = await snapshot(page);
  expect(after.mods).toEqual(before.mods);
  expect(after.canvas).toEqual(before.canvas);
  expect(after.navigation.camera).toEqual(before.navigation.camera);
  // A pasta expandida continua expandida.
  await expect(page.getByTestId("mod-explorer").locator('[data-path="backend/src/server.js"]')).toBeVisible();
  await shot(page, "3-reaberto.png");

  // Mudança externa com alteração não salva: conflito em vez de sobrescrever.
  const reopenedEditor = page.getByTestId("mod-editor");
  await expect(reopenedEditor.locator(".cm-content")).toContainText("editado no Open Semantic");
  await writeFile(join(projectDir, "backend/src/server.js"), "// mudou fora do app\n");
  await reopenedEditor.locator(".cm-content").click();
  await page.keyboard.type("x");
  await page.keyboard.press("Control+s");
  await expect(reopenedEditor.getByRole("alert")).toContainText("O arquivo mudou fora do editor");
  expect(await readFile(join(projectDir, "backend/src/server.js"), "utf8")).toBe("// mudou fora do app\n");
  await shot(page, "4-conflito.png");

  // Fechar um mod não o exclui (A3).
  await page.getByTestId("mod-editor").getByRole("button", { name: "Fechar" }).click();
  await expect(page.getByTestId("mod-editor").locator(".mod-body")).toHaveCount(0);
  expect((await snapshot(page)).mods.find((m) => m.type === "editor")?.lifecycle).toBe("closed");

  await app.close();
});
