// Layout semântico (docs/funcionalidades/13-layout-semantico.md), de ponta a ponta: a explicação desce pelo canvas
// com título, introdução, notas e tabela junto de cada diagrama; o detalhe vai à direita; "Reorganizar" anima e desfaz.
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
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-layout-"));
  projectDir = await mkdtemp(join(tmpdir(), "loja-"));
  await mkdir(join(projectDir, "api"), { recursive: true });
  await mkdir(join(projectDir, "web"), { recursive: true });
  await writeFile(join(projectDir, "package.json"), '{"name":"loja"}\n');
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(scriptFile, "[]");
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

const step = (id: string, input: Record<string, unknown>) => ({ toolCalls: [{ id, name: "show_diagram", input }] });

test("explicação de cima para baixo: seções com texto, detalhe à direita e reorganização com desfazer", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: projectDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();

  await writeFile(
    scriptFile,
    JSON.stringify([
      step("tu_1", {
        diagramId: "dgm_loja_geral",
        title: "Visão geral",
        kind: "architecture",
        caption: "A Web chama a API, que usa o Banco.",
        heading: "1. Estrutura geral",
        intro: "A loja tem uma interface **Web** e uma **API**; os dados ficam no banco.",
        source: "web[Web]:module\napi[API]:service\ndb[Banco]:data_store\nweb --> api : HTTP\napi --> db : SQL",
        evidence: { web: { path: "web", seen: "Pasta web/." }, api: { path: "api", seen: "Pasta api/." } },
      }),
      step("tu_2", {
        diagramId: "dgm_loja_infra",
        title: "Infraestrutura",
        kind: "layers",
        caption: "API na frente do cache e do banco.",
        heading: "2. Infraestrutura e cache",
        intro: "Cada leitura passa primeiro pelo cache.",
        source: "layer Serviços\n  api[API]:service\nlayer Dados\n  cache[Cache]:data_store\n  db[Banco]:data_store\napi --> cache : lê\napi --> db : grava",
        notes: [
          { kind: "list", ordered: true, items: ["A API procura no cache.", "Se não achar, lê o banco.", "Guarda no cache por 5 minutos."] },
          { kind: "table", columns: ["Peça", "Papel"], rows: [["Cache", "respostas rápidas"], ["Banco", "fonte da verdade"]] },
        ],
      }),
      step("tu_3", {
        diagramId: "dgm_loja_cache_seq",
        title: "Leitura com cache",
        kind: "sequence",
        caption: "A API tenta o cache antes do banco.",
        heading: "Detalhe: uma leitura",
        details: "dgm_loja_infra",
        source: "participant api[API]\nparticipant cache[Cache]\nparticipant db[Banco]\napi ->> cache : get\ncache -->> api : vazio\napi ->> db : select\ndb -->> api : linhas",
      }),
      { text: "A explicação desce pelo canvas: estrutura, infraestrutura com o cache e, à direita, o detalhe de uma leitura." },
    ]),
  );
  await page.getByTestId("chat-input").fill("explique a loja, a infraestrutura e como funciona o cache");
  await page.getByTestId("chat-send").click();

  await expect(page.locator('[data-diagram-id="dgm_loja_cache_seq"]')).toBeVisible();
  await expect(page.getByTestId("block")).toHaveCount(5);
  await expect(page.locator('[data-block-id="blk_loja_infra_intro"]')).toContainText("2. Infraestrutura e cache");
  await expect(page.locator('[data-block-id="blk_loja_infra_n1"] ol li')).toHaveCount(3);
  await expect(page.locator('[data-block-id="blk_loja_infra_n2"] table tbody tr')).toHaveCount(2);

  const snap = await page.evaluate(() => window.openSemantic.snapshot());
  const at = (id: string) => snap.canvas.objects.find((o) => o.id === id)!;
  const [geral, infra, seq] = [at("dgm_loja_geral"), at("dgm_loja_infra"), at("dgm_loja_cache_seq")];
  expect(infra.position.x).toBe(geral.position.x);
  expect(infra.position.y).toBeGreaterThan(geral.position.y + geral.size.height);
  expect(seq.position.x).toBeGreaterThan(infra.position.x + infra.size.width);

  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.getByRole("button", { name: "Ver tudo" }).click();
  await page.waitForTimeout(800);
  if (screenshots) await page.screenshot({ path: join(screenshots, "layout-1-explicacao.png") });

  // Arrastado à mão para longe, o passo fica fixo; "Reorganizar" (tudo) traz de volta, animado, e dá para desfazer.
  await page.evaluate(() => window.openSemantic.dispatch({ operationId: "act_e2e_move01", operation: "canvas.place", arguments: { objectId: "dgm_loja_infra", position: { x: 3000, y: 3000 } } }));
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).canvas.objects.find((o) => o.id === "dgm_loja_infra")!.position.x).toBe(3000);
  await page.getByTestId("rebalance").click();
  await expect(page.getByText("Reorganizei o canvas.")).toBeVisible();
  const back = (await page.evaluate(() => window.openSemantic.snapshot())).canvas.objects.find((o) => o.id === "dgm_loja_infra")!;
  expect(back.position).toEqual(infra.position);
  await page.getByRole("button", { name: "Desfazer" }).click();
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).canvas.objects.find((o) => o.id === "dgm_loja_infra")!.position.x).toBe(3000);

  await app.close();
});
