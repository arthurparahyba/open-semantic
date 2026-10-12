// Laço do agente de IA com um provedor falso: ferramentas, confirmação, limites e honestidade do resultado.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANTHROPIC_MODELS, type ChatMessage, type Completion, type CompletionRequest, type LlmProvider } from "@open-semantic/llm";

import { AGENT_OPERATIONS, Conversation, SYSTEM_PROMPT, createCore, type ConversationView, type Core, type TurnLimits } from "../src/index.js";

type Step = (request: CompletionRequest) => Partial<Completion>;

/** Provedor falso: cada chamada consome o próximo passo do roteiro. Guarda as requisições recebidas. */
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
let views: ConversationView[];

function conversation(provider: LlmProvider | undefined, opts: { maxCost?: number; limits?: Partial<TurnLimits> } = {}) {
  return new Conversation({
    provider: () => provider,
    settings: () => ({ model: "claude-haiku-5-5", maxCostPerRequestUsd: opts.maxCost ?? 1 }),
    dispatcher: core.dispatcher,
    agent: core.agent,
    snapshot: () => core.store.snapshot(),
    onChange: (v) => views.push(v),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
}

const call = (name: string, input: Record<string, unknown>, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ id, name, input });
const lastToolResults = (req: CompletionRequest) => {
  const tool = [...req.messages].reverse().find((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
  return tool!.results.map((r) => ({ ...r, parsed: safeJson(r.content) }));
};
const safeJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** O lote de exemplo do prompt de sistema, com os ids do projeto aberto. Garante que o exemplo continua válido. */
function promptExample() {
  const snapshot = core.store.snapshot();
  const project = snapshot.projects[0]!;
  const json = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('{"intent"'))
    .replaceAll("prj_x", project.id)
    .replaceAll("root_x", project.roots[0].id);
  return JSON.parse(json) as Record<string, unknown>;
}

beforeEach(async () => {
  views = [];
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  await mkdir(join(projectDir, "frontend"));
  await writeFile(join(projectDir, "README.md"), "# minha app\n");
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0 });
  const added = await core.dispatcher.dispatch({
    operationId: "act_conv_open",
    operation: "workspace.add_project",
    arguments: { projectId: "prj_minhaapp", name: "MinhaAplicacao", rootPath: projectDir },
    authorization: { actor: { kind: "user", id: "arthur" } },
  });
  expect(added.status).toBe("succeeded");
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir].map((d) => rm(d, { recursive: true, force: true })));
});

describe("Conversa com o agente de IA", () => {
  it("todas as operações oferecidas ao modelo existem no núcleo", () => {
    for (const operation of AGENT_OPERATIONS) expect(core.dispatcher.operations()).toContain(operation);
  });

  it("lê o projeto, executa o lote de exemplo do prompt e devolve ao modelo o status real de cada passo", async () => {
    const provider = new FakeProvider([
      () => ({ text: "Vou olhar o projeto.", toolCalls: [call("list_dir", { path: "" })] }),
      () => ({ toolCalls: [call("read_file", { path: "README.md" })] }),
      () => ({ toolCalls: [call("run_batch", promptExample())] }),
      () => ({ text: "Criei a pasta backend/ e desenhei a arquitetura." }),
    ]);
    const conv = conversation(provider);
    await conv.send("crie o backend e mostre a arquitetura");

    // O pedido do usuário vai com o resumo do workspace.
    const first = provider.requests[0]!.messages[0]!;
    expect(first.role === "user" && first.text).toContain('"id":"prj_minhaapp"');
    expect(first.role === "user" && first.text).toContain("crie o backend");

    const listed = lastToolResults(provider.requests[1]!)[0]!.parsed;
    expect(listed.entries.map((e: { path: string }) => e.path)).toEqual(["frontend", "README.md"]);
    const read = lastToolResults(provider.requests[2]!)[0]!.parsed;
    expect(read.content).toBe("# minha app\n");
    expect(read.contentHash).toMatch(/^sha256:/);

    const batch = lastToolResults(provider.requests[3]!)[0]!.parsed;
    expect(batch.status, JSON.stringify(batch, null, 1)).toBe("completed");
    expect(batch.steps.every((s: { status: string }) => s.status === "succeeded")).toBe(true);
    expect(batch.summaryShownToUser).toContain("Feito: criar a pasta backend/");
    expect(existsSync(join(projectDir, "backend"))).toBe(true);
    expect(core.store.snapshot().diagrams.map((d) => d.id)).toEqual(["dgm_arch"]);

    // Leituras e mudanças ficam no histórico de ações assinadas pelo agente.
    expect(core.log.records.filter((r) => r.actor.kind === "agent").map((r) => r.operation)).toContain("project.read_file");

    const view = conv.view();
    expect(view.status).toBe("idle");
    expect(view.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "tool", "batch", "assistant"]);
    expect(view.lastRequest!.modelCalls).toBe(4);
    // 4 chamadas × (2000 × 0,10 + 300 × 0,50) / 1e6
    expect(view.costUsd).toBeCloseTo(4 * 0.00035, 8);
  });

  it("um lote inválido volta ao modelo como recusado, sem executar nada", async () => {
    const provider = new FakeProvider([
      () => ({
        toolCalls: [
          call("run_batch", {
            intent: "criar pasta",
            steps: [
              { id: "a", operation: "project.create_dir", arguments: { projectId: "prj_minhaapp", path: "x" } },
              { id: "b", operation: "region.create", arguments: { regionId: "rgn_x", title: "X" } },
            ],
          }),
        ],
      }),
      () => ({ text: "Não consegui." }),
    ]);
    await conversation(provider).send("crie x");
    const result = lastToolResults(provider.requests[1]!)[0]!.parsed;
    expect(result.status).toBe("rejected");
    expect(JSON.stringify(result)).toContain("rootId");
    expect(existsSync(join(projectDir, "x"))).toBe(false);
    expect(core.store.snapshot().canvas.regions).toHaveLength(0);
  });

  it("espera a confirmação do usuário; a recusa chega ao modelo como cancelada", async () => {
    await core.agent.run(promptExampleAsPlan());
    const provider = new FakeProvider([
      () => ({ toolCalls: [call("run_batch", { intent: "Remover o Explorer", steps: [{ id: "rm", operation: "mod.delete", arguments: { modId: "mod_backend_explorer" } }] })] }),
      () => ({ text: "Tudo bem, não removi." }),
    ]);
    const conv = conversation(provider);
    const sending = conv.send("remova o explorer");
    await until(() => conv.view().status === "waiting_user");
    const pending = core.agent.list().find((a) => a.confirmation)!;
    expect(pending.confirmation!.items[0]!.summary).toContain("Remover um mod");

    await core.agent.respond(pending.batchId, false);
    await sending;
    const result = lastToolResults(provider.requests[1]!)[0]!.parsed;
    expect(result.status).toBe("cancelled");
    expect(result.steps[0].status).toBe("cancelled");
    expect(core.store.snapshot().mods.some((m) => m.id === "mod_backend_explorer")).toBe(true);
    expect(conv.view().status).toBe("idle");
  });

  it("parar enquanto espera confirmação recusa o lote e encerra o pedido com o histórico válido", async () => {
    await core.agent.run(promptExampleAsPlan());
    const provider = new FakeProvider([
      () => ({ toolCalls: [call("run_batch", { intent: "Remover", steps: [{ id: "rm", operation: "mod.delete", arguments: { modId: "mod_backend_explorer" } }] })] }),
      () => ({ text: "ok" }),
    ]);
    const conv = conversation(provider);
    const sending = conv.send("remova");
    await until(() => conv.view().status === "waiting_user");
    conv.stop();
    await sending;
    expect(conv.view().status).toBe("idle");
    expect(conv.view().entries.at(-1)).toMatchObject({ kind: "notice", text: "Pedido interrompido." });
    expect(core.store.snapshot().mods.some((m) => m.id === "mod_backend_explorer")).toBe(true);
    expect(provider.requests).toHaveLength(1);
  });

  it("para no limite de chamadas ao modelo e deixa toda chamada de ferramenta respondida", async () => {
    const provider = new FakeProvider(Array.from({ length: 10 }, () => () => ({ toolCalls: [call("get_workspace", {})] })));
    const conv = conversation(provider, { limits: { maxModelCalls: 3 } });
    await conv.send("olhe tudo");
    expect(provider.requests).toHaveLength(3);
    const notice = conv.view().entries.at(-1)!;
    expect(notice).toMatchObject({ kind: "notice", tone: "limit" });
    expect(notice.kind === "notice" && notice.text).toContain("3 chamadas");

    // O próximo pedido envia um histórico aceitável: toda chamada de ferramenta tem resultado.
    provider["steps"].length = 0;
    provider["steps"].push(() => ({ text: "Pronto." }));
    await conv.send("continue");
    assertToolCallsAnswered(provider.requests.at(-1)!.messages);
  });

  it("para no teto de custo por pedido", async () => {
    const provider = new FakeProvider([
      () => ({ toolCalls: [call("get_workspace", {})], usage: { inputTokens: 90_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
      () => ({ text: "não deveria chegar aqui" }),
    ]);
    const conv = conversation(provider, { maxCost: 0.01 });
    await conv.send("analise");
    expect(provider.requests).toHaveLength(1);
    expect(conv.view().entries.at(-1)).toMatchObject({ kind: "notice", tone: "limit" });
    expect(conv.view().lastRequest!.costUsd).toBeCloseTo(0.009 + 0.004, 8);
  });

  it("não executa ferramentas de uma resposta cortada ou recusada", async () => {
    const provider = new FakeProvider([
      () => ({ stop: "max_tokens", toolCalls: [call("run_batch", { intent: "x", steps: [{ id: "a", operation: "project.create_dir", arguments: {} }] })] }),
    ]);
    const conv = conversation(provider);
    await conv.send("crie");
    expect(conv.view().entries.at(-1)).toMatchObject({ kind: "notice", tone: "limit" });
    expect(core.agent.list()).toHaveLength(0);

    provider["steps"].push(() => ({ stop: "refusal", toolCalls: [call("get_workspace", {})] }));
    await conv.send("de novo");
    expect(conv.view().entries.at(-1)).toMatchObject({ kind: "notice", tone: "error" });
    provider["steps"].push(() => ({ text: "ok" }));
    await conv.send("e agora");
    assertToolCallsAnswered(provider.requests.at(-1)!.messages);
  });

  it("sem chave configurada, avisa e não chama nada", async () => {
    const conv = conversation(undefined);
    await conv.send("oi");
    expect(conv.view().entries.map((e) => e.kind)).toEqual(["user", "notice"]);
    expect(conv.view().status).toBe("idle");
  });

  it("um erro do provedor vira aviso e a conversa continua utilizável", async () => {
    const provider = new FakeProvider([
      () => {
        throw new Error("A chave da API foi recusada.");
      },
      () => ({ text: "oi" }),
    ]);
    const conv = conversation(provider);
    await conv.send("oi");
    expect(conv.view().entries.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: "A chave da API foi recusada." });
    await conv.send("oi de novo");
    expect(conv.view().entries.at(-1)).toMatchObject({ kind: "assistant", text: "oi" });
  });

  it("nova conversa zera o histórico e o custo", async () => {
    const provider = new FakeProvider([() => ({ text: "oi" }), () => ({ text: "oi de novo" })]);
    const conv = conversation(provider);
    await conv.send("oi");
    expect(conv.view().costUsd).toBeGreaterThan(0);
    conv.reset();
    expect(conv.view().entries).toHaveLength(0);
    expect(conv.view().costUsd).toBe(0);
    await conv.send("oi");
    expect(provider.requests[1]!.messages).toHaveLength(1);
  });
});

function promptExampleAsPlan() {
  const example = promptExample() as { intent: string; steps: { id: string; operation: string; arguments: Record<string, unknown>; dependsOn?: string[] }[] };
  return {
    batchId: "bat_setup_exemplo",
    intent: example.intent,
    policy: {},
    steps: example.steps.map((s, i) => ({
      stepId: s.id,
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
      request: { operationId: `act_setup_${i}00`, operation: s.operation, arguments: s.arguments, authorization: { actor: { kind: "agent" as const, id: "claude" } } },
    })),
  } as Parameters<Core["agent"]["run"]>[0];
}

function assertToolCallsAnswered(messages: ChatMessage[]) {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.toolCalls.length) return;
    const next = messages[i + 1];
    expect(next?.role).toBe("tool");
    const answered = new Set(next!.role === "tool" ? next!.results.map((r) => r.callId) : []);
    for (const c of m.toolCalls) expect(answered.has(c.id)).toBe(true);
  });
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("tempo esgotado");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Compactação do histórico", () => {
  it("quando o prompt passa do limite, o próximo pedido leva só o que foi pedido, respondido e feito", async () => {
    const big = { inputTokens: 85_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const provider = new FakeProvider([
      () => ({ toolCalls: [call("read_file", { path: "README.md" })] }),
      () => ({ toolCalls: [call("run_batch", promptExample())] }),
      () => ({ text: "Criei o backend.", usage: big }),
      () => ({ text: "Certo." }),
    ]);
    const conv = conversation(provider);
    await conv.send("crie o backend");
    await conv.send("e agora?");

    const messages = provider.requests.at(-1)!.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]).toEqual({ role: "user", text: "crie o backend" });
    const summary = messages[1]!.role === "assistant" ? messages[1]!.text : "";
    expect(summary).toContain("Criei o backend.");
    expect(summary).toContain("Feito: criar a pasta backend/");
    expect(summary).not.toContain("# minha app");
    expect(messages[2]!.role === "user" && messages[2]!.text).toContain("<workspace>");
    expect(conv.view().entries.some((e) => e.kind === "notice" && e.text.includes("resumi os pedidos anteriores"))).toBe(true);
  });

  it("abaixo do limite o histórico vai inteiro (e o cache do provedor continua valendo)", async () => {
    const provider = new FakeProvider([() => ({ toolCalls: [call("get_workspace", {})] }), () => ({ text: "ok" }), () => ({ text: "ok 2" })]);
    const conv = conversation(provider);
    await conv.send("um");
    await conv.send("dois");
    expect(provider.requests.at(-1)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  });
});
