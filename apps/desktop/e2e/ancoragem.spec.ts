// Ponta a ponta da ancoragem (doc 09): o agente desenha sem posicionar nada, o canvas agrupa pelas âncoras
// e "o que temos sobre X?" enquadra tudo o que está ancorado em X. Provedor roteirizado no lugar do Claude.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshots = process.env.OPEN_SEMANTIC_SCREENSHOT_DIR;

let dataDir: string;
let loja: string;
let pagamentos: string;
let scriptFile: string;

const diagram = (diagramId: string, title: string, extra: Record<string, unknown>) => ({
  id: diagramId,
  operation: "diagram.create",
  arguments: {
    diagramId,
    title,
    kind: "architecture",
    nodes: [
      { id: `nd_${diagramId.slice(4)}_a`, label: "Cliente", kind: "component" },
      { id: `nd_${diagramId.slice(4)}_b`, label: "Serviço", kind: "service" },
    ],
    edges: [{ id: `edg_${diagramId.slice(4)}`, sourceNodeId: `nd_${diagramId.slice(4)}_a`, targetNodeId: `nd_${diagramId.slice(4)}_b`, label: "HTTP" }],
    layout: { algorithm: "layered", direction: "LR" },
    ...extra,
  },
});

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-anc-"));
  loja = await mkdtemp(join(tmpdir(), "loja-"));
  pagamentos = await mkdtemp(join(tmpdir(), "pagamentos-"));
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(
    scriptFile,
    JSON.stringify([
      {
        text: "Vou registrar o assunto e desenhar.",
        toolCalls: [
          {
            id: "tu_1",
            name: "run_batch",
            input: {
              intent: "Desenhar o checkout e os pagamentos",
              steps: [
                {
                  id: "assunto",
                  operation: "semantic.upsert_inference",
                  arguments: {
                    entities: [{ id: "sem_checkout", kind: "concept", name: "Checkout lento", projectId: "prj_loja" }],
                    confidence: 0.6,
                    rationale: "Assunto aberto na conversa.",
                  },
                },
                { ...diagram("dgm_checkout", "Fluxo do checkout", { anchorIds: ["sem_checkout"] }), dependsOn: ["assunto"] },
                { ...diagram("dgm_checkout_b", "Chamada ao antifraude", { anchorIds: ["sem_checkout"] }), dependsOn: ["assunto"] },
                diagram("dgm_loja", "Visão geral da loja", { projectId: "prj_loja" }),
                diagram("dgm_pag", "Serviço de pagamentos", { projectId: "prj_pagamentos" }),
              ],
            },
          },
        ],
      },
      { text: "Desenhei o checkout dentro da loja e os pagamentos à parte." },
      {
        toolCalls: [
          {
            id: "tu_2",
            name: "run_batch",
            input: {
              intent: "Mostrar o que temos sobre o checkout",
              steps: [{ id: "fr", operation: "navigation.frame", arguments: { targets: { semanticEntityIds: ["sem_checkout"] }, intent: "focus", reason: "O que temos sobre o checkout" } }],
            },
          },
        ],
      },
      { text: "Aqui está tudo o que temos sobre o checkout: dois diagramas." },
    ]),
  );
});

test.afterAll(async () => {
  await Promise.all([dataDir, loja, pagamentos].map((d) => rm(d, { recursive: true, force: true })));
});

test("ancoragem: o canvas agrupa pelas âncoras e enquadra o que temos sobre um assunto", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();
  await page.getByTestId("history-toggle").click();
  const shot = async (name: string) => {
    if (screenshots) await page.screenshot({ path: join(screenshots, name) });
  };
  await expect(page.getByTestId("workspace-name")).toBeVisible();
  for (const [projectId, name, rootPath] of [
    ["prj_loja", "loja", loja],
    ["prj_pagamentos", "pagamentos", pagamentos],
  ]) {
    const result = await page.evaluate(
      (a) => window.openSemantic.dispatch({ operationId: `act_e2e_${a.name}`, operation: "workspace.add_project", arguments: a }),
      { projectId, name, rootPath },
    );
    expect(result.status).toBe("succeeded");
  }
  await page.evaluate(() => window.openSemantic.dispatch({ operationId: "act_e2e_active", operation: "workspace.set_active_project", arguments: { projectId: "prj_loja" } }));

  await page.getByTestId("chat-input").fill("desenhe o checkout lento da loja e o serviço de pagamentos");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("pagamentos à parte");
  for (const id of ["sem_loja_repo", "sem_pagamentos_repo", "sem_checkout"]) await expect(page.locator(`[data-unit-id="${id}"]`)).toBeVisible();
  await expect(page.locator('[data-unit-id="sem_loja_repo"]')).toContainText("loja");
  await expect(page.locator('[data-unit-id="sem_checkout"]')).toContainText("Checkout lento");

  // As caixas na tela confirmam a projeção: o assunto dentro da loja, os pagamentos fora dela.
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const lojaBox = await box('[data-unit-id="sem_loja_repo"]');
  const checkoutBox = await box('[data-unit-id="sem_checkout"]');
  const pagBox = await box('[data-unit-id="sem_pagamentos_repo"]');
  expect(checkoutBox.x).toBeGreaterThanOrEqual(lojaBox.x);
  expect(checkoutBox.x + checkoutBox.width).toBeLessThanOrEqual(lojaBox.x + lojaBox.width + 1);
  const apart = pagBox.x >= lojaBox.x + lojaBox.width || pagBox.y >= lojaBox.y + lojaBox.height || lojaBox.x >= pagBox.x + pagBox.width;
  expect(apart).toBe(true);

  // "O que temos sobre o checkout?"
  await page.getByTestId("chat-input").fill("o que temos sobre o checkout?");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-assistant").last()).toContainText("tudo o que temos sobre o checkout");
  const nav = (await page.evaluate(() => window.openSemantic.snapshot())).navigation;
  const focus = nav.focus as { targetIds?: string[] };
  expect(focus.targetIds).toEqual(expect.arrayContaining(["dgm_checkout", "dgm_checkout_b", "sem_checkout"]));
  expect(focus.targetIds).not.toContain("dgm_pag");
  expect(focus.targetIds).not.toContain("dgm_loja");
  await expect(page.locator('[data-unit-id="sem_checkout"]')).toHaveClass(/is-highlighted/);
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(600);
  await shot("anc-2-o-que-temos.png");

  // Visão do canvas inteiro: cada repositório no seu grupo, o assunto dentro da loja.
  await page.getByRole("button", { name: "Ver tudo" }).click();
  await page.waitForTimeout(900);
  await shot("anc-1-grupos.png");
  await app.close();
});
