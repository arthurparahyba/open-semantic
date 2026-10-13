import { describe, expect, it, vi } from "vitest";

import { BatchExecutor, Dispatcher, OperationError, type BatchPlan, type OperationHandler } from "../src/index.js";

const agent = { kind: "agent" as const, id: "orchestrator" };
const auth = { actor: agent };

/** Mundo de brinquedo: diretórios e regiões, com um handler que falha de propósito. */
function setup() {
  const dirs = new Map<string, string>();
  const regions = new Map<string, { title: string; dir?: string }>();
  const calls: string[] = [];
  const handlers: OperationHandler[] = [
    {
      operation: "project.create_dir",
      argumentsSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      handle(args) {
        calls.push(`create_dir:${args.path}`);
        const id = `art_${(args.path as string).replace(/\W/g, "")}_dir`;
        const existed = dirs.has(id);
        dirs.set(id, args.path as string);
        return { output: { artifacts: [{ id, path: args.path }] }, changes: [{ id, change: existed ? "unchanged" : "created" }] };
      },
    },
    {
      operation: "region.create",
      argumentsSchema: {
        type: "object",
        required: ["regionId", "title"],
        properties: {
          regionId: { $ref: "https://schemas.open-semantic.invalid/v0.2/common.schema.json#/$defs/RegionId" },
          title: { type: "string", minLength: 1 },
          dirRef: { $ref: "https://schemas.open-semantic.invalid/v0.2/common.schema.json#/$defs/ArtifactId" },
        },
        additionalProperties: false,
      },
      handle(args) {
        calls.push(`region:${args.regionId}`);
        regions.set(args.regionId as string, { title: args.title as string, ...(args.dirRef ? { dir: args.dirRef as string } : {}) });
        return { output: { regionId: args.regionId }, changes: [{ id: args.regionId as string, change: "created" }] };
      },
    },
    {
      operation: "mod.delete",
      argumentsSchema: { type: "object", required: ["modId"], properties: { modId: { type: "string" } } },
      handle(args) {
        calls.push(`delete:${args.modId}`);
        return { changes: [{ id: args.modId as string, change: "deleted" }] };
      },
    },
    {
      operation: "semantic.upsert_inference",
      handle() {
        calls.push("boom");
        throw new OperationError("INTERNAL", "falha de propósito");
      },
    },
  ];
  const dispatcher = new Dispatcher({
    policy: (request) =>
      request.operation === "mod.delete"
        ? { decision: "confirm", risk: "medium", summary: "Remover um mod do canvas." }
        : { decision: "allow" },
  });
  for (const h of handlers) dispatcher.register(h);
  const events: string[] = [];
  const executor = new BatchExecutor({ dispatcher, onEvent: (e) => events.push(String(e.payload?.status)) });
  return { executor, dispatcher, calls, regions, events };
}

const step = (stepId: string, operationId: string, operation: string, args: Record<string, unknown>, dependsOn?: string[]) => ({
  stepId,
  ...(dependsOn ? { dependsOn } : {}),
  request: { operationId, operation, arguments: args, authorization: { ...auth } },
});

function plan(steps: BatchPlan["steps"], policy: BatchPlan["policy"] = {}): BatchPlan {
  return { batchId: "bat_teste", turnId: "turn_0001", intent: "teste", policy, steps };
}

describe("BatchExecutor", () => {
  it("resolve $bind com a saída do passo anterior e executa em ordem topológica", async () => {
    const { executor, calls, regions, events } = setup();
    const result = await executor.run(
      plan([
        step("region", "act_b_002", "region.create", { regionId: "rgn_backend", title: "Backend", dirRef: { $bind: { step: "mk", pointer: "/output/artifacts/0/id" } } }, ["mk"]),
        step("mk", "act_b_001", "project.create_dir", { path: "backend" }),
      ]),
    );
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["create_dir:backend", "region:rgn_backend"]);
    expect(regions.get("rgn_backend")).toEqual({ title: "Backend", dir: "art_backend_dir" });
    expect(events).toEqual(["validating", "running", "completed"]);
  });

  it("rejeita um lote com ciclo antes de executar qualquer passo", async () => {
    const { executor, calls } = setup();
    const result = await executor.run(
      plan([
        step("a", "act_c_001", "project.create_dir", { path: "a" }, ["b"]),
        step("b", "act_c_002", "project.create_dir", { path: "b" }, ["a"]),
        step("c", "act_c_003", "project.create_dir", { path: "c" }),
      ]),
    );
    expect(result.status).toBe("rejected");
    expect(result.steps.a?.error?.message).toMatch(/Ciclo/);
    expect(calls).toEqual([]);
  });

  it("rejeita $bind de um passo do qual não depende e dependência inexistente", async () => {
    const { executor, calls } = setup();
    const bind = await executor.run(
      plan([
        step("mk", "act_d_001", "project.create_dir", { path: "x" }),
        step("region", "act_d_002", "region.create", { regionId: "rgn_x01", title: "X", dirRef: { $bind: { step: "mk", pointer: "/output/artifacts/0/id" } } }),
      ]),
    );
    expect(bind.status).toBe("rejected");
    expect(bind.steps.region?.error?.details).toEqual({ binding: "mk" });
    const missing = await executor.run(plan([step("a", "act_d_003", "project.create_dir", { path: "a" }, ["fantasma"])]));
    expect(missing.status).toBe("rejected");
    expect(calls).toEqual([]);
  });

  it("validateFirst: um passo inválido rejeita o lote sem efeitos (E1)", async () => {
    const { executor, calls } = setup();
    const result = await executor.run(
      plan([
        step("ok", "act_e_001", "project.create_dir", { path: "a" }),
        step("ruim", "act_e_002", "region.create", { regionId: "regiao-sem-prefixo", title: "X" }),
      ]),
    );
    expect(result.status).toBe("rejected");
    expect(result.steps.ruim).toMatchObject({ status: "rejected", error: { code: "INVALID_ARGUMENTS", argumentPath: "/regionId" } });
    expect(result.steps.ok).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("skip_dependents: dependentes da falha viram skipped e os independentes rodam", async () => {
    const { executor, calls } = setup();
    const result = await executor.run(
      plan([
        step("infer", "act_f_001", "semantic.upsert_inference", {}),
        step("depois", "act_f_002", "region.create", { regionId: "rgn_dep", title: "Dep" }, ["infer"]),
        step("indep", "act_f_003", "project.create_dir", { path: "livre" }),
      ]),
    );
    expect(result.status).toBe("partially_completed");
    expect(result.steps.infer?.status).toBe("failed");
    expect(result.steps.depois).toMatchObject({ status: "skipped", error: { code: "DEPENDENCY_FAILED" } });
    expect(result.steps.indep?.status).toBe("succeeded");
    expect(calls).toEqual(["boom", "create_dir:livre"]);
  });

  it("abort_batch: depois de uma falha os passos restantes viram cancelled", async () => {
    const { executor, calls } = setup();
    const result = await executor.run(
      plan(
        [step("infer", "act_g_001", "semantic.upsert_inference", {}), step("indep", "act_g_002", "project.create_dir", { path: "livre" })],
        { onStepFailure: "abort_batch" },
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.steps.indep).toMatchObject({ status: "cancelled", error: { code: "CANCELLED" } });
    expect(calls).toEqual(["boom"]);
  });

  it("pede uma única confirmação antes de executar e só executa com o token (E5)", async () => {
    const { executor, calls } = setup();
    const p = plan([
      step("mk", "act_h_001", "project.create_dir", { path: "a" }),
      step("del1", "act_h_002", "mod.delete", { modId: "mod_um1" }),
      step("del2", "act_h_003", "mod.delete", { modId: "mod_dois" }),
    ]);
    const waiting = await executor.run(p);
    expect(waiting.status).toBe("awaiting_confirmation");
    expect(waiting.pendingConfirmations).toEqual(["del1", "del2"]);
    expect(calls).toEqual([]);
    const token = waiting.steps.del1!.confirmation!.token;
    expect(waiting.steps.del2!.confirmation!.token).toBe(token);

    const wrong = structuredClone(p);
    for (const s of wrong.steps) if (s.request.operation === "mod.delete") s.request.authorization.confirmationToken = "outro";
    expect((await executor.run(wrong)).status).toBe("rejected");
    expect(calls).toEqual([]);

    const approved = structuredClone(p);
    for (const s of approved.steps) if (s.request.operation === "mod.delete") s.request.authorization.confirmationToken = token;
    const done = await executor.run(approved);
    expect(done.status).toBe("completed");
    expect(calls).toEqual(["create_dir:a", "delete:mod_um1", "delete:mod_dois"]);

    // Token é de uso único.
    const again = structuredClone(approved);
    again.batchId = "bat_teste2";
    for (const [i, s] of again.steps.entries()) s.request.operationId = `act_h_10${i}`;
    expect((await executor.run(again)).status).toBe("rejected");
  });

  it("recusar a confirmação cancela o lote sem executar nada", async () => {
    const { executor, calls } = setup();
    const p = plan([step("del", "act_i_001", "mod.delete", { modId: "mod_um1" }), step("mk", "act_i_002", "project.create_dir", { path: "a" })]);
    const waiting = await executor.run(p);
    const declined = executor.decline(waiting.steps.del!.confirmation!.token, p);
    expect(declined.status).toBe("cancelled");
    expect(declined.steps.del?.error?.code).toBe("CONFIRMATION_DECLINED");
    expect(calls).toEqual([]);
  });

  it("reenviar o mesmo lote não executa de novo: cada passo volta replayed (E3)", async () => {
    const { executor, calls } = setup();
    const p = plan([
      step("mk", "act_j_001", "project.create_dir", { path: "backend" }),
      step("region", "act_j_002", "region.create", { regionId: "rgn_backend", title: "Backend", dirRef: { $bind: { step: "mk", pointer: "/output/artifacts/0/id" } } }, ["mk"]),
    ]);
    await executor.run(p);
    const second = await executor.run(p);
    expect(second.status).toBe("completed");
    expect(second.steps.mk?.replayed).toBe(true);
    expect(second.steps.region?.replayed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("um $bind que não existe no resultado rejeita o passo e pula os dependentes", async () => {
    const { executor } = setup();
    const result = await executor.run(
      plan([
        step("mk", "act_k_001", "project.create_dir", { path: "a" }),
        step("region", "act_k_002", "region.create", { regionId: "rgn_a01", title: "A", dirRef: { $bind: { step: "mk", pointer: "/output/nada" } } }, ["mk"]),
        step("depois", "act_k_003", "project.create_dir", { path: "b" }, ["region"]),
      ]),
    );
    expect(result.status).toBe("partially_completed");
    expect(result.steps.region).toMatchObject({ status: "rejected", error: { argumentPath: "/dirRef", details: { binding: { step: "mk" } } } });
    expect(result.steps.depois?.status).toBe("skipped");
  });

  it("um lote fora do contrato lança INVALID_ARGUMENTS", async () => {
    const { executor } = setup();
    await expect(executor.run({ batchId: "bat_x01", intent: "x", policy: {}, steps: [] })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("cancelar durante a execução cancela os passos pendentes", async () => {
    const { executor, calls } = setup();
    const onProgress = vi.fn(() => executor.cancel("bat_teste"));
    const result = await executor.run(
      plan([step("a", "act_l_001", "project.create_dir", { path: "a" }), step("b", "act_l_002", "project.create_dir", { path: "b" })]),
      { onProgress },
    );
    expect(result.status).toBe("cancelled");
    expect(result.steps.b?.status).toBe("cancelled");
    expect(calls).toEqual(["create_dir:a"]);
  });
});
