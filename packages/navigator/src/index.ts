import type { Camera, Point, Rect } from "@open-semantic/protocol";

export interface Viewport {
  width: number;
  height: number;
}

export interface FrameOptions {
  /** Margem em pixels de tela ao redor dos alvos. */
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
  /**
   * focus/compare: enquadra os alvos sem passar de zoom 1 (não amplia além do tamanho real).
   * detail: permite ampliar até maxZoom. overview: limita a zoom 0.6 para dar contexto.
   */
  intent?: "overview" | "focus" | "detail" | "compare";
}

export const ZOOM_LIMITS = { min: 0.05, max: 8 } as const;

/** Menor retângulo que contém todos os retângulos. */
export function boundsOf(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.position.x);
    minY = Math.min(minY, r.position.y);
    maxX = Math.max(maxX, r.position.x + r.size.width);
    maxY = Math.max(maxY, r.position.y + r.size.height);
  }
  return { position: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } };
}

/**
 * Câmera que enquadra todos os retângulos (coordenadas do mundo) dentro da viewport (pixels).
 * Função pura: o agente diz o que ver; a geometria é decidida aqui (docs/funcionalidades/04).
 */
export function computeFrame(rects: Rect[], viewport: Viewport, options: FrameOptions = {}): Camera | undefined {
  const box = boundsOf(rects);
  if (!box) return undefined;
  const padding = options.padding ?? 48;
  const intent = options.intent ?? "focus";
  const minZoom = Math.max(options.minZoom ?? ZOOM_LIMITS.min, ZOOM_LIMITS.min);
  const ceiling = intent === "detail" ? (options.maxZoom ?? ZOOM_LIMITS.max) : intent === "overview" ? 0.6 : 1;
  const maxZoom = Math.min(ceiling, options.maxZoom ?? ceiling, ZOOM_LIMITS.max);

  const availableW = Math.max(viewport.width - 2 * padding, 1);
  const availableH = Math.max(viewport.height - 2 * padding, 1);
  const fit = Math.min(availableW / Math.max(box.size.width, 1), availableH / Math.max(box.size.height, 1));
  const zoom = clamp(fit, minZoom, Math.max(maxZoom, minZoom));

  return {
    center: { x: box.position.x + box.size.width / 2, y: box.position.y + box.size.height / 2 },
    zoom: round(zoom),
  };
}

/** Converte um ponto da tela (pixels relativos à viewport) para o mundo. */
export function screenToWorld(point: Point, camera: Camera, viewport: Viewport): Point {
  return {
    x: camera.center.x + (point.x - viewport.width / 2) / camera.zoom,
    y: camera.center.y + (point.y - viewport.height / 2) / camera.zoom,
  };
}

/** Converte um ponto do mundo para a tela. */
export function worldToScreen(point: Point, camera: Camera, viewport: Viewport): Point {
  return {
    x: (point.x - camera.center.x) * camera.zoom + viewport.width / 2,
    y: (point.y - camera.center.y) * camera.zoom + viewport.height / 2,
  };
}

/** Zoom ancorado: o ponto do mundo sob o cursor continua sob o cursor. */
export function zoomAt(camera: Camera, viewport: Viewport, screenPoint: Point, factor: number): Camera {
  const zoom = clamp(camera.zoom * factor, ZOOM_LIMITS.min, ZOOM_LIMITS.max);
  const anchor = screenToWorld(screenPoint, camera, viewport);
  return {
    zoom,
    center: {
      x: anchor.x - (screenPoint.x - viewport.width / 2) / zoom,
      y: anchor.y - (screenPoint.y - viewport.height / 2) / zoom,
    },
  };
}

/** Desloca a câmera por um arrasto em pixels de tela. */
export function pan(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return { zoom: camera.zoom, center: { x: camera.center.x - dxScreen / camera.zoom, y: camera.center.y - dyScreen / camera.zoom } };
}

/** O retângulo do mundo está inteiro dentro da área visível? */
export function isVisible(rect: Rect, camera: Camera, viewport: Viewport): boolean {
  const a = worldToScreen(rect.position, camera, viewport);
  const b = worldToScreen({ x: rect.position.x + rect.size.width, y: rect.position.y + rect.size.height }, camera, viewport);
  const eps = 1e-6;
  return a.x >= -eps && a.y >= -eps && b.x <= viewport.width + eps && b.y <= viewport.height + eps;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function round(v: number) {
  return Math.round(v * 10_000) / 10_000;
}
