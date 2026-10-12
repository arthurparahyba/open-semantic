// Vários projetos no workspace: a pasta aberta por último é a ativa, e dá para tirar um projeto.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = process.env.OPEN_SEMANTIC_SCREENSHOT_DIR;

let dataDir: string;
let petclinic: string;
let tests: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-prj-"));
  petclinic = await mkdtemp(join(tmpdir(), "spring-petclinic-"));
  tests = await mkdtemp(join(tmpdir(), "tests-"));
  await writeFile(join(petclinic, "pom.xml"), "<project/>\n");
  await mkdir(join(tests, "docs"));
});

test.afterAll(async () => {
  await Promise.all([dataDir, petclinic, tests].map((d) => rm(d, { recursive: true, force: true })));
});

test("a pasta aberta por último é a ativa; tirar um projeto não apaga arquivos", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({ args, env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: tests } });
  const page = await app.firstWindow();
  const snapshot = () => page.evaluate(() => window.openSemantic.snapshot());

  // Um projeto antigo já estava no workspace (como o petclinic do Arthur).
  await page.evaluate(
    (rootPath) =>
      window.openSemantic.dispatch({ operationId: "act_e2e_old_project", operation: "workspace.add_project", arguments: { projectId: "prj_petclinic", name: "spring-petclinic", rootPath } }),
    petclinic,
  );
  await expect(page.locator('[data-project-id="prj_petclinic"]')).toHaveAttribute("data-active", "true");

  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();
  const testsId = (await snapshot()).workspace.activeProjectId!;
  expect(testsId).not.toBe("prj_petclinic");
  await expect(page.locator(`[data-project-id="${testsId}"]`)).toHaveAttribute("data-active", "true");
  await expect(page.locator('[data-project-id="prj_petclinic"]')).toHaveAttribute("data-active", "false");

  // Clicar no nome torna o projeto ativo.
  await page.locator('[data-project-id="prj_petclinic"] .project-name').click();
  await expect.poll(async () => (await snapshot()).workspace.activeProjectId).toBe("prj_petclinic");
  await page.locator(`[data-project-id="${testsId}"] .project-name`).click();
  await expect.poll(async () => (await snapshot()).workspace.activeProjectId).toBe(testsId);
  if (screenshots) await page.screenshot({ path: join(screenshots, "m2-7-projetos.png") });

  // Tirar o petclinic pede confirmação e não mexe no disco.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Tirar spring-petclinic do workspace" }).click();
  await expect(page.locator('[data-project-id="prj_petclinic"]')).toHaveCount(0);
  const after = await snapshot();
  expect(after.projects.map((p) => p.id)).toEqual([testsId]);
  expect(existsSync(join(petclinic, "pom.xml"))).toBe(true);
  await expect(page.getByTestId("mod-explorer")).toBeVisible();

  await app.close();
});
