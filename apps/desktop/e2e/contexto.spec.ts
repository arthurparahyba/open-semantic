// Ponta a ponta do motor de contexto (spec 08): a dúvida que muda o foco vira pergunta rápida no chat,
// o pedido só vai ao modelo com a resposta, e a suposição aparece com a opção de trocar.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-ctx-"));
  projectDir = await mkdtemp(join(tmpdir(), "banco-digital-"));
  await writeFile(join(projectDir, "README.md"), "# Banco digital\n");
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(scriptFile, "[]");
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test("contexto: pergunta rápida antes do modelo e suposição que pode ser trocada", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: projectDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();

  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();
  const projectId = (await page.evaluate(() => window.openSemantic.snapshot())).projects[0]!.id;
  const result = await page.evaluate(
    (projectId) =>
      window.openSemantic.dispatch({
        operationId: "act_e2e_ctx_0001",
        operation: "semantic.upsert_inference",
        arguments: {
          entities: [
            { id: "sem_portal", kind: "application", name: "Portal do cliente", aliases: ["portal"], attributes: { role: "frontend" }, projectId },
            { id: "sem_mobile", kind: "application", name: "App mobile", attributes: { role: "frontend" }, projectId },
            { id: "sem_contas", kind: "service", name: "api-contas", projectId },
            { id: "sem_cartoes", kind: "service", name: "api-cartoes", projectId },
          ],
          relations: [
            { id: "rel_portal_contas", type: "communicates_with", sourceId: "sem_portal", targetId: "sem_contas" },
            { id: "rel_portal_cartoes", type: "communicates_with", sourceId: "sem_portal", targetId: "sem_cartoes" },
            { id: "rel_mobile_contas", type: "communicates_with", sourceId: "sem_mobile", targetId: "sem_contas" },
          ],
          confidence: 0.8,
          rationale: "Desenho combinado com o time.",
        },
      }),
    projectId,
  );
  expect(result.status).toBe("succeeded");
  await writeFile(scriptFile, JSON.stringify([{ text: "O portal chama a api-cartoes por REST." }, { text: "O app mobile usa a api-contas." }]));

  // Dois back-ends ligados ao portal: pergunta antes de chamar o modelo.
  await page.getByTestId("chat-input").fill("Como o portal fala com o back-end?");
  await page.getByTestId("chat-send").click();
  const question = page.getByTestId("chat-choice").last();
  await expect(question).toContainText("De qual back-end você está falando?");
  await expect(page.getByTestId("chat-progress")).toContainText("esperando sua resposta");
  await expect(page.getByTestId("chat-assistant")).toHaveCount(0);
  if (screenshots) await page.screenshot({ path: join(screenshots, "m25-1-pergunta.png") });
  await question.getByRole("button", { name: /api-cartoes/ }).click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("api-cartoes por REST");

  // Um back-end só ligado ao app mobile: supõe, mostra a suposição e deixa trocar.
  await page.getByTestId("chat-input").fill("Como o app mobile fala com o back-end?");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("api-contas");
  const assumption = page.getByTestId("chat-choice").last();
  await expect(assumption).toContainText("Supus que back-end é api-contas");
  await assumption.getByTestId("chat-choice-change").click();
  await assumption.getByRole("button", { name: /api-cartoes/ }).click();
  await expect(assumption).toContainText("Supus que back-end é api-cartoes");
  if (screenshots) await page.screenshot({ path: join(screenshots, "m25-2-suposicao.png") });

  await app.close();
});
