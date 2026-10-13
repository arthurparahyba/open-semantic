import { describe, expect, it, vi } from "vitest";

import {
  Dispatcher,
  MemoryActionLog,
  MemoryIdempotencyStore,
  OperationError,
  sameValue,
  type AuthorizationPolicy,
  type DomainEvent,
  type OperationHandler,
} from "../src/index.js";

const agent = { kind: "agent" as const, id: "orchestrator" };

function request(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "act_test_001",
    operation: "region.create",
    arguments: { regionId: "rgn_backend", title: "Backend" },
    authorization: { actor: agent },
    ...overrides,
  };
}

/** Handler de teste: cria regiões num Map, com schema de argumentos que cita os contratos. */
function regionHandler(store = new Map<string, string>()) {
  const handle = vi.fn((args: Record<string, unknown>) => {
    const id = args.regionId as string;
    const existed = store.get(id) === args.title;
    store.set(id, args.title as string);
    return { output: { regionId: id }, changes: [{ id, change: existed ? ("unchanged" as const) : ("created" as const) }] };
  });
  const handler: OperationHandler = {
    operation: "region.create",
    argumentsSchema: {
      type: "object",
      required: ["regionId", "title"],
      properties: {
        regionId: { $ref: "https://schemas.open-semantic.invalid/v0.2/common.schema.json#/$defs/RegionId" },
        title: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    handle,
  };
  return { handler, handle, store };
}

function setup(options: ConstructorParameters<typeof Dispatcher>[0] = {}) {
  const log = new MemoryActionLog();
  const events: DomainEvent[] = [];
  const dispatcher = new Dispatcher({ actionLog: log, onEvent: (e) => events.push(e), ...options });
  const region = regionHandler();
  dispatcher.register(region.handler);
  return { dispatcher, log, events, ...region };
}

describe("Dispatcher · validação (E1)", () => {
  it("rejeita requisição fora do contrato apontando o campo", async () => {
    const { dispatcher, handle } = setup();
    const result = await dispatcher.dispatch(request({ authorization: {} }));
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ code: "INVALID_ARGUMENTS", details: { requestPath: "/authorization" } });
    expect(result.error?.argumentPath).toBeUndefined();
    expect(handle).not.toHaveBeenCalled();
  });

  it("argumentPath é relativo a arguments em todas as etapas (B5)", async () => {
    const { dispatcher } = setup();
    const notObject = await dispatcher.dispatch(request({ arguments: [] }));
    expect(notObject.error).toMatchObject({ code: "INVALID_ARGUMENTS", argumentPath: "/" });

    const bad = request({ arguments: { regionId: "backend", title: "Backend" } });
    expect((await dispatcher.inspect(bad)).error).toMatchObject({ code: "INVALID_ARGUMENTS", argumentPath: "/regionId" });
    expect((await dispatcher.dispatch(bad)).error).toMatchObject({ code: "INVALID_ARGUMENTS", argumentPath: "/regionId" });
  });

  it("gera um operationId válido quando a requisição não tem um", async () => {
    const { dispatcher } = setup();
    const result = await dispatcher.dispatch({ operation: "region.create" });
    expect(result.status).toBe("rejected");
    expect(result.operationId).toMatch(/^act_/);
  });

  it("rejeita operação desconhecida", async () => {
    const { dispatcher } = setup();
    const result = await dispatcher.dispatch(request({ operation: "mod.create" }));
    expect(result.error?.code).toBe("UNKNOWN_OPERATION");
    expect(result.error?.details).toEqual({ known: ["region.create"] });
  });

  it("rejeita argumentos inválidos com o caminho exato", async () => {
    const { dispatcher, handle, log } = setup();
    const result = await dispatcher.dispatch(request({ arguments: { regionId: "backend", title: "Backend" } }));
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ code: "INVALID_ARGUMENTS", argumentPath: "/regionId" });
    expect(handle).not.toHaveBeenCalled();
    expect(log.records[0]).toMatchObject({ id: "act_test_001", status: "rejected" });
  });

  it("rejeita $bind não resolvido fora de um lote", async () => {
    const { dispatcher } = setup();
    const result = await dispatcher.dispatch(
      request({ arguments: { regionId: { $bind: { step: "a", pointer: "/output/id" } }, title: "X" } }),
    );
    expect(result.error?.code).toBe("INVALID_ARGUMENTS");
    expect(result.error?.message).toMatch(/\$bind/);
  });

  it("rejeita quando check() do handler lança", async () => {
    const { dispatcher } = setup();
    dispatcher.register({
      operation: "mod.close",
      check: () => {
        throw new OperationError("TARGET_NOT_FOUND", "mod inexistente", { targetId: "mod_nope" });
      },
      handle: () => ({ changes: [] }),
    });
    const result = await dispatcher.dispatch(request({ operation: "mod.close", arguments: {} }));
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ code: "TARGET_NOT_FOUND", targetId: "mod_nope" });
  });
});

describe("Dispatcher · execução e histórico (E2, E4)", () => {
  it("devolve o resultado efetivo, registra a ação e publica evento", async () => {
    const { dispatcher, log, events } = setup();
    const result = await dispatcher.dispatch(request({ turnId: "turn_0001" }));
    expect(result).toMatchObject({
      status: "succeeded",
      output: { regionId: "rgn_backend" },
      changes: [{ id: "rgn_backend", change: "created" }],
    });
    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({
      id: "act_test_001",
      operation: "region.create",
      actor: agent,
      turnId: "turn_0001",
      status: "succeeded",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "operation.completed", operationId: "act_test_001" });
    expect(result.eventIds).toEqual([events[0]!.eventId]);
  });

  it("falha de execução vira 'failed' com erro real, sem simular sucesso", async () => {
    const { dispatcher } = setup();
    dispatcher.register({
      operation: "project.read_file",
      handle: () => {
        throw new OperationError("TARGET_NOT_FOUND", "arquivo sumiu", { retryable: true });
      },
    });
    dispatcher.register({
      operation: "project.stat",
      handle: () => {
        throw new TypeError("boom");
      },
    });
    const a = await dispatcher.dispatch(request({ operationId: "act_r01", operation: "project.read_file", arguments: {} }));
    expect(a).toMatchObject({ status: "failed", error: { code: "TARGET_NOT_FOUND", retryable: true } });
    const b = await dispatcher.dispatch(request({ operationId: "act_r02", operation: "project.stat", arguments: {} }));
    expect(b).toMatchObject({ status: "failed", error: { code: "INTERNAL", message: "boom" } });
  });

  it("aplica redact antes de gravar no histórico", async () => {
    const { dispatcher, log } = setup();
    dispatcher.register({
      operation: "project.write_file",
      redact: (args) => ({ ...args, content: "[omitido]" }),
      handle: () => ({ changes: [] }),
    });
    await dispatcher.dispatch(
      request({ operation: "project.write_file", arguments: { path: "a.txt", content: "segredo" } }),
    );
    expect(log.records[0]?.argumentsRedacted).toEqual({ path: "a.txt", content: "[omitido]" });
  });
});

describe("Dispatcher · idempotência (E3)", () => {
  it("repetir o mesmo operationId não executa de novo", async () => {
    const { dispatcher, handle, store } = setup();
    const first = await dispatcher.dispatch(request());
    const second = await dispatcher.dispatch(request());
    expect(handle).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    expect(second).toMatchObject({ ...first, replayed: true });
  });

  it("entregas simultâneas do mesmo operationId executam uma vez", async () => {
    const { dispatcher, handle } = setup();
    const [a, b] = await Promise.all([dispatcher.dispatch(request()), dispatcher.dispatch(request())]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect([a.replayed ?? false, b.replayed ?? false].sort()).toEqual([false, true]);
  });

  it("ordem das chaves não muda a identidade da requisição", async () => {
    const { dispatcher, handle } = setup();
    await dispatcher.dispatch(request({ arguments: { regionId: "rgn_backend", title: "Backend" } }));
    const again = await dispatcher.dispatch(request({ arguments: { title: "Backend", regionId: "rgn_backend" } }));
    expect(again.replayed).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("mesmo operationId com outros argumentos é recusado", async () => {
    const { dispatcher } = setup();
    await dispatcher.dispatch(request());
    const result = await dispatcher.dispatch(request({ arguments: { regionId: "rgn_backend", title: "Outro" } }));
    expect(result.error?.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("um operationId novo para o mesmo objeto não duplica (handler decide 'unchanged')", async () => {
    const { dispatcher, store } = setup();
    await dispatcher.dispatch(request());
    const result = await dispatcher.dispatch(request({ operationId: "act_test_002" }));
    expect(result.changes).toEqual([{ id: "rgn_backend", change: "unchanged" }]);
    expect(store.size).toBe(1);
  });

  it("uma leitura não guarda a saída: o reenvio consulta de novo, e outros argumentos ainda são recusados (B6)", async () => {
    const { dispatcher } = setup();
    let content = "v1";
    const read = vi.fn(() => ({ output: { content }, changes: [] }));
    dispatcher.register({ operation: "project.read_file", readOnly: true, handle: read });
    const req = request({ operationId: "act_read_01", operation: "project.read_file", arguments: { artifactId: "art_a" } });

    expect((await dispatcher.dispatch(req)).output).toEqual({ content: "v1" });
    expect(dispatcher.recorded("act_read_01")).toBe(false);
    content = "v2";
    const again = await dispatcher.dispatch(req);
    expect(again).toMatchObject({ status: "succeeded", output: { content: "v2" } });
    expect(again.replayed).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);

    const other = await dispatcher.dispatch({ ...req, arguments: { artifactId: "art_b" } });
    expect(other.error?.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("o store em memória guarda só os resultados mais recentes (B6)", () => {
    const store = new MemoryIdempotencyStore(2);
    const entry = { fingerprint: "sha256:x" };
    store.set("act_a01", entry);
    store.set("act_b01", entry);
    store.set("act_a01", entry); // regravar conta como recente
    store.set("act_c01", entry);
    expect(store.get("act_b01")).toBeUndefined();
    expect(store.get("act_a01")).toBe(entry);
    expect(store.get("act_c01")).toBe(entry);
  });

  it("rejeições não ficam gravadas: o mesmo id pode ser tentado de novo quando o estado mudar", async () => {
    let ready = false;
    const { dispatcher } = setup({
      evaluatePrecondition: () => (ready ? { ok: true } : { ok: false, message: "ainda não" }),
    });
    const pre = { preconditions: [{ kind: "exists", targetId: "sem_backend" }] };
    expect((await dispatcher.dispatch(request(pre))).status).toBe("rejected");
    ready = true;
    expect((await dispatcher.dispatch(request(pre))).status).toBe("succeeded");
  });
});

describe("Dispatcher · pré-condições", () => {
  it("sem avaliador configurado, pré-condições são recusadas em vez de ignoradas", async () => {
    const { dispatcher, handle } = setup();
    const result = await dispatcher.dispatch(
      request({ preconditions: [{ kind: "revision_equals", targetId: "rgn_backend", revision: 3 }] }),
    );
    expect(result.error?.code).toBe("PRECONDITION_FAILED");
    expect(handle).not.toHaveBeenCalled();
  });

  it("propaga o código do avaliador (REVISION_CONFLICT)", async () => {
    const { dispatcher } = setup({
      evaluatePrecondition: () => ({ ok: false, code: "REVISION_CONFLICT", message: "revisão 4, esperada 3" }),
    });
    const result = await dispatcher.dispatch(
      request({ preconditions: [{ kind: "revision_equals", targetId: "rgn_backend", revision: 3 }] }),
    );
    expect(result.error).toMatchObject({ code: "REVISION_CONFLICT", retryable: true });
  });
});

describe("Dispatcher · autorização e confirmação (E5)", () => {
  const confirmAll: AuthorizationPolicy = () => ({
    decision: "confirm",
    risk: "medium",
    summary: "Criar a região Backend",
    reversible: true,
  });

  it("não executa antes da confirmação e executa depois", async () => {
    const { dispatcher, handle, log } = setup({ policy: confirmAll });
    const first = await dispatcher.dispatch(request());
    expect(first.status).toBe("confirmation_required");
    expect(first.confirmation).toMatchObject({ risk: "medium", summary: "Criar a região Backend" });
    expect(handle).not.toHaveBeenCalled();
    expect(log.records).toHaveLength(0);

    const token = first.confirmation!.token;
    const second = await dispatcher.dispatch(request({ authorization: { actor: agent, confirmationToken: token } }));
    expect(second.status).toBe("succeeded");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("token só vale uma vez e só para a mesma requisição", async () => {
    const { dispatcher } = setup({ policy: confirmAll });
    const token = (await dispatcher.dispatch(request())).confirmation!.token;
    const other = await dispatcher.dispatch(
      request({
        arguments: { regionId: "rgn_outra", title: "Outra" },
        operationId: "act_test_009",
        authorization: { actor: agent, confirmationToken: token },
      }),
    );
    expect(other.error?.code).toBe("UNAUTHORIZED");

    const ok = await dispatcher.dispatch(request({ authorization: { actor: agent, confirmationToken: token } }));
    expect(ok.status).toBe("succeeded");
    const reuse = await dispatcher.dispatch(
      request({ operationId: "act_test_010", authorization: { actor: agent, confirmationToken: token } }),
    );
    expect(reuse.error?.code).toBe("UNAUTHORIZED");
  });

  it("token expirado é recusado", async () => {
    let now = new Date("2026-10-12T20:00:00Z");
    const { dispatcher, handle } = setup({ policy: confirmAll, now: () => now, confirmationTtlMs: 1000 });
    const token = (await dispatcher.dispatch(request())).confirmation!.token;
    now = new Date("2026-10-12T20:00:05Z");
    const result = await dispatcher.dispatch(request({ authorization: { actor: agent, confirmationToken: token } }));
    expect(result.error?.code).toBe("CONFIRMATION_EXPIRED");
    expect(handle).not.toHaveBeenCalled();
  });

  it("tokens vencidos há mais de um prazo saem quando outro token é emitido (B6)", async () => {
    let now = new Date("2026-10-12T20:00:00Z");
    const { dispatcher } = setup({ policy: confirmAll, now: () => now, confirmationTtlMs: 1000 });
    const old = (await dispatcher.dispatch(request())).confirmation!.token;
    const recent = (await dispatcher.dispatch(request({ operationId: "act_test_002" }))).confirmation!.token;

    now = new Date("2026-10-12T20:00:01.500Z"); // vencidos há meio prazo: continuam guardados
    await dispatcher.dispatch(request({ operationId: "act_test_003" }));
    const expired = await dispatcher.dispatch(request({ operationId: "act_test_002", authorization: { actor: agent, confirmationToken: recent } }));
    expect(expired.error?.code).toBe("CONFIRMATION_EXPIRED");

    now = new Date("2026-10-12T20:00:05Z"); // vencido há mais de um prazo: sai na próxima emissão
    await dispatcher.dispatch(request({ operationId: "act_test_004" }));
    const gone = await dispatcher.dispatch(request({ authorization: { actor: agent, confirmationToken: old } }));
    expect(gone.error?.code).toBe("UNAUTHORIZED");
  });

  it("política pode negar", async () => {
    const { dispatcher } = setup({ policy: () => ({ decision: "deny", reason: "raiz sem permissão de escrita" }) });
    const result = await dispatcher.dispatch(request());
    expect(result.error).toMatchObject({ code: "UNAUTHORIZED", message: "raiz sem permissão de escrita" });
  });

  it("dryRun valida e pede confirmação sem executar", async () => {
    const { dispatcher, handle, log } = setup();
    const result = await dispatcher.dispatch(request({ dryRun: true }));
    expect(result).toMatchObject({ status: "succeeded", output: { dryRun: true }, changes: [] });
    expect(handle).not.toHaveBeenCalled();
    expect(log.records).toHaveLength(0);
  });
});

describe("Dispatcher · registro", () => {
  it("recusa nomes fora do padrão e registros duplicados", () => {
    const { dispatcher, handler } = setup();
    expect(() => dispatcher.register({ ...handler, operation: "foo.bar" })).toThrow();
    expect(() => dispatcher.register(handler)).toThrow(/já registrada/);
  });
});

describe("sameValue", () => {
  it("compara valores JSON sem depender da ordem das chaves; a ordem das listas conta (B8)", () => {
    expect(sameValue({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: 1 }, { a: "1" })).toBe(false);
  });
});
