import { describe, expect, it } from "vitest";

import { WorkspaceStore } from "@open-semantic/workspace-store";

import { layerView } from "../src/context.js";

const at = "2026-10-13T12:00:00.000Z";
const layer = (id: string, name: string, members: string[], parentId?: string) => ({
  id,
  name,
  anchors: ["dgm_base"],
  members: members.map((m) => ({ id: m, weight: 1, addedBy: "agent" as const })),
  origin: "agent" as const,
  createdAt: at,
  lastActiveAt: at,
  ...(parentId ? { parentId } : {}),
});

function snapshot(active?: string) {
  const doc = WorkspaceStore.create({ id: "ws_teste", name: "Teste" }).snapshot();
  doc.layers = [
    layer("lyr_infra", "Infraestrutura", ["dgm_infra"]),
    layer("lyr_auth", "Autenticação", ["dgm_auth"], "lyr_infra"),
    layer("lyr_jwt", "Tokens", ["dgm_jwt", "dgm_auth"], "lyr_auth"),
    layer("lyr_cache", "Cache", ["dgm_cache"], "lyr_infra"),
  ];
  if (active) doc.navigation.activeLayerId = active;
  return doc;
}

describe("camada ativa para o motor de contexto", () => {
  it("sem camadas não muda nada", () => {
    expect(layerView(WorkspaceStore.create({ id: "ws_teste", name: "Teste" }).snapshot())).toBeUndefined();
  });

  it("na base lista só as camadas de primeiro nível e deixa de fora o que é delas", () => {
    expect(layerView(snapshot())).toEqual({ name: "", path: [], members: [], hidden: ["dgm_infra", "dgm_auth", "dgm_jwt", "dgm_cache"], others: ["Infraestrutura"] });
  });

  it("na filha: caminho, membros, o que é de filhas e irmãs escondido, elas só pelo nome", () => {
    expect(layerView(snapshot("lyr_auth"))).toEqual({
      name: "Autenticação",
      path: ["Infraestrutura"],
      members: [{ ref: "dgm_auth", weight: 1 }],
      hidden: ["dgm_jwt", "dgm_cache"],
      others: ["Tokens", "Cache"],
    });
  });
});
