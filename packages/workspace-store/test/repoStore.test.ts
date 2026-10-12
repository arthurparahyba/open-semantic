import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@open-semantic/protocol";

import { RepoWriter, WorkspaceStore, readRepoContent, splitSnapshot, storesInRepo } from "../src/index.js";

const prov = (evidenceIds: string[] = []) => ({ source: "agent_inference", recordedAt: "2026-10-12T00:00:00.000Z", evidenceIds });
const project = (id: string, capabilities = ["read", "write"]) => ({
  id,
  name: id,
  location: { kind: "local", rootPath: `/repos/${id}` },
  roots: [{ id: `root_${id.slice(4)}`, path: "", capabilities, commandPolicy: { mode: "confirm_all" } }],
  rootRef: `art_${id.slice(4)}_root`,
  revision: 1,
});

/** Dois projetos com conhecimento próprio e uma relação que liga os dois. */
function snapshot(): WorkspaceSnapshot {
  const snap = WorkspaceStore.create({ id: "ws_test", name: "Teste" }).snapshot() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  snap.projects = [project("prj_aaa"), project("prj_bbb"), project("prj_ro", ["read"])];
  snap.artifacts = [
    { id: "art_a_api", projectId: "prj_aaa", kind: "directory", locator: { rootId: "root_aaa", path: "api" } },
    { id: "art_b_web", projectId: "prj_bbb", kind: "directory", locator: { rootId: "root_bbb", path: "web" } },
  ];
  snap.semantic = {
    entities: [
      { id: "sem_api", kind: "module", name: "API", projectId: "prj_aaa", artifactIds: ["art_a_api"], provenance: prov(["evd_api"]) },
      { id: "sem_db", kind: "data_store", name: "DB", projectId: "prj_aaa", provenance: prov(["evd_solta"]) },
      { id: "sem_web", kind: "module", name: "Web", projectId: "prj_bbb", provenance: prov() },
      { id: "sem_ro", kind: "module", name: "RO", projectId: "prj_ro", provenance: prov() },
    ],
    relations: [
      { id: "rel_api_db", type: "depends_on", sourceId: "sem_api", targetId: "sem_db", provenance: prov() },
      { id: "rel_web_api", type: "communicates_with", sourceId: "sem_web", targetId: "sem_api", provenance: prov(["evd_ponte"]) },
    ],
    evidence: [
      { id: "evd_api", kind: "directory_listing", artifactId: "art_a_api", summary: "api/" },
      { id: "evd_solta", kind: "user_statement", summary: "o usuário disse" },
      { id: "evd_ponte", kind: "user_statement", summary: "liga os dois" },
    ],
  };
  snap.diagrams = [{ id: "dgm_a", title: "A", kind: "architecture", projectId: "prj_aaa", nodes: [], edges: [] }];
  return snap as unknown as WorkspaceSnapshot;
}

describe("Separação entre workspace e repositório", () => {
  it("só pasta local com escrita guarda conhecimento no repositório", () => {
    const snap = snapshot();
    expect(snap.projects.map(storesInRepo)).toEqual([true, true, false]);
  });

  it("cada repositório leva o que é só dele; o que liga projetos fica no workspace", () => {
    const { workspace, repos } = splitSnapshot(snapshot());
    const a = repos.get("prj_aaa")!;
    expect(a.diagrams.map((d) => d.id)).toEqual(["dgm_a"]);
    expect(a.diagrams[0]).not.toHaveProperty("projectId");
    expect(a.entities.map((e) => e.id)).toEqual(["sem_api", "sem_db"]);
    expect(a.entities[0]).toMatchObject({ artifactPaths: ["api"] });
    expect(a.relations.map((r) => r.id)).toEqual(["rel_api_db"]);
    expect(a.evidence.map((e) => e.id).sort()).toEqual(["evd_api", "evd_solta"]);
    expect(a.evidence.find((e) => e.id === "evd_api")).toMatchObject({ artifactPath: "api" });

    expect(repos.get("prj_bbb")!.entities.map((e) => e.id)).toEqual(["sem_web"]);
    expect(repos.has("prj_ro")).toBe(false);

    expect(workspace.diagrams).toEqual([]);
    expect(workspace.semantic.entities.map((e) => e.id)).toEqual(["sem_ro"]);
    expect(workspace.semantic.relations.map((r) => r.id)).toEqual(["rel_web_api"]);
    expect(workspace.semantic.evidence.map((e) => e.id)).toEqual(["evd_ponte"]);
  });
});

describe("RepoWriter", () => {
  it("grava só o que mudou, apaga só diagrama que conhece e não cria pasta à toa", async () => {
    const root = await mkdtemp(join(tmpdir(), "os-repo-"));
    try {
      const writer = new RepoWriter();
      const empty = { diagrams: [], entities: [], relations: [], evidence: [] };
      await writer.write(root, empty);
      expect(await readdir(root)).toEqual([]);

      // Um diagrama que outra pessoa salvou e este workspace ainda não leu não é apagado.
      await mkdir(join(root, ".open-semantic", "diagrams"), { recursive: true });
      await writeFile(join(root, ".open-semantic", "diagrams", "dgm_alheio.json"), "{}");

      const { repos } = splitSnapshot(snapshot());
      const content = { ...repos.get("prj_aaa")! };
      await writer.write(root, content);
      expect((await readdir(join(root, ".open-semantic", "diagrams"))).sort()).toEqual(["dgm_a.json", "dgm_alheio.json"]);

      // Arquivo fora do contrato é pulado e informado, sem impedir de ler o resto.
      const back = await readRepoContent(root);
      expect(back.problems.some((p) => p.startsWith("diagrams/dgm_alheio.json fora do contrato"))).toBe(true);
      expect(back.content.diagrams.some((d) => (d as { id?: string }).id === undefined)).toBe(false);

      await writer.write(root, { ...content, diagrams: [] });
      expect(await readdir(join(root, ".open-semantic", "diagrams"))).toEqual(["dgm_alheio.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
