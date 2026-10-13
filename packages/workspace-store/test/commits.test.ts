// Commits do store (A2): o que cada transação mudou, a câmera fora da revisão do documento, o desfazer quando
// a transação falha, a cópia da interface em dia só com os commits e os eventos de domínio que saem deles.
import { describe, expect, it } from "vitest";

import {
  contractValidator,
  type ArtifactReference,
  type DiagramModel,
  type ModInstance,
  type Project,
  type Region,
  type SemanticEntity,
  type SemanticRelation,
} from "@open-semantic/protocol";

import { WorkspaceStore, applyCommit, commitEvents, withoutBefore, type Commit } from "../src/index.js";

const at = "2026-10-13T00:00:00.000Z";
const user = { kind: "user", id: "arthur" } as const;
const rect = (x: number, y: number) => ({ position: { x, y }, size: { width: 100, height: 100 } });
const project = {
  id: "prj_app",
  name: "App",
  location: { kind: "local", rootPath: "/repos/app" },
  roots: [{ id: "root_app", path: "", capabilities: ["read", "write"], commandPolicy: { mode: "confirm_all" } }],
  rootRef: "art_app_root",
  revision: 1,
} as Project;
const artifact = (id: string, path: string, validity: Partial<ArtifactReference["validity"]> = {}) =>
  ({
    id,
    projectId: "prj_app",
    kind: "file",
    locator: { rootId: "root_app", path },
    validity: { status: "valid", checkedAt: at, ...validity },
    provenance: { source: "inspection", actor: user, recordedAt: at },
  }) as ArtifactReference;
const mod = (config: Record<string, unknown>) =>
  ({ id: "mod_readme", type: "editor", typeVersion: 1, projectId: "prj_app", config, lifecycle: "active", revision: 0, createdBy: user, createdAt: at }) as ModInstance;
const entity = (status: "inferred" | "verified") =>
  ({ id: "sem_api", kind: "service", name: "API", projectId: "prj_app", status, provenance: { source: "agent_inference", recordedAt: at }, revision: 0 }) as SemanticEntity;
const relation = { id: "rel_api_db", type: "depends_on", sourceId: "sem_api", targetId: "sem_api", status: "inferred", provenance: { source: "agent_inference", recordedAt: at }, revision: 0 } as SemanticRelation;
const diagram = (title: string) => ({ id: "dgm_arch", title, kind: "architecture", nodes: [], edges: [], layout: { algorithm: "layered", nodes: {} }, revision: 0 }) as DiagramModel;
const region: Region = { id: "rgn_api", title: "API", bounds: rect(0, 0) };

function opened() {
  const store = WorkspaceStore.create({ id: "ws_test", name: "Teste", now: () => new Date(at) });
  const commits: Commit[] = [];
  store.onCommit((c) => commits.push(c));
  return { store, commits };
}

describe("Commits do store (A2)", () => {
  it("cada transação vira um commit com o antes e o depois de cada mudança", () => {
    const { store, commits } = opened();
    store.transact(() => store.putRegion(region));
    store.transact(() => store.putRegion({ ...store.region("rgn_api")!, title: "API pública" }));
    store.transact(() => store.deleteRegion("rgn_api"));
    const regions = commits.map((c) =>
      c.changes.filter((ch) => ch.collection === "regions").map((ch) => [ch.kind, (ch.before as Region | undefined)?.title, (ch.after as Region | undefined)?.title]),
    );
    expect(regions).toEqual([[["created", undefined, "API"]], [["updated", "API", "API pública"]], [["deleted", "API pública", undefined]]]);
    expect(commits.map((c) => [c.sequence, c.revision, c.viewOnly])).toEqual([
      [1, 1, false],
      [2, 2, false],
      [3, 3, false],
    ]);
    // A revisão nova do documento chega como mudança do workspace.
    expect(commits[0]!.changes[0]).toMatchObject({ collection: "workspace", kind: "updated", after: { revision: 1 } });
  });

  it("mexer só na navegação gera um commit de visualização: a revisão do documento fica igual", () => {
    const { store, commits } = opened();
    store.transact(() => store.setCamera({ center: { x: 300, y: 0 }, zoom: 2 }));
    expect(store.revision).toBe(0);
    expect(store.sequence).toBe(1);
    expect(commits.map((c) => [c.sequence, c.revision, c.viewOnly, c.changes.map((ch) => ch.collection)])).toEqual([[1, 0, true, ["navigation"]]]);
    expect(store.read().navigation.camera.zoom).toBe(2);
  });

  it("um erro no meio de uma transação desfaz tudo o que ela mudou, inclusive o das transações de dentro", () => {
    const { store, commits } = opened();
    store.transact(() => {
      store.addProject(project);
      store.upsertArtifact(artifact("art_app_readme", "README.md"));
    });
    const before = store.snapshot();
    expect(() =>
      store.transact(() => {
        store.putRegion(region);
        store.setCamera({ center: { x: 9, y: 9 }, zoom: 3 });
        store.setActiveProject("prj_app");
        store.transact(() => store.removeProject("prj_app"));
        throw new Error("falhou no meio");
      }),
    ).toThrow("falhou no meio");
    expect(store.snapshot()).toEqual(before);
    expect(store.revision).toBe(1);
    expect(commits).toHaveLength(1);
  });

  it("objetos do store não mudam no lugar: alterar o que veio de read() é erro", () => {
    const { store } = opened();
    store.transact(() => store.putRegion(region));
    const saved = store.read().canvas.regions[0]!;
    expect(() => void ((saved as { title: string }).title = "Outra")).toThrow(TypeError);
    expect(() => void (saved.bounds.position.x = 5)).toThrow(TypeError);
    expect(store.region("rgn_api")!.title).toBe("API");
  });

  it("gravar de novo um objeto igual não gera commit", () => {
    const { store, commits } = opened();
    store.transact(() => store.addProject(project));
    store.transact(() => store.upsertArtifact(artifact("art_app_readme", "README.md")));
    store.transact(() => store.upsertArtifact(artifact("art_app_readme", "README.md")));
    expect(commits).toHaveLength(2);
    expect(store.revision).toBe(2);
  });

  it("transact não aceita função assíncrona", () => {
    const { store } = opened();
    expect(() => store.transact(async () => undefined)).toThrow(/assíncrona/);
  });

  it("aplicando só os commits, a cópia da interface fica igual ao workspace", () => {
    const { store, commits } = opened();
    let copy = store.snapshot();
    const steps: (() => unknown)[] = [
      () => {
        store.addProject(project);
        store.setActiveProject("prj_app");
      },
      () => {
        store.upsertArtifact(artifact("art_app_readme", "README.md"));
        store.upsertArtifact(artifact("art_app_src", "src"));
      },
      () => store.putRegion(region),
      () => {
        store.putMod(mod({ fileRef: "art_app_readme" }));
        store.placeObject({ id: "mod_readme", objectKind: "mod", ...rect(10, 10), regionId: "rgn_api" });
      },
      () => store.placeObject({ ...store.canvasObject("mod_readme")!, ...rect(400, 10) }),
      () => store.putMod({ ...store.mod("mod_readme")!, lifecycle: "closed" }),
      () => store.setCamera({ center: { x: 50, y: 50 }, zoom: 0.5 }),
      () => store.deleteRegion("rgn_api"),
      () => {
        store.putEntity(entity("inferred"));
        store.putRelation(relation);
        store.putDiagram(diagram("Arquitetura"));
        store.placeObject({ id: "dgm_arch", objectKind: "diagram", ...rect(0, 300) });
      },
      () => store.updateNavigation({ focus: { targetIds: ["dgm_arch", "mod_readme"], highlightIds: ["dgm_arch"] } }),
      () => store.deleteMod("mod_readme"),
      () => store.removeProject("prj_app"),
    ];
    for (const step of steps) {
      const from = commits.length;
      store.transact(step);
      for (const commit of commits.slice(from)) copy = applyCommit(copy, withoutBefore(commit));
      expect(copy).toEqual(store.snapshot());
    }
    expect(commits.map((c) => c.sequence)).toEqual(steps.map((_, i) => i + 1));
  });
});

describe("Eventos de domínio a partir dos commits (A2)", () => {
  const validEvent = contractValidator("operation.schema.json#/$defs/DomainEvent");

  it("cada mudança do documento vira o evento do contrato, com a operação e a revisão", () => {
    const { store, commits } = opened();
    let seq = 0;
    const eventsOf = (step: () => unknown) => {
      const from = commits.length;
      store.transact(step);
      return commits.slice(from).flatMap((c) =>
        commitEvents(c, { workspaceId: store.id, newId: () => `evt_test_${++seq}`, now: () => new Date(at), operationId: "act_test_op" }),
      );
    };
    const types = (step: () => unknown) => {
      const events = eventsOf(step);
      for (const event of events) expect(validEvent(event), JSON.stringify(validEvent.errors)).toBe(true);
      return events.map((e) => (e.type === "workspace.revision_changed" ? e.type : `${e.type} ${e.subjectId}`));
    };

    expect(types(() => store.addProject(project))).toEqual(["workspace.revision_changed"]);
    expect(types(() => store.upsertArtifact(artifact("art_app_readme", "README.md")))).toEqual(["artifact.created art_app_readme", "workspace.revision_changed"]);
    expect(types(() => store.upsertArtifact(artifact("art_app_readme", "README.md", { status: "missing" })))).toEqual([
      "artifact.validity_changed art_app_readme",
      "artifact.missing art_app_readme",
      "workspace.revision_changed",
    ]);
    const hash = (n: number) => ({ fingerprint: { contentHash: `sha256:${String(n).repeat(64)}` } });
    expect(types(() => store.upsertArtifact(artifact("art_app_readme", "README.md", hash(1))))).toEqual(["artifact.validity_changed art_app_readme", "workspace.revision_changed"]);
    expect(types(() => store.upsertArtifact(artifact("art_app_readme", "README.md", hash(2))))).toEqual(["artifact.changed art_app_readme", "workspace.revision_changed"]);
    expect(types(() => store.putEntity(entity("inferred")))).toEqual(["semantic.entity_upserted sem_api", "workspace.revision_changed"]);
    expect(types(() => store.putEntity(entity("verified")))).toEqual(["semantic.entity_upserted sem_api", "semantic.status_changed sem_api", "workspace.revision_changed"]);
    expect(types(() => store.putRelation(relation))).toEqual(["semantic.relation_upserted rel_api_db", "workspace.revision_changed"]);
    expect(types(() => store.putRegion(region))).toEqual(["region.changed rgn_api", "workspace.revision_changed"]);
    expect(
      types(() => {
        store.putMod(mod({ fileRef: "art_app_readme" }));
        store.placeObject({ id: "mod_readme", objectKind: "mod", ...rect(10, 10) });
      }),
    ).toEqual(["mod.created mod_readme", "workspace.revision_changed"]);
    expect(types(() => store.placeObject({ ...store.canvasObject("mod_readme")!, ...rect(400, 10) }))).toEqual(["canvas.object_moved mod_readme", "workspace.revision_changed"]);
    expect(types(() => store.putMod({ ...store.mod("mod_readme")!, lifecycle: "closed" }))).toEqual(["mod.lifecycle_changed mod_readme", "workspace.revision_changed"]);
    expect(types(() => store.putMod({ ...store.mod("mod_readme")!, title: "Leia-me" }))).toEqual(["mod.configured mod_readme", "workspace.revision_changed"]);
    expect(types(() => store.putDiagram(diagram("Arquitetura")))).toEqual(["diagram.created dgm_arch", "workspace.revision_changed"]);
    expect(types(() => store.putDiagram(diagram("Arquitetura atual")))).toEqual(["diagram.changed dgm_arch", "workspace.revision_changed"]);
    expect(types(() => store.deleteDiagram("dgm_arch"))).toEqual(["diagram.deleted dgm_arch", "workspace.revision_changed"]);
    expect(types(() => store.deleteMod("mod_readme"))).toEqual(["mod.deleted mod_readme", "workspace.revision_changed"]);
    expect(types(() => store.deleteRegion("rgn_api"))).toEqual(["region.changed rgn_api", "workspace.revision_changed"]);
    // A câmera não é documento: nenhum evento de revisão.
    expect(types(() => store.setCamera({ center: { x: 1, y: 1 }, zoom: 1 }))).toEqual([]);

    const last = eventsOf(() => store.putRegion(region));
    expect(last[0]).toMatchObject({ operationId: "act_test_op", workspaceRevision: store.revision, source: "workspace_store", payload: { change: "created", title: "API" } });
  });
});
