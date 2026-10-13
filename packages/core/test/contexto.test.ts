// Motor de contexto na conversa (docs/funcionalidades/08-gestao-de-contexto.md): o pedido vai com o assunto
// e um mapa enxuto, o foco vai para o assunto, a dúvida que muda o foco vira pergunta rápida e a suposição
// pode ser trocada.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANTHROPIC_MODELS, type Completion, type CompletionRequest, type LlmProvider } from "@open-semantic/llm";

import { Conversation, createCore, type ChatEntry, type ConversationView, type Core } from "../src/index.js";

class FakeProvider implements LlmProvider {
  readonly id = "fake";
  readonly label = "Falso";
  readonly models = ANTHROPIC_MODELS;
  readonly defaultModel = "claude-haiku-5-5";
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly steps: ((request: CompletionRequest) => Partial<Completion>)[]) {}
  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const partial = this.steps.shift()?.(request) ?? { text: "ok" };
    return {
      text: "",
      toolCalls: [],
      stop: partial.toolCalls?.length ? "tool_use" : "end",
      usage: { inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...partial,
    };
  }
}

const agent = { kind: "agent" as const, id: "claude" };
const user = { kind: "user" as const, id: "arthur" };
let core: Core;
let dirs: string[] = [];
let views: ConversationView[];
let seq = 0;

const ok = async (operation: string, args: Record<string, unknown>, actor: typeof agent | typeof user = agent) => {
  const result = await core.dispatcher.dispatch({ operationId: `act_ctx_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor } });
  expect(result.status, `${operation}: ${JSON.stringify(result.error)}`).toBe("succeeded");
  return result;
};

function conversation(provider: LlmProvider) {
  return new Conversation({
    provider: () => provider,
    settings: () => ({ model: "claude-haiku-5-5", maxCostPerRequestUsd: 1 }),
    dispatcher: core.dispatcher,
    agent: core.agent,
    snapshot: () => core.store.snapshot(),
    onChange: (v) => views.push(v),
  });
}

const firstUserText = (provider: FakeProvider, call = 0) => {
  const messages = provider.requests[call]!.messages;
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last && last.role === "user" ? last.text : "";
};
const choices = (conv: Conversation) => conv.view().entries.filter((e): e is Extract<ChatEntry, { kind: "choice" }> => e.kind === "choice");
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
};

beforeEach(async () => {
  views = [];
  const workspaceDir = await mkdtemp(join(tmpdir(), "os-ws-"));
  const banco = await mkdtemp(join(tmpdir(), "banco-"));
  const outro = await mkdtemp(join(tmpdir(), "relatorios-"));
  dirs = [workspaceDir, banco, outro];
  core = await createCore({ workspaceDir, debounceMs: 5, animationMs: 0 });
  await ok("workspace.add_project", { projectId: "prj_relatorios", name: "relatorios", rootPath: outro }, user);
  await ok("workspace.add_project", { projectId: "prj_banco", name: "banco-digital", rootPath: banco }, user);
  await ok("semantic.upsert_inference", {
    entities: [
      { id: "sem_portal", kind: "application", name: "Portal do cliente", aliases: ["portal"], attributes: { role: "frontend" }, projectId: "prj_banco" },
      { id: "sem_mobile", kind: "application", name: "App mobile", attributes: { role: "frontend" }, projectId: "prj_banco" },
      { id: "sem_contas", kind: "service", name: "api-contas", projectId: "prj_banco" },
      { id: "sem_cartoes", kind: "service", name: "api-cartoes", projectId: "prj_banco" },
      { id: "sem_relatorio_mensal", kind: "module", name: "Relatório mensal", projectId: "prj_relatorios" },
    ],
    relations: [
      { id: "rel_portal_contas", type: "communicates_with", sourceId: "sem_portal", targetId: "sem_contas" },
      { id: "rel_portal_cartoes", type: "communicates_with", sourceId: "sem_portal", targetId: "sem_cartoes" },
      { id: "rel_mobile_contas", type: "communicates_with", sourceId: "sem_mobile", targetId: "sem_contas" },
    ],
    confidence: 0.8,
    rationale: "Desenho combinado com o time.",
  });
  await ok("diagram.create", {
    diagramId: "dgm_cartao",
    title: "Validação do cartão",
    kind: "sequence",
    projectId: "prj_banco",
    anchorIds: ["sem_cartoes"],
    nodes: [
      { id: "nd_cartao_portal", label: "Portal", kind: "actor", semanticEntityId: "sem_portal" },
      { id: "nd_cartao_api", label: "api-cartoes", kind: "service", semanticEntityId: "sem_cartoes" },
    ],
    edges: [{ id: "edg_cartao_valida", sourceNodeId: "nd_cartao_portal", targetNodeId: "nd_cartao_api", label: "valida cartão" }],
    layout: { algorithm: "layered", direction: "LR" },
  });
});

afterEach(async () => {
  await core.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("motor de contexto na conversa", () => {
  it("o pedido leva o assunto e um mapa enxuto, e o foco vai para o diagrama do assunto", async () => {
    const provider = new FakeProvider([() => ({ text: "A validação passa pela api-cartoes." })]);
    const conv = conversation(provider);
    await conv.send("Como o portal valida o cartão?");

    const text = firstUserText(provider);
    expect(text).toContain("<workspace>");
    expect(text).toContain('"activeProjectId":"prj_banco"');
    expect(text).toMatch(/Assunto principal[\s\S]*api-cartoes/);
    expect(text.indexOf("Relatório mensal")).toBeGreaterThan(text.indexOf("Assunto principal"));
    expect(choices(conv)).toEqual([]);

    const focus = core.store.read().navigation.focus;
    expect(focus.targetIds).toContain("dgm_cartao");
    expect(focus.highlightIds).toEqual(expect.arrayContaining(["nd_cartao_api"]));
  });

  it("pergunta rápido quando a dúvida muda o foco, e o pedido só vai ao modelo com a resposta", async () => {
    const provider = new FakeProvider([() => ({ text: "Fala via REST." }), () => ({ text: "Pela api-contas." })]);
    const conv = conversation(provider);
    const sent = conv.send("Como o portal fala com o back-end?");
    await until(() => conv.view().status === "waiting_user");
    expect(provider.requests).toHaveLength(0);
    const [question] = choices(conv);
    expect(question!.mode).toBe("question");
    expect(question!.text).toBe("De qual back-end você está falando?");
    expect(question!.options.map((o) => o.ref).sort()).toEqual(["sem_cartoes", "sem_contas"]);

    conv.choose(question!.id, "sem_cartoes");
    await sent;
    expect(provider.requests).toHaveLength(1);
    expect(firstUserText(provider)).toMatch(/Assunto principal[\s\S]*api-cartoes/);
    expect(choices(conv)[0]!.chosen).toBe("sem_cartoes");
    expect(conv.view().status).toBe("idle");

    // A resposta vale para aquele pedido, não vira regra: o app mobile só fala com a api-contas.
    await conv.send("Como o app mobile fala com o back-end?");
    expect(choices(conv).at(-1)).toMatchObject({ mode: "assumption", chosen: "sem_contas" });
  });

  it("parar na pergunta não chama o modelo", async () => {
    const provider = new FakeProvider([]);
    const conv = conversation(provider);
    const sent = conv.send("Como o portal fala com o back-end?");
    await until(() => conv.view().status === "waiting_user");
    conv.stop();
    await sent;
    expect(provider.requests).toHaveLength(0);
    expect(conv.view().status).toBe("idle");
  });

  it("supõe quando só um back-end está ligado ao front, e a suposição pode ser trocada", async () => {
    const provider = new FakeProvider([() => ({ text: "Pela api-contas." }), () => ({ text: "E pela api-cartoes." })]);
    const conv = conversation(provider);
    await conv.send("Como o app mobile fala com o back-end?");
    expect(provider.requests).toHaveLength(1);
    const [assumption] = choices(conv);
    expect(assumption).toMatchObject({ mode: "assumption", chosen: "sem_contas", text: "Supus que back-end é api-contas (banco-digital)." });

    conv.choose(assumption!.id, "sem_cartoes");
    expect(choices(conv)[0]).toMatchObject({ chosen: "sem_cartoes", text: "Supus que back-end é api-cartoes (banco-digital)." });
    // A troca vira o assunto mais recente: o próximo pedido parte dela.
    await conv.send("E o back-end valida o quê?");
    expect(firstUserText(provider, 1)).toMatch(/Assunto principal[\s\S]*api-cartoes/);
  });

  it("o modelo pode buscar no workspace", async () => {
    const provider = new FakeProvider([
      () => ({ toolCalls: [{ id: "tu_busca", name: "search_workspace", input: { query: "relatório mensal" } }] }),
      () => ({ text: "Achei." }),
    ]);
    const conv = conversation(provider);
    await conv.send("O que temos sobre relatórios?");
    const tool = provider.requests[1]!.messages.at(-1)!;
    expect(tool.role).toBe("tool");
    const parsed = JSON.parse(tool.role === "tool" ? tool.results[0]!.content : "{}");
    expect(parsed.results[0].ref).toBe("sem_relatorio_mensal");
  });
});
