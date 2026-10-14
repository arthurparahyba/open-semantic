// Fluxo de camadas garantido pelo app (doc 16): especificação sobre a base, implementação filha dela.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANTHROPIC_MODELS, type Completion, type CompletionRequest, type LlmProvider } from "@open-semantic/llm";

import { Conversation, createCore, scriptedPlan, type Core } from "../src/index.js";
import { pendingWork, specSubject, type PreparedLayer } from "../src/conversation/layerFlow.js";
import type { WorkspaceSnapshot } from "@open-semantic/protocol";

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
    const partial = this.steps.shift()?.(request) ?? { text: "Pronto." };
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

const conversation = (provider: LlmProvider, limits?: { maxModelCalls: number }) =>
  new Conversation({
    ...(limits ? { limits } : {}),
    provider: () => provider,
    settings: () => ({ model: "claude-haiku-5-5", maxCostPerRequestUsd: 1 }),
    dispatcher: core.dispatcher,
    agent: core.agent,
    snapshot: () => core.store.snapshot(),
  });

const layers = () => core.store.snapshot().layers ?? [];
const active = () => layers().find((l) => l.id === core.store.snapshot().navigation.activeLayerId);
const lastUserText = (req: CompletionRequest) => {
  const m = req.messages.filter((x) => x.role === "user").at(-1) as { text?: string } | undefined;
  return m?.text ?? "";
};
const toolResult = (req: CompletionRequest) => {
  const tool = [...req.messages].reverse().find((m) => m.role === "tool") as { results: { content: string }[] };
  return JSON.parse(tool.results[0]!.content) as { status: string; error?: string };
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  await writeFile(join(projectDir, "README.md"), "# pet clinic\n");
  core = await createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0 });
  await core.dispatcher.dispatch({
    operationId: "act_fluxo_open",
    operation: "workspace.add_project",
    arguments: { projectId: "prj_petclinic", name: "PetClinic", rootPath: projectDir },
    authorization: { actor: { kind: "user", id: "arthur" } },
  });
  expect((await core.agent.run(scriptedPlan("arquitetura", core.store.snapshot()))).status).toBe("completed");
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir].map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

describe("assunto da especificação", () => {
  it("tira o assunto do pedido, sem os detalhes", () => {
    expect(specSubject("Quero especificar uma funcionalidade nova: cadastro de produtos (pet shop) com nome, preço e estoque.")).toBe("Cadastro de produtos");
    expect(specSubject("quero implementar um crud de vacinas")).toBe("Crud de vacinas");
    expect(specSubject("preciso criar uma funcionalidade de agendamento de consultas para os donos")).toBe("Agendamento de consultas");
  });
});

describe("camadas garantidas pelo app", () => {
  it("o planejamento abre a especificação sobre a base e a implementação vira filha dela", async () => {
    const provider = new FakeProvider([]);
    const conv = conversation(provider);
    await conv.send("Quero especificar uma funcionalidade nova: cadastro de produtos (pet shop) com nome, preço e estoque. Comece pelo processo em BPMN.");
    const spec = active()!;
    expect(spec.name).toBe("Especificação: Cadastro de produtos");
    expect(spec.parentId).toBeUndefined();
    expect(lastUserText(provider.requests[0]!)).toContain(`A camada "Especificação: Cadastro de produtos" (${spec.id}) já está aberta`);
    // O modelo respondeu sem desenhar: o app cobra o bpmn e o wireframe.
    expect(lastUserText(provider.requests[1]!)).toContain("Falta na camada de especificação: o processo em bpmn e o wireframe");

    // O processo que o modelo teria desenhado na especificação.
    const bpmn = core.store.snapshot().diagrams[0]!.id;
    await core.dispatcher.dispatch({
      operationId: "act_fluxo_membro",
      operation: "layer.add_members",
      arguments: { layerId: spec.id, members: [{ id: bpmn }] },
      authorization: { actor: { kind: "user", id: "arthur" } },
    });

    await conv.send("Está bom. Vamos para a implementação.");
    const impl = active()!;
    expect(impl.name).toBe("Implementação: Cadastro de produtos");
    expect(impl.parentId).toBe(spec.id);

    // De novo: reaproveita as mesmas camadas.
    await conv.send("Quero especificar uma funcionalidade nova: cadastro de produtos.");
    expect(active()!.id).toBe(spec.id);
    expect(layers().filter((l) => l.name.startsWith("Especificação"))).toHaveLength(1);
  });

  it("o modelo não abre outra camada nem puxa diagramas de outras camadas", async () => {
    const base = core.store.snapshot().diagrams[0]!.id;
    const provider = new FakeProvider([
      () => ({ toolCalls: [{ id: "tu_1", name: "run_batch", input: { intent: "x", steps: [{ id: "s1", operation: "layer.create", arguments: { layerId: "lyr_outra", name: "Outra", anchors: [base] } }] } }] }),
      (req) => {
        expect(toolResult(req)).toMatchObject({ status: "rejected" });
        return { text: "Ok." };
      },
    ]);
    await conversation(provider).send("quero criar uma funcionalidade de agendamento de consultas");
    expect(layers().map((l) => l.name)).toEqual(["Especificação: Agendamento de consultas"]);
  });
});

describe("o que o app cobra no fim da etapa", () => {
  const dgm = (id: string, kind: string, revision: number, mark?: string) => ({ id, kind, title: id, revision, nodes: [{ id: `nd_${id}`, attributes: mark ? { mark } : {} }], edges: [] });
  const snap = (diagrams: ReturnType<typeof dgm>[]) =>
    ({ diagrams, blocks: [], layers: [{ id: "lyr_spec", name: "Especificação: X", members: diagrams.map((d) => ({ id: d.id })) }] }) as unknown as WorkspaceSnapshot;
  const prepared = (phase: PreparedLayer["phase"]) => ({ layer: { id: "lyr_spec" }, phase, hint: "" }) as unknown as PreparedLayer;
  const before = new Map([["dgm_tela", 1], ["dgm_proc", 1]]);

  it("no ajuste, cobra o processo que ficou para trás e as marcas do que mudou", () => {
    const text = pendingWork(prepared("refine"), before, snap([dgm("dgm_tela", "wireframe", 2), dgm("dgm_proc", "bpmn", 1)]))!;
    expect(text).toContain('"dgm_proc" (dgm_proc) não mudou');
    expect(text).toContain("Marque com mark_diagram");
  });

  it("ajuste completo e marcado não cobra nada", () => {
    expect(pendingWork(prepared("refine"), before, snap([dgm("dgm_tela", "wireframe", 2, "muda"), dgm("dgm_proc", "bpmn", 2, "novo")]))).toBeUndefined();
    expect(pendingWork(prepared("draft"), before, snap([dgm("dgm_tela", "wireframe", 1), dgm("dgm_proc", "bpmn", 1)]))).toBeUndefined();
  });
});

describe("limite de chamadas", () => {
  it("a última chamada vem com o aviso de responder com o que já leu", async () => {
    const provider = new FakeProvider([
      () => ({ toolCalls: [{ id: "tu_1", name: "read_file", input: { paths: ["README.md", "nao-existe.md"] } }] }),
      (req) => {
        const tool = [...req.messages].reverse().find((m) => m.role === "tool") as { results: { content: string }[] };
        const files = JSON.parse(tool.results[0]!.content).files as { path: string; content?: string; error?: string }[];
        expect(files[0]).toMatchObject({ path: "README.md", content: "# pet clinic\n" });
        expect(files[1]!.error).toBeTruthy();
        return { text: "Pronto." };
      },
    ]);
    await conversation(provider, { maxModelCalls: 2 }).send("o que tem no readme?");
    expect(lastUserText(provider.requests[1]!)).toContain("Esta é a última chamada deste pedido");
  });
});
