// Eventos de domínio e revisão do documento pelo núcleo (A2): cada operação publica os eventos do que mudou,
// com o operationId dela, e mexer na câmera não muda a revisão do documento.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contractValidator, type DomainEvent } from "@open-semantic/protocol";
import type { Commit } from "@open-semantic/workspace-store";

import { CLAUDE_AGENT, createCore, type Core } from "../src/index.js";

const validEvent = contractValidator("operation.schema.json#/$defs/DomainEvent");
const user = { kind: "user" as const, id: "arthur" };

let dataDir: string;
let projectDir: string;
let core: Core;
let events: DomainEvent[];
let commits: Commit[];

const open = () =>
  createCore({ workspaceDir: dataDir, debounceMs: 5, animationMs: 0, onEvent: (e) => events.push(e), onCommit: (c) => commits.push(c) });

const op = (operationId: string, operation: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  core.dispatcher.dispatch({ operationId, operation, arguments: args, authorization: { actor: user }, ...extra });

/** Os eventos que uma ação publicou, como "tipo sujeito". */
async function published(action: () => Promise<unknown>) {
  const from = events.length;
  await action();
  return events.slice(from);
}

beforeEach(async () => {
  events = [];
  commits = [];
  dataDir = await mkdtemp(join(tmpdir(), "os-data-"));
  projectDir = await mkdtemp(join(tmpdir(), "os-proj-"));
  await writeFile(join(projectDir, "README.md"), "# minha app\n");
  core = await open();
  const added = await op("act_evt_open", "workspace.add_project", { projectId: "prj_minhaapp", name: "MinhaAplicacao", rootPath: projectDir });
  expect(added.status).toBe("succeeded");
});

afterEach(async () => {
  await core.close();
  await Promise.all([dataDir, projectDir].map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

describe("Eventos de domínio pelo núcleo (A2)", () => {
  it("abrir o workspace publica workspace.opened, e todos os eventos seguem o contrato", () => {
    expect(events[0]).toMatchObject({ type: "workspace.opened", source: "workspace_store", subjectId: core.store.id });
    for (const event of events) expect(validEvent(event), `${event.type}: ${JSON.stringify(validEvent.errors)}`).toBe(true);
  });

  it("cada operação publica os eventos do que mudou, com o operationId dela, antes de operation.completed", async () => {
    const regionEvents = await published(() => op("act_evt_region", "region.create", { regionId: "rgn_backend", title: "Backend" }));
    expect(regionEvents.map((e) => [e.type, e.subjectId, e.operationId])).toEqual([
      ["region.changed", "rgn_backend", "act_evt_region"],
      ["workspace.revision_changed", core.store.id, "act_evt_region"],
      ["operation.completed", undefined, "act_evt_region"],
    ]);

    // O agente, num lote: cada passo publica com o operationId do passo.
    const project = core.store.project("prj_minhaapp")!;
    const batch = await published(() =>
      core.batches.run({
        batchId: "bat_evt_batch",
        intent: "Abrir o README",
        policy: {},
        steps: [
          {
            stepId: "readme",
            request: {
              operationId: "act_evt_readme",
              operation: "project.resolve",
              arguments: { projectId: project.id, rootId: project.roots[0].id, path: "README.md" },
              authorization: { actor: CLAUDE_AGENT },
            },
          },
          {
            stepId: "editor",
            dependsOn: ["readme"],
            request: {
              operationId: "act_evt_editor",
              operation: "mod.create",
              arguments: { modId: "mod_readme", type: "editor", config: { fileRef: { $bind: { step: "readme", pointer: "/output/artifact/id" } } } },
              authorization: { actor: CLAUDE_AGENT },
            },
          },
        ],
      }),
    );
    const domain = batch.filter((e) => !["operation.completed", "batch.status_changed", "workspace.revision_changed"].includes(e.type));
    expect(domain.map((e) => [e.type, e.operationId])).toEqual([
      ["artifact.created", "act_evt_readme"],
      ["mod.created", "act_evt_editor"],
    ]);
    for (const event of events) expect(validEvent(event), `${event.type}: ${JSON.stringify(validEvent.errors)}`).toBe(true);
  });

  it("mexer na câmera não muda a revisão do documento: a pré-condição de revisão continua valendo e a câmera é salva", async () => {
    const revision = core.store.revision;
    const from = commits.length;
    expect((await op("act_evt_pan", "navigation.set_camera", { camera: { center: { x: 900, y: 400 }, zoom: 1.5 } })).status).toBe("succeeded");
    expect(core.store.revision).toBe(revision);
    expect(commits.slice(from).every((c) => c.viewOnly)).toBe(true);

    const created = await op("act_evt_guarded", "region.create", { regionId: "rgn_api", title: "API" }, {
      preconditions: [{ kind: "revision_equals", targetId: core.store.id, revision }],
    });
    expect(created.status, JSON.stringify(created.error)).toBe("succeeded");

    await core.close();
    core = await open();
    expect(core.store.read().navigation.camera).toEqual({ center: { x: 900, y: 400 }, zoom: 1.5 });
  });
});
