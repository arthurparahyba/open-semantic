import { describe, expect, it } from "vitest";

import { Dispatcher } from "@open-semantic/protocol";
import { WorkspaceStore } from "@open-semantic/workspace-store";

import { semanticHandlers } from "../src/index.js";

const agent = { kind: "agent" as const, id: "orchestrator" };

function setup() {
  const store = WorkspaceStore.create({ id: "ws_teste", name: "Teste" });
  store.transact(() => {
    store.addProject({
      id: "prj_app",
      name: "app",
      location: { kind: "local", rootPath: "/tmp/app" },
      roots: [{ id: "root_app", path: "", capabilities: ["read"] }],
      rootRef: "art_app_root",
      revision: 1,
    });
    store.upsertArtifact({
      id: "art_app_root",
      projectId: "prj_app",
      kind: "directory",
      locator: { rootId: "root_app", path: "" },
      validity: { status: "valid", checkedAt: new Date().toISOString() },
      provenance: { source: "user_statement", actor: { kind: "user", id: "arthur" }, recordedAt: new Date().toISOString() },
    });
  });
  const dispatcher = new Dispatcher();
  for (const h of semanticHandlers({ store })) dispatcher.register(h);
  let seq = 0;
  const op = (operation: string, args: Record<string, unknown>) =>
    dispatcher.dispatch({ operationId: `act_sem_${++seq}00`, operation, arguments: args, authorization: { actor: agent }, turnId: "turn_0001" });
  return { store, op };
}

const observation = {
  entity: { id: "sem_app", kind: "application", name: "App", projectId: "prj_app", artifactIds: ["art_app_root"] },
  evidence: { id: "evd_root01", kind: "directory_listing", artifactId: "art_app_root", summary: "Raiz listada." },
};

describe("Open Semantic (parte do M2)", () => {
  it("observação com evidência vira conhecimento verificado e guarda a evidência", async () => {
    const { store, op } = setup();
    const r = await op("semantic.upsert_observation", observation);
    expect(r.status).toBe("succeeded");
    expect(store.entity("sem_app")).toMatchObject({ status: "verified", provenance: { source: "inspection", evidenceIds: ["evd_root01"] } });
    expect(store.evidence("evd_root01")).toMatchObject({ status: "current", operationId: "act_sem_100" });
  });

  it("observação que aponta para artefato inexistente é rejeitada", async () => {
    const { op } = setup();
    const r = await op("semantic.upsert_observation", { ...observation, evidence: { ...observation.evidence, artifactId: "art_fantasma" } });
    expect(r).toMatchObject({ status: "rejected", error: { code: "REFERENCE_INVALID", argumentPath: "/evidence/artifactId" } });
  });

  it("inferência fica inferida, com confiança e justificativa, e nunca rebaixa o que já é verificado", async () => {
    const { store, op } = setup();
    await op("semantic.upsert_observation", observation);
    const r = await op("semantic.upsert_inference", {
      entities: [
        { id: "sem_app", kind: "application", name: "App" },
        { id: "sem_api", kind: "api", name: "API" },
      ],
      relations: [{ id: "rel_app_api", type: "exposes", sourceId: "sem_app", targetId: "sem_api" }],
      confidence: 0.6,
      rationale: "Palpite.",
    });
    expect(r.status).toBe("succeeded");
    expect(store.entity("sem_app")!.status).toBe("verified");
    expect(store.entity("sem_api")).toMatchObject({ status: "inferred", provenance: { source: "agent_inference", confidence: 0.6, turnId: "turn_0001" } });
    expect(store.relation("rel_app_api")!.status).toBe("inferred");
  });

  it("relação para entidade inexistente é rejeitada", async () => {
    const { op } = setup();
    const r = await op("semantic.upsert_inference", {
      relations: [{ id: "rel_x01", type: "calls", sourceId: "sem_nada", targetId: "sem_outra" }],
      confidence: 0.5,
      rationale: "x",
    });
    expect(r).toMatchObject({ status: "rejected", error: { code: "REFERENCE_INVALID", argumentPath: "/relations/0/sourceId" } });
  });

  it("repetir a mesma observação não cria revisão nova", async () => {
    const { store, op } = setup();
    await op("semantic.upsert_observation", observation);
    const revision = store.revision;
    const again = await op("semantic.upsert_observation", observation);
    expect(again.changes).toEqual([{ id: "sem_app", change: "unchanged", revision: 1 }]);
    expect(store.revision).toBe(revision);
  });

  it("semantic.query encontra por nome e traz as relações", async () => {
    const { op } = setup();
    await op("semantic.upsert_observation", observation);
    const r = await op("semantic.query", { text: "ap" });
    expect((r.output as { entities: { id: string }[] }).entities.map((e) => e.id)).toEqual(["sem_app"]);
  });
});
