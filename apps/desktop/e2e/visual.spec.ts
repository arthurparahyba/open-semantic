// Visual first, de ponta a ponta: "explique o projeto" vira um diagrama no canvas, com a legenda junto dele,
// e a resposta no chat aponta para o diagrama. Provedor roteirizado no lugar do Claude.
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
  dataDir = await mkdtemp(join(tmpdir(), "os-e2e-visual-"));
  projectDir = await mkdtemp(join(tmpdir(), "petclinic-"));
  await mkdir(join(projectDir, "src", "main", "java", "owner"), { recursive: true });
  await mkdir(join(projectDir, "src", "main", "java", "vet"), { recursive: true });
  await writeFile(join(projectDir, "pom.xml"), "<project><artifactId>spring-petclinic</artifactId></project>\n");
  scriptFile = join(dataDir, "roteiro-llm.json");
  await writeFile(scriptFile, "[]");
});

test.afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test("explicação: a resposta é um diagrama com legenda, e o chat aponta para ele", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: projectDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();
  await page.getByTestId("history-toggle").click();
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();

  const caption = "O navegador chama os controllers de Donos e Veterinários, que leem e gravam no banco. O banco é suposição: não vi a configuração.";
  await writeFile(
    scriptFile,
    JSON.stringify([
      { text: "Vou olhar o repositório.", toolCalls: [{ id: "tu_1", name: "list_dir", input: { path: "", depth: 4 } }] },
      {
        toolCalls: [
          {
            id: "tu_2",
            name: "show_diagram",
            input: {
              diagramId: "dgm_petclinic_overview",
              title: "Visão geral do Pet Clinic",
              kind: "architecture",
              caption,
              nodes: [
                { id: "browser", label: "Navegador", kind: "actor" },
                { id: "owners", label: "Donos e pets", kind: "module", path: "src/main/java/owner", seen: "Pacote owner com controller e repositório." },
                { id: "vets", label: "Veterinários", kind: "module", path: "src/main/java/vet", seen: "Pacote vet." },
                { id: "db", label: "Banco de dados", kind: "data_store" },
              ],
              edges: [
                { from: "browser", to: "owners", label: "HTTP" },
                { from: "browser", to: "vets", label: "HTTP" },
                { from: "owners", to: "db", label: "JPA" },
                { from: "vets", to: "db", label: "JPA" },
              ],
            },
          },
        ],
      },
      { text: "Este é o Pet Clinic: o navegador fala com Donos e pets e com Veterinários, que usam o banco." },
    ]),
  );

  await page.getByTestId("chat-input").fill("me explique a funcionalidade deste repositório");
  await page.getByTestId("chat-send").click();

  const diagram = page.locator('[data-diagram-id="dgm_petclinic_overview"]');
  await expect(diagram).toBeVisible();
  await expect(diagram.getByTestId("diagram-caption")).toContainText("O banco é suposição");
  await expect(diagram.locator(".diagram-node.q-verified")).toHaveCount(2);
  await expect(diagram.locator(".diagram-node.q-inferred")).toHaveCount(2);

  // O texto que acompanhou a leitura não aparece; a resposta vem depois do desenho e aponta para ele.
  const answers = page.getByTestId("chat-assistant");
  await expect(answers).toHaveCount(1);
  await expect(answers.first().getByTestId("chat-diagram")).toContainText("Visão geral do Pet Clinic");
  await expect(answers.first()).toContainText("o navegador fala com Donos e pets");
  await expect(page.getByText("Vou olhar o repositório.")).toHaveCount(0);

  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(600);
  if (screenshots) await page.screenshot({ path: join(screenshots, "visual-1-explicacao.png") });

  // O botão do diagrama no chat leva de volta a ele.
  await page.getByTestId("chat-diagram").click();
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.focus.targetIds).toContain("dgm_petclinic_overview");

  await app.close();
});

test("tipos: camadas em faixas e sequência com linhas de vida", async () => {
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: projectDir, OPEN_SEMANTIC_SCRIPTED_LLM: scriptFile },
  });
  const page = await app.firstWindow();
  await page.getByTestId("history-toggle").click();
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await expect(page.getByTestId("mod-explorer")).toBeVisible();

  await writeFile(
    scriptFile,
    JSON.stringify([
      {
        toolCalls: [
          {
            id: "tu_l",
            name: "show_diagram",
            input: {
              diagramId: "dgm_petclinic_camadas",
              title: "Camadas do Pet Clinic",
              kind: "layers",
              why: "o pedido é sobre os níveis da aplicação",
              caption: "Web no topo, serviços no meio e dados embaixo.",
              source: "layer Web\n  web[Controllers]:component\nlayer Domínio\n  owners[Donos e pets]:module\n  vets[Veterinários]:module\nlayer Dados\n  db[Banco]:data_store\nweb --> owners\nowners --> db",
              evidence: { owners: { path: "src/main/java/owner", seen: "Pacote owner." }, vets: { path: "src/main/java/vet", seen: "Pacote vet." } },
            },
          },
        ],
      },
      { text: "Três camadas: Web, Domínio e Dados." },
      {
        toolCalls: [
          {
            id: "tu_s",
            name: "show_diagram",
            input: {
              diagramId: "dgm_petclinic_cadastro",
              title: "Cadastro de dono",
              kind: "sequence",
              why: "o pedido é sobre como a funcionalidade acontece",
              caption: "O navegador envia o formulário, o controller valida e grava no banco.",
              source: "participant browser[Navegador]:actor\nparticipant ctrl[OwnerController]\nparticipant repo[OwnerRepository]\nbrowser ->> ctrl : POST /owners/new\nctrl ->> ctrl : valida\nctrl ->> repo : save(owner)\nrepo -->> ctrl : owner\nctrl -->> browser : redirect",
            },
          },
        ],
      },
      { text: "O cadastro passa pelo controller e pelo repositório." },
    ]),
  );

  await page.getByTestId("chat-input").fill("explique as camadas da aplicação");
  await page.getByTestId("chat-send").click();
  const layers = page.locator('[data-diagram-id="dgm_petclinic_camadas"]');
  await expect(layers.locator(".diagram-lane")).toHaveCount(3);
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(600);
  if (screenshots) await page.screenshot({ path: join(screenshots, "tipos-1-camadas.png") });

  await page.getByTestId("chat-input").fill("como está implementado o cadastro de dono?");
  await page.getByTestId("chat-send").click();
  const sequence = page.locator('[data-diagram-id="dgm_petclinic_cadastro"]');
  await expect(sequence.locator(".diagram-lifeline")).toHaveCount(3);
  await expect(sequence.locator(".diagram-message")).toHaveCount(5);
  await expect(sequence.locator(".diagram-message.is-reply")).toHaveCount(2);
  await expect.poll(async () => (await page.evaluate(() => window.openSemantic.snapshot())).navigation.motion.status).toBe("idle");
  await page.waitForTimeout(600);
  if (screenshots) await page.screenshot({ path: join(screenshots, "tipos-2-sequencia.png") });

  await app.close();
});
