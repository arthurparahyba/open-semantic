// Teste de uso ponta a ponta (uso/README.md): o app de verdade, com o Claude de verdade, faz o caminho do usuário
// no Pet Clinic, do discovery até a camada de implementação. Checagens fixas ficam no código; a qualidade da
// explicação, dos diagramas e da organização do canvas é julgada a cada passo pelo avaliador (Opus, esforço baixo).
// Ao fim, grava relatorios-uso/<data>/relatorio.md com os screenshots, os bugs e as melhorias.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, test, type Page } from "@playwright/test";
import type { WorkspaceSnapshot } from "@open-semantic/protocol";
import type { ConversationView } from "../src/shared/api.js";

import { avaliar, consolidar, escolher, gasto, MODELO_AVALIADOR, type Avaliacao } from "./avaliador.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.USO_PETCLINIC_REPO ?? "https://github.com/spring-projects/spring-petclinic.git";
const MODELO_APP = process.env.USO_MODELO_APP ?? "claude-haiku-5-5";
/** Limite de rodadas de pergunta/confirmação por passo, para o teste não girar sem fim. */
const MAX_INTERACOES = 6;

const PASSOS = [
  {
    id: "1-como-funciona",
    pedido: "Como a aplicação Pet Clinic funciona? Me explique a arquitetura e os principais fluxos.",
    objetivo: "Entender a aplicação existente com diagramas adequados na camada base (discovery).",
  },
  {
    id: "2-cadastro-produtos",
    pedido: "Quero especificar uma funcionalidade nova: cadastro de produtos (pet shop) com nome, preço e estoque. Comece pelo processo em BPMN e uma proposta de tela.",
    objetivo: "Uma camada nova de especificação, com BPMN do processo e wireframe da tela, sem bagunçar a camada base.",
  },
  {
    id: "3-refinar-tela",
    pedido: "Na tela de cadastro, adicione validação de preço maior que zero e um campo de categoria.",
    objetivo: "O wireframe (e, se fizer sentido, o BPMN) muda para refletir o refinamento, na mesma camada.",
  },
  {
    id: "4-implementacao",
    pedido: "Está bom. Vamos para a implementação.",
    objetivo: "Chegar de forma natural à camada 3 \"Implementação: <assunto>\", com specs/<assunto>.md e o botão Copiar pedido.",
  },
] as const;

const falhas: string[] = [];
const checar = (passo: string, ok: boolean, descricao: string) => {
  if (!ok) falhas.push(`${passo}: ${descricao}`);
  return ok;
};

/** O que o avaliador precisa ver do workspace: camadas, diagramas e onde estão no canvas. */
function resumo(s: WorkspaceSnapshot) {
  const layers = s.layers ?? [];
  const camadaDe = (id: string) => layers.find((l) => l.members.some((m) => m.id === id))?.name ?? "base";
  return {
    camadas: layers.map((l) => ({ nome: l.name, pai: layers.find((p) => p.id === l.parentId)?.name ?? (l.parentId ? "?" : "base") })),
    diagramas: s.diagrams.map((d) => {
      const o = s.canvas.objects.find((c) => c.id === d.id);
      return {
        titulo: d.title,
        tipo: d.kind,
        camada: camadaDe(d.id),
        nos: d.nodes.length,
        ...(o ? { x: Math.round(o.position.x), y: Math.round(o.position.y), w: Math.round(o.size.width), h: Math.round(o.size.height) } : {}),
      };
    }),
  };
}

/** Pares de diagramas cujas caixas se cruzam no canvas. */
function sobreposicoes(s: WorkspaceSnapshot): string[] {
  const caixas = s.canvas.objects.filter((o) => o.objectKind === "diagram" && !o.collapsed);
  const nome = (id: string) => s.diagrams.find((d) => d.id === id)?.title ?? id;
  const out: string[] = [];
  for (let i = 0; i < caixas.length; i++)
    for (let j = i + 1; j < caixas.length; j++) {
      const a = caixas[i]!, b = caixas[j]!;
      if (a.position.x < b.position.x + b.size.width && b.position.x < a.position.x + a.size.width && a.position.y < b.position.y + b.size.height && b.position.y < a.position.y + a.size.height)
        out.push(`${nome(a.id)} × ${nome(b.id)}`);
    }
  return out;
}

/** Espera o agente terminar, respondendo perguntas (pelo avaliador) e aprovando confirmações no caminho. */
async function esperarAgente(page: Page, objetivo: string, log: string[]) {
  for (let rodada = 0; rodada < MAX_INTERACOES; rodada++) {
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="chat-stop"]') || document.querySelector('[data-testid="dock-question"], [data-testid="dock-confirm"]'),
      undefined,
      { timeout: 10 * 60_000, polling: 1000 },
    );
    const confirm = page.getByTestId("dock-confirm");
    if (await confirm.isVisible()) {
      log.push(`confirmação aprovada: ${(await confirm.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
      await confirm.getByRole("button", { name: "Aprovar" }).click();
      continue;
    }
    const pergunta = page.getByTestId("dock-question");
    if (await pergunta.isVisible()) {
      const texto = (await pergunta.locator("span").first().innerText()).trim();
      const opcoes = await pergunta.getByTestId("dock-option").allInnerTexts();
      const i = await escolher(objetivo, texto, opcoes);
      log.push(`pergunta: "${texto}" → "${opcoes[i]}"`);
      await pergunta.getByTestId("dock-option").nth(i).click();
      await page.waitForTimeout(1500);
      continue;
    }
    // Ocioso; dá um respiro para a navegação animada assentar antes do screenshot. Quem diz que acabou é a
    // conversa (status idle), não o botão Parar, que some antes de a resposta entrar no chat.
    await page.waitForTimeout(2500);
    if (!(await page.getByTestId("chat-stop").count()) && (await conversa(page)).status === "idle") return;
  }
  log.push(`passou de ${MAX_INTERACOES} rodadas de pergunta/confirmação`);
}

/** A conversa do app (respostas, custo e tokens). O histórico do chat só existe no DOM com o painel aberto. */
const conversa = (page: Page) => page.evaluate(() => window.openSemantic.conversation());

/** A resposta do agente a este passo: as falas dele depois da última mensagem do usuário (ou os avisos, se não houver). */
function respostaDoPasso(entries: ConversationView["entries"]): string {
  const i = entries.map((e) => e.kind).lastIndexOf("user");
  const depois = entries.slice(i + 1);
  const falas = depois.filter((e) => e.kind === "assistant").map((e) => e.text).filter(Boolean);
  const avisos = depois.filter((e) => e.kind === "notice").map((e) => `[aviso] ${e.text}`);
  return (falas.length ? falas : avisos).join("\n\n");
}

const usd = (n: number) => `US$ ${n.toFixed(3)}`;
const custoDe = (v: ConversationView) => `${usd(v.costUsd)}, ${v.usage.inputTokens} tokens de entrada (${v.usage.cacheReadTokens} do cache), ${v.usage.outputTokens} de saída`;

async function clonarPetClinic(): Promise<{ dir: string; commit: string }> {
  const cache = join(homedir(), ".cache", "open-semantic-uso", "spring-petclinic");
  if (!existsSync(join(cache, ".git"))) {
    await mkdir(dirname(cache), { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", REPO, cache], { stdio: "inherit" });
  }
  if (process.env.USO_PETCLINIC_REF) {
    execFileSync("git", ["-C", cache, "fetch", "--depth", "1", "origin", process.env.USO_PETCLINIC_REF], { stdio: "inherit" });
    execFileSync("git", ["-C", cache, "checkout", "--detach", "FETCH_HEAD"], { stdio: "inherit" });
  }
  const commit = execFileSync("git", ["-C", cache, "rev-parse", "--short", "HEAD"]).toString().trim();
  // Cópia nova a cada execução: o app grava specs/ no repositório.
  const dir = join(await mkdtemp(join(tmpdir(), "uso-")), "spring-petclinic");
  await cp(cache, dir, { recursive: true });
  return { dir, commit };
}

type Snapshot = WorkspaceSnapshot;
type Passo = (typeof PASSOS)[number];
interface Contexto {
  page: Page;
  saida: string;
  petclinic: string;
  estado: { wireframe: string; daSpec: string[] };
}

const wireframes = (s: Snapshot) => JSON.stringify(s.diagrams.filter((d) => d.kind === "wireframe").map((d) => d.nodes));

async function specsGravados(petclinic: string) {
  const dir = join(petclinic, "specs");
  if (!existsSync(dir)) return [];
  const out: { nome: string; texto: string }[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".md"))) out.push({ nome: f, texto: await readFile(join(dir, f), "utf8") });
  return out;
}

/** Checagens fixas de cada passo; `estado` guarda o wireframe do passo 2 para comparar no 3. */
async function checagensFixas(passo: Passo, s: Snapshot, { page, petclinic, estado }: Contexto) {
  const layers = s.layers ?? [];
  const tipos = new Set(s.diagrams.map((d) => d.kind));
  const sobre = sobreposicoes(s);
  checar(passo.id, sobre.length === 0, `diagramas sobrepostos: ${sobre.join("; ")}`);
  switch (passo.id) {
    case "1-como-funciona":
      checar(passo.id, s.diagrams.length >= 1, "nenhum diagrama na explicação");
      break;
    case "2-cadastro-produtos":
      const spec = layers.find((l) => l.name.startsWith("Especificação"));
      checar(passo.id, !!spec, 'não abriu a camada "Especificação: <assunto>"');
      const naSpec = s.diagrams.filter((d) => spec?.members.some((m) => m.id === d.id)).map((d) => d.kind);
      checar(passo.id, naSpec.includes("bpmn") && naSpec.includes("wireframe"), `BPMN e wireframe não estão na camada de especificação (nela: ${naSpec.join(", ") || "nada"})`);
      checar(passo.id, tipos.has("bpmn"), "sem diagrama BPMN");
      checar(passo.id, tipos.has("wireframe"), "sem wireframe da tela");
      estado.wireframe = wireframes(s);
      break;
    case "3-refinar-tela":
      estado.daSpec = layers.find((l) => l.name.startsWith("Especificação"))?.members.map((m) => m.id) ?? [];
      checar(passo.id, wireframes(s) !== estado.wireframe, "o refinamento não alterou o wireframe");
      break;
    case "4-implementacao": {
      const impl = layers.find((l) => l.name.startsWith("Implementação"));
      const pai = layers.find((l) => l.id === impl?.parentId);
      checar(passo.id, !!impl, 'não chegou à camada "Implementação: <assunto>"');
      checar(passo.id, !impl || !!pai?.name.startsWith("Especificação"), "a implementação não é filha da especificação");
      const movidos = s.diagrams.filter((d) => estado.daSpec.includes(d.id) && !pai?.members.some((m) => m.id === d.id)).map((d) => d.title);
      checar(passo.id, movidos.length === 0, `diagramas saíram da camada de especificação: ${movidos.join(", ")}`);
      const specs = await specsGravados(petclinic);
      checar(passo.id, specs.length > 0, "nenhum specs/<assunto>.md gravado no repositório");
      for (const f of specs) checar(passo.id, f.texto.trim().length > 200, `specs/${f.nome} está vazio ou curto demais`);
      checar(passo.id, await page.getByRole("button", { name: "Copiar pedido" }).isVisible().catch(() => false), "botão Copiar pedido não aparece");
      break;
    }
  }
}

/** Faz um pedido, espera o agente, checa e pede o julgamento do avaliador. Devolve a avaliação e o trecho do diário. */
async function executarPasso(passo: Passo, ctx: Contexto) {
  const { page, saida } = ctx;
  const log: string[] = [];
  const t0 = Date.now();
  const antes = (await conversa(page)).costUsd;
  await page.getByTestId("chat-input").fill(passo.pedido);
  await page.getByTestId("chat-input").press("Enter");
  await esperarAgente(page, passo.objetivo, log);
  const s = await page.evaluate(() => window.openSemantic.snapshot());
  const screenshot = join(saida, `${passo.id}.png`);
  await page.screenshot({ path: screenshot });
  const v = await conversa(page);
  const resposta = respostaDoPasso(v.entries) || "(sem resposta)";
  const custo = v.costUsd - antes;
  await checagensFixas(passo, s, ctx);
  const a = await avaliar({ passo: passo.id, objetivo: passo.objetivo, screenshot, resumo: resumo(s), resposta });
  const diario =
    `### ${passo.id} (${Math.round((Date.now() - t0) / 1000)} s, agente ${usd(custo)})\n\n**Pedido:** ${passo.pedido}\n\n${log.map((l) => `- ${l}`).join("\n")}\n\n` +
    `**Resposta do agente:** ${resposta.replace(/\s+/g, " ").slice(0, 600)}\n\n![](${passo.id}.png)\n\n**Nota ${a.nota}/5.** ${a.explicacao}\n\n**Organização ${a.organizacao.nota}/5.** ${a.organizacao.comentario}\n`;
  return { avaliacao: a, diario, custo };
}

const lista = (itens: string[], vazio: string, numerada = false) => (itens.length ? itens.map((t, i) => `${numerada ? `${i + 1}.` : "-"} ${t}`) : [vazio]);

async function escreverRelatorio(o: { saida: string; inicio: Date; commit: string; avaliacoes: Avaliacao[]; diario: string[]; custoApp: string }) {
  const final = await consolidar(o.avaliacoes, falhas).catch((e) => ({ resumo: `consolidação falhou: ${e}`, bugs: [] as string[], melhorias: [] as string[] }));
  const notas = o.avaliacoes.map((a) => `${a.passo} ${a.nota}/5 (org. ${a.organizacao.nota}/5)`).join(", ");
  const md = [
    `# Teste de uso: Pet Clinic, ${o.inicio.toLocaleString("pt-BR")}`,
    "",
    `Pet Clinic em ${o.commit}. Agente do app: ${MODELO_APP}. Avaliador: ${MODELO_AVALIADOR} (esforço baixo).`,
    "",
    `**Resultado:** ${falhas.length ? `${falhas.length} checagem(ns) falharam` : "todas as checagens fixas passaram"}. Notas: ${notas}.`,
    "",
    final.resumo,
    "",
    "## Checagens que falharam",
    "",
    ...lista(falhas, "Nenhuma."),
    "",
    "## Bugs",
    "",
    ...lista(final.bugs, "Nenhum apontado.", true),
    "",
    "## Melhorias",
    "",
    ...lista(final.melhorias, "Nenhuma apontada.", true),
    "",
    "## Custo",
    "",
    `- Agente do app: ${o.custoApp || "não lido"}`,
    `- Avaliador: ${gasto.chamadas} chamadas, ${gasto.entrada} tokens de entrada, ${gasto.saida} de saída, US$ ${gasto.usd.toFixed(3)}`,
    "",
    "## Passo a passo",
    "",
    ...o.diario,
  ].join("\n");
  await writeFile(join(o.saida, "relatorio.md"), md);
  await writeFile(join(o.saida, "avaliacoes.json"), JSON.stringify({ falhas, avaliacoes: o.avaliacoes, final, gasto }, null, 2));
  console.log(`\nRelatório: ${join(o.saida, "relatorio.md")}\n`);
}

async function abrirApp(petclinic: string, dataDir: string) {
  await writeFile(join(dataDir, "agent-settings.json"), JSON.stringify({ model: MODELO_APP, maxCostPerRequestUsd: Number(process.env.USO_MAX_CUSTO_PEDIDO ?? 0.5) }));
  const args = [appRoot];
  if (process.getuid?.() === 0 || process.env.CI) args.unshift("--no-sandbox");
  const app = await electron.launch({
    args,
    env: { ...process.env, OPEN_SEMANTIC_DATA_DIR: dataDir, OPEN_SEMANTIC_WORKSPACE: join(dataDir, "workspace"), OPEN_SEMANTIC_TEST_FOLDER: petclinic },
  });
  const page = await app.firstWindow();
  const erros: string[] = [];
  page.on("console", (m) => m.type() === "error" && erros.push(m.text()));
  page.on("pageerror", (e) => erros.push(String(e)));
  return { app, page, erros };
}

/** Abre o workspace e associa o repositório. */
async function associarRepositorio(page: Page, saida: string) {
  await page.waitForLoadState("domcontentloaded");
  checar("0-abrir", await page.getByTestId("canvas").isVisible({ timeout: 30_000 }).catch(() => false), "o canvas não apareceu");
  await page.getByRole("button", { name: "Abrir pasta…" }).first().click();
  await page.waitForTimeout(2000);
  const s0 = await page.evaluate(() => window.openSemantic.snapshot());
  checar("0-abrir", s0.projects.length === 1, `esperava 1 projeto associado, veio ${s0.projects.length}`);
  await page.screenshot({ path: join(saida, "0-abrir.png") });
}

test("uso: Pet Clinic do discovery à implementação", async () => {
  test.skip(!process.env.ANTHROPIC_API_KEY, "precisa de ANTHROPIC_API_KEY");
  const inicio = new Date();
  const saida = join(appRoot, "relatorios-uso", inicio.toISOString().slice(0, 16).replace(/[:T]/g, "-"));
  await mkdir(saida, { recursive: true });
  const { dir: petclinic, commit } = await clonarPetClinic();
  const dataDir = await mkdtemp(join(tmpdir(), "uso-data-"));
  const { app, page, erros } = await abrirApp(petclinic, dataDir);
  const avaliacoes: Avaliacao[] = [];
  const diario: string[] = [];
  const custos: [string, number][] = [];
  const ctx: Contexto = { page, saida, petclinic, estado: { wireframe: "", daSpec: [] } };

  try {
    await associarRepositorio(page, saida);
    for (const passo of PASSOS) {
      const r = await executarPasso(passo, ctx);
      avaliacoes.push(r.avaliacao);
      diario.push(r.diario);
      custos.push([passo.id, r.custo]);
    }
  } catch (err) {
    falhas.push(`roteiro interrompido: ${err instanceof Error ? err.message : String(err)}`);
    await page.screenshot({ path: join(saida, "erro.png") }).catch(() => {});
  } finally {
    const custoApp = await conversa(page)
      .then((v) => `${v.model}: ${custoDe(v)}; por passo: ${custos.map(([id, c]) => `${id} ${usd(c)}`).join(", ")}`)
      .catch(() => "");
    await app.close().catch(() => {});
    if (erros.length) falhas.push(`erros no console: ${[...new Set(erros)].slice(0, 5).join(" | ")}`);
    await escreverRelatorio({ saida, inicio, commit, avaliacoes, diario, custoApp });
    await rm(dataDir, { recursive: true, force: true });
  }
  if (falhas.length) throw new Error(`Checagens que falharam:\n${falhas.join("\n")}`);
});
