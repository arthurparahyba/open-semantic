import { describe, expect, it } from "vitest";

import { computeFrame, isVisible, pan, screenToWorld, worldToScreen, zoomAt } from "../src/index.js";

const viewport = { width: 1200, height: 800 };
const rect = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });

describe("computeFrame (critério A5)", () => {
  it("enquadra objetos fora da área visível", () => {
    const targets = [rect(5000, 4000, 360, 520), rect(5600, 4100, 480, 200)];
    const before = { center: { x: 0, y: 0 }, zoom: 1 };
    expect(targets.some((t) => isVisible(t, before, viewport))).toBe(false);

    const camera = computeFrame(targets, viewport)!;
    for (const t of targets) expect(isVisible(t, camera, viewport)).toBe(true);
  });

  it("não amplia além do tamanho real em 'focus', mas amplia em 'detail'", () => {
    const small = [rect(0, 0, 100, 50)];
    expect(computeFrame(small, viewport, { intent: "focus" })!.zoom).toBe(1);
    expect(computeFrame(small, viewport, { intent: "detail" })!.zoom).toBeGreaterThan(1);
  });

  it("reduz o zoom para caber conteúdo grande", () => {
    const camera = computeFrame([rect(0, 0, 10_000, 10_000)], viewport)!;
    expect(camera.zoom).toBeLessThan(0.1);
    expect(camera.center).toEqual({ x: 5000, y: 5000 });
  });

  it("sem alvos não inventa destino", () => {
    expect(computeFrame([], viewport)).toBeUndefined();
  });
});

describe("transformações da câmera", () => {
  const camera = { center: { x: 100, y: 50 }, zoom: 2 };

  it("screenToWorld e worldToScreen são inversas", () => {
    const p = { x: 321, y: 123 };
    const back = worldToScreen(screenToWorld(p, camera, viewport), camera, viewport);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it("zoomAt mantém o ponto sob o cursor", () => {
    const cursor = { x: 900, y: 200 };
    const before = screenToWorld(cursor, camera, viewport);
    const after = screenToWorld(cursor, zoomAt(camera, viewport, cursor, 1.5), viewport);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("pan desloca na direção oposta ao arrasto, escalado pelo zoom", () => {
    expect(pan(camera, 100, -40).center).toEqual({ x: 50, y: 70 });
  });
});

describe("enquadramento com controles flutuantes", () => {
  it("evita a faixa coberta embaixo: o alvo sobe e cabe na área livre", () => {
    const rect = { position: { x: 0, y: 0 }, size: { width: 400, height: 400 } };
    const free = computeFrame([rect], { width: 1000, height: 800 }, { padding: 0 })!;
    const covered = computeFrame([rect], { width: 1000, height: 800, insets: { top: 0, right: 0, bottom: 200, left: 0 } }, { padding: 0 })!;
    expect(covered.zoom).toBe(free.zoom);
    // Centro da área livre (y = 300 na tela) mostra o centro do alvo: a câmera olha mais para baixo.
    expect(covered.center.y).toBeGreaterThan(free.center.y);
  });
});
