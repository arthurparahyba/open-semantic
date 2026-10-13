// Visual first: explicação de estrutura ou fluxo vira diagrama no canvas; o texto é a legenda.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANTHROPIC_MODELS, type ChatMessage, type Completion, type CompletionRequest, type LlmProvider } from "@open-semantic/llm";

import { Conversation, VISUAL_NUDGE, asksForExplanation, createCore, slug, type Core } from "../src/index.js";

type Step = (request: CompletionRequest) => Partial<Completion>;

class FakeProvider implements LlmProvider {
  readonly id = "fake";
  readonly label = "Falso";
  readonly models = ANTHROPIC_MODELS;
  readonly defaultModel = "claude-haiku-5-5";
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly steps: Step[]) {}
  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps.shift();
    if (!step) throw new Error("roteiro do provedor acabou");
    const partial = step(request);
    return {
      text: "",
      toolCalls: [],
      stop: partial.toolCalls?.length ? "tool_use" : "end",
      usage: { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...partial,
    };
  }
}

let dataDir: string;
let projectDir: string;
let core: Core;

const conversation = (provider: LlmProvider) =>
  new Conversation({
    provider: () => provider,
    settings: () => ({ model: "claude-haiku-5-5", maxCostPerRequestUsd: 1 }),
    dispatcher: core.dispatcher,
    agent: core.agent,
    snapshot: () => core.store.snapshot(),
  });

let callSeq = 0;
const call = (name: string, input: Record<string, unknown>) => ({ id: `tu_${name}_${++callSeq}`, name, input });
const lastToolResult = (req: CompletionRequest) => {
  const tool = [...req.messages].reverse().find((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
  return JSON.parse(tool!.results[0]!.content);
};

/** Visão geral de uma app pequena: o front-end foi visto no projeto, a API e o banco são suposições. */
const overview = {
  diagramId: "dgm_minhaapp_overview",
  title: "Visão geral da MinhaAplicacao",
  kind: "architecture",
  caption: "O Frontend chama a API, que guarda os dados no Banco. Só o Frontend foi visto no código.",
  nodes: [
    { id: "frontend", label: "Frontend", kind: "module", path: "frontend", seen: "Pasta frontend/ na raiz." },
    { id: "api", label: "API", kind: "service" },
    { id: "db", label: "Banco", kind: "database" },
  ],
  edges: [
    { from: "frontend", to: "api", label: "HTTP" },
    { from: "api", to: "db", label: "grava" },
  ],
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  await mkdir(join(projectDir, "frontend"));
  await mkdir(join(projectDir, ".github"));
  await writeFile(join(projectDir, "README.md"), "# minha app\n");
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0 });
  const added = await core.dispatcher.dispatch({
    operationId: "act_visual_open",
    operation: "workspace.add_project",
    arguments: { projectId: "prj_minhaapp", name: "MinhaAplicacao", rootPath: projectDir },
    authorization: { actor: { kind: "user", id: "arthur" } },
  });
  expect(added.status).toBe("succeeded");
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir].map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

describe("Resposta visual (show_diagram)", () => {
  it("explique X: desenha o diagrama ancorado, separa visto de suposto e a resposta é a legenda", async () => {
    const provider = new FakeProvider([
      () => ({ text: "Vou olhar o projeto.", toolCalls: [call("list_dir", { path: "" })] }),
      () => ({ toolCalls: [call("show_diagram", overview)] }),
      () => ({ text: "O Frontend chama a API, que grava no Banco." }),
    ]);
    const conv = conversation(provider);
    await conv.send("me explique como funciona este projeto");

    const result = lastToolResult(provider.requests[2]!);
    expect(result.status, JSON.stringify(result, null, 1)).toBe("completed");
    expect(result.nodes.nd_frontend.knowledge).toBe("verified");
    expect(result.nodes.nd_api.knowledge).toBe("inferred");

    const snapshot = core.store.snapshot();
    const diagram = snapshot.diagrams.find((d) => d.id === "dgm_minhaapp_overview")!;
    expect(diagram.caption).toBe(overview.caption);
    expect(diagram.kind).toBe("architecture");
    const repo = snapshot.semantic.entities.find((e) => e.kind === "repository" && e.projectId === "prj_minhaapp")!;
    expect(diagram.anchorIds).toEqual([repo.id]);
    expect(diagram.nodes.map((n) => n.id)).toEqual(["nd_frontend", "nd_api", "nd_banco"]);

    const statusOf = (nodeId: string) => snapshot.semantic.entities.find((e) => e.id === diagram.nodes.find((n) => n.id === nodeId)!.semanticEntityId)!.status;
    expect(statusOf("nd_frontend")).toBe("verified");
    expect(statusOf("nd_api")).toBe("inferred");
    expect(snapshot.semantic.entities.find((e) => e.name === "Banco")!.kind).toBe("data_store");
    expect(diagram.edges.every((e) => snapshot.semantic.relations.some((r) => r.id === e.semanticRelationId && r.status === "inferred"))).toBe(true);
    // A câmera foi até o diagrama.
    expect(snapshot.navigation.focus.targetIds).toContain("dgm_minhaapp_overview");

    // No chat: nada de texto antes do desenho; a resposta final aponta para o diagrama.
    const view = conv.view();
    expect(view.entries.map((e) => e.kind)).toEqual(["user", "tool", "batch", "assistant"]);
    expect(view.entries.at(-1)).toMatchObject({ kind: "assistant", text: "O Frontend chama a API, que grava no Banco.", diagramIds: ["dgm_minhaapp_overview"] });
  });

  it("chamar de novo com o mesmo id completa o diagrama sem apagar o que já estava", async () => {
    const provider = new FakeProvider([
      () => ({ toolCalls: [call("show_diagram", overview)] }),
      () => ({ text: "Esboço pronto." }),
      () => ({
        toolCalls: [
          call("show_diagram", {
            diagramId: "dgm_minhaapp_overview",
            title: "Visão geral da MinhaAplicacao",
            kind: "architecture",
            caption: "Agora com o CI do GitHub.",
            nodes: [{ id: "ci", label: "CI", kind: "process", path: ".github", seen: "Pasta .github/ com a automação." }],
            edges: [{ from: "ci", to: "nd_frontend", label: "testa", type: "tests", seen: true }],
          }),
        ],
      }),
      () => ({ text: "Acrescentei o CI." }),
    ]);
    const conv = conversation(provider);
    await conv.send("mostre a arquitetura");
    await conv.send("e o CI, onde entra na arquitetura?");

    const result = lastToolResult(provider.requests[3]!);
    expect(result.status, JSON.stringify(result, null, 1)).toBe("completed");
    const snapshot = core.store.snapshot();
    expect(snapshot.diagrams).toHaveLength(1);
    const diagram = snapshot.diagrams[0]!;
    expect(diagram.nodes.map((n) => n.id)).toEqual(["nd_frontend", "nd_api", "nd_banco", expect.stringMatching(/^nd_ci_[0-9a-f]{4}$/)]);
    expect(diagram.caption).toBe("Agora com o CI do GitHub.");
    // O ponto de ".github" faz parte do nome: o caminho existe e o CI fica verificado, com a relação vista.
    const ciEdge = diagram.edges.find((e) => e.sourceNodeId.startsWith("nd_ci"))!;
    expect(snapshot.semantic.relations.find((r) => r.id === ciEdge.semanticRelationId)!.status).toBe("verified");
  });

  it("só a legenda mudou: o diagrama ganha a legenda nova e cabe nela", async () => {
    const provider = new FakeProvider([
      () => ({ toolCalls: [call("show_diagram", overview)] }),
      () => ({ text: "Pronto." }),
      () => ({ toolCalls: [call("show_diagram", { ...overview, caption: "Legenda revista, bem mais longa ".repeat(8).trim() })] }),
      () => ({ text: "Ajustei a legenda." }),
    ]);
    const conv = conversation(provider);
    await conv.send("mostre a arquitetura");
    const before = core.store.snapshot().canvas.objects.find((o) => o.id === "dgm_minhaapp_overview")!.size.height;
    await conv.send("explique de novo a arquitetura");
    const result = lastToolResult(provider.requests[3]!);
    expect(result.steps.map((s: { operation: string }) => s.operation)).toEqual(["diagram.apply_patch", "navigation.frame"]);
    const snapshot = core.store.snapshot();
    expect(snapshot.diagrams[0]!.caption).toMatch(/^Legenda revista/);
    expect(snapshot.canvas.objects.find((o) => o.id === "dgm_minhaapp_overview")!.size.height).toBeGreaterThan(before);
  });

  it("caminho que não existe vira suposição, com aviso ao modelo", async () => {
    const provider = new FakeProvider([
      () => ({
        toolCalls: [
          call("show_diagram", {
            diagramId: "dgm_minhaapp_backend",
            title: "Backend",
            kind: "flow",
            caption: "Fluxo do backend.",
            nodes: [{ id: "worker", label: "Worker", path: "backend/worker" }],
          }),
        ],
      }),
      () => ({ text: "Desenhei o fluxo." }),
    ]);
    await conversation(provider).send("como funciona o backend?");
    const result = lastToolResult(provider.requests[1]!);
    expect(result.status).toBe("completed");
    expect(result.nodes.nd_worker.knowledge).toBe("inferred");
    expect(result.notes.join(" ")).toContain("backend/worker");
  });

  it("explicação respondida só com texto: o app pede o diagrama uma vez", async () => {
    const provider = new FakeProvider([
      () => ({ text: "É uma app com frontend e API." }),
      () => ({ toolCalls: [call("show_diagram", overview)] }),
      () => ({ text: "O Frontend chama a API." }),
    ]);
    const conv = conversation(provider);
    await conv.send("explique o projeto");

    expect(provider.requests).toHaveLength(3);
    const nudge = provider.requests[1]!.messages.at(-1)!;
    expect(nudge.role === "user" && nudge.text).toBe(VISUAL_NUDGE);
    const answers = conv.view().entries.filter((e) => e.kind === "assistant");
    expect(answers).toEqual([expect.objectContaining({ text: "O Frontend chama a API.", diagramIds: ["dgm_minhaapp_overview"] })]);
  });

  it("se o modelo insiste em texto, não pede de novo e mostra o texto", async () => {
    const provider = new FakeProvider([() => ({ text: "Primeira." }), () => ({ text: "Só texto mesmo." })]);
    const conv = conversation(provider);
    await conv.send("explique o projeto");
    expect(provider.requests).toHaveLength(2);
    expect(conv.view().entries.filter((e) => e.kind === "assistant").map((e) => e.kind === "assistant" && e.text)).toEqual(["Só texto mesmo."]);
  });

  it("pergunta pontual é uma linha de texto, sem cobrança de diagrama", async () => {
    const provider = new FakeProvider([() => ({ text: "Node 22, segundo o package.json." })]);
    const conv = conversation(provider);
    await conv.send("qual a versão do node?");
    expect(provider.requests).toHaveLength(1);
    const answer = conv.view().entries.at(-1)!;
    expect(answer).toMatchObject({ kind: "assistant", text: "Node 22, segundo o package.json." });
    expect(answer.kind === "assistant" && answer.diagramIds).toBeUndefined();
  });
});

describe("Pedido de explicação", () => {
  it.each([
    "me explique a funcionalidade do repositório pet clinic",
    "Explica o projeto",
    "como funciona o checkout?",
    "mostre a arquitetura",
    "qual é o fluxo de cadastro de pets?",
    "quero entender o back-end",
    "o que faz este projeto?",
    "Explain this repo",
  ])("'%s' pede diagrama", (text) => expect(asksForExplanation(text)).toBe(true));

  it.each(["qual a versão do Java?", "renomeie o arquivo README", "crie uma pasta api", "mostre o arquivo pom.xml", "apague o diagrama antigo", "obrigado"])("'%s' não pede", (text) =>
    expect(asksForExplanation(text)).toBe(false),
  );
});

describe("slug", () => {
  it("gera ids legíveis e válidos", () => {
    expect(slug("Visão Geral do Pet-Clinic")).toBe("visao_geral_do_pet_clinic");
    expect(slug("nd_owner")).toBe("owner");
    expect(slug("DB")).toMatch(/^db_[0-9a-f]{4}$/);
  });
});
