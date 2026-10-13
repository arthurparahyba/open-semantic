import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { contractValidator } from "@open-semantic/protocol";

import {
  FileWorkspacePersistence,
  WorkspaceStore,
  autosave,
  findFreeSpot,
  overlaps,
  type PersistStatus,
  type WorkspacePersistence,
} from "../src/index.js";

const validSnapshot = contractValidator("workspace.schema.json");
const rect = (x: number, y: number, width = 100, height = 100) => ({ position: { x, y }, size: { width, height } });

describe("WorkspaceStore", () => {
  it("snapshot vazio é válido pelo contrato", () => {
    const store = WorkspaceStore.create({ id: "ws_test", name: "Teste" });
    expect(validSnapshot(store.snapshot())).toBe(true);
  });

  it("uma transação gera uma única revisão e notifica uma vez", () => {
    const store = WorkspaceStore.create({ id: "ws_test", name: "Teste" });
    const seen: number[] = [];
    store.onCommit((c) => seen.push(c.revision));
    store.transact(() => {
      store.putRegion({ id: "rgn_backend", title: "Backend", bounds: rect(0, 0) });
      store.setCamera({ center: { x: 1, y: 1 }, zoom: 1 });
      store.setCamera({ center: { x: 2, y: 2 }, zoom: 1 });
    });
    expect(store.revision).toBe(1);
    expect(seen).toEqual([1]);
  });

  it("mutação fora de transact é erro de programação", () => {
    const store = WorkspaceStore.create({ id: "ws_test", name: "Teste" });
    expect(() => store.setCamera({ center: { x: 0, y: 0 }, zoom: 1 })).toThrow(/transact/);
  });

  it("transação sem mudança não cria revisão", () => {
    const store = WorkspaceStore.create({ id: "ws_test", name: "Teste" });
    store.transact(() => undefined);
    expect(store.revision).toBe(0);
  });

  it("movimento em andamento não sobrevive a reabrir", () => {
    const doc = WorkspaceStore.create({ id: "ws_test", name: "Teste" }).snapshot();
    doc.navigation.motion = { status: "animating", origin: "agent" };
    expect(new WorkspaceStore(doc).read().navigation.motion).toEqual({ status: "idle" });
  });
});

describe("findFreeSpot", () => {
  it("primeiro objeto vai para a origem", () => {
    expect(findFreeSpot([], { width: 100, height: 100 })).toEqual(rect(0, 0));
  });

  it("nunca sobrepõe e prefere ficar ao lado da âncora", () => {
    const anchor = rect(0, 0);
    const occupied = [anchor, rect(140, 0)];
    const spot = findFreeSpot(occupied, { width: 100, height: 100 }, [anchor]);
    expect(occupied.some((o) => overlaps(o, spot))).toBe(false);
    expect(spot.position).toEqual({ x: 0, y: 140 });
  });

  it("sem âncora, vai à direita de tudo", () => {
    const spot = findFreeSpot([rect(0, 50), rect(300, 0)], { width: 100, height: 100 });
    expect(spot.position).toEqual({ x: 440, y: 0 });
  });
});

describe("persistência", () => {
  it("autosave grava e informa pendente → salvo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-ws-"));
    try {
      const persistence = new FileWorkspacePersistence(dir);
      const store = WorkspaceStore.create({ id: "ws_test", name: "Teste" });
      const statuses: PersistStatus["state"][] = [];
      const saver = autosave(store, persistence, { debounceMs: 1, onStatus: (s) => statuses.push(s.state) });
      store.transact(() => store.setCamera({ center: { x: 5, y: 5 }, zoom: 2 }));
      await saver.flush();
      saver.stop();
      expect(statuses).toEqual(["pending", "saved"]);
      expect((await persistence.load("ws_test"))?.navigation.camera.zoom).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flush espera também a gravação que entrou na fila durante a espera", async () => {
    const store = WorkspaceStore.create({ id: "ws_test", name: "Teste" });
    const saved: number[] = [];
    const persistence: WorkspacePersistence = {
      load: async () => undefined,
      save: async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        saved.push(snapshot.navigation.camera.center.x);
      },
    };
    const saver = autosave(store, persistence, { debounceMs: 1 });
    store.transact(() => store.setCamera({ center: { x: 1, y: 1 }, zoom: 1 }));
    const flushed = saver.flush();
    // Enquanto a primeira gravação acontece, o store muda de novo (como no fim de uma animação).
    store.transact(() => store.setCamera({ center: { x: 2, y: 2 }, zoom: 1 }));
    await flushed;
    saver.stop();
    // Ao fechar o app, nada pode ficar gravando depois do flush.
    expect(saved).toEqual([1, 2]);
  });

  it("recusa carregar um arquivo fora do contrato em vez de abrir estado corrompido", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-ws-"));
    try {
      await writeFile(join(dir, "ws_test.json"), JSON.stringify({ schemaVersion: "0.2" }));
      await expect(new FileWorkspacePersistence(dir).load("ws_test")).rejects.toThrow(/fora do contrato/);
      expect(await readFile(join(dir, "ws_test.json"), "utf8")).toContain("0.2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
