// Regressão: o agente pede para enquadrar um diagrama que já está na tela, mas minúsculo; a câmera tem de aproximar.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createCore, type Core } from "../src/index.js";

const agent = { kind: "agent" as const, id: "claude" };
let core: Core;
let dir: string;
let seq = 0;
const ok = async (operation: string, args: Record<string, unknown>) => {
  const result = await core.dispatcher.dispatch({ operationId: `act_zoom_${String(++seq).padStart(4, "0")}`, operation, arguments: args, authorization: { actor: agent } });
  expect(result.status, `${operation}: ${JSON.stringify(result.error)}`).toBe("succeeded");
  return result;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "os-zoom-"));
  core = await createCore({ workspaceDir: dir, debounceMs: 5, animationMs: 0 });
});
afterEach(async () => {
  await core.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

it("enquadrar um diagrama visível mas pequeno aproxima a câmera", async () => {
  await ok("diagram.create", { diagramId: "dgm_cache", title: "Cache", kind: "architecture", nodes: [{ id: "nd_cache_a", label: "A", kind: "module" }], edges: [] });
  const o = core.store.canvasObject("dgm_cache")!;
  const center = { x: o.position.x + o.size.width / 2, y: o.position.y + o.size.height / 2 };
  core.store.transact(() => core.store.setCamera({ center, zoom: 0.05 }));
  const result = await ok("navigation.frame", { targets: { visualIds: ["dgm_cache"] }, intent: "focus" });
  expect(result.output).not.toMatchObject({ unchanged: true });
  expect(core.store.read().navigation.camera.zoom).toBeGreaterThan(0.2);
});
