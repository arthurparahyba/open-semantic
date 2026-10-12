import type { Rect, Region, Size } from "@open-semantic/protocol";

import { placeAnchored, type AnchorDoc } from "./anchoring.js";

export const GAP = 40;

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.position.x < b.position.x + b.size.width + gap &&
    b.position.x < a.position.x + a.size.width + gap &&
    a.position.y < b.position.y + b.size.height + gap &&
    b.position.y < a.position.y + a.size.height + gap
  );
}

/**
 * Posição livre para um objeto novo: ao lado das âncoras (à direita, abaixo, à esquerda, acima),
 * ou à direita de tudo que já existe. Nunca sobrepõe um objeto existente.
 */
export function findFreeSpot(occupied: Rect[], size: Size, anchors: Rect[] = []): Rect {
  const fits = (r: Rect) => !occupied.some((o) => overlaps(r, o, GAP / 2));
  const at = (x: number, y: number): Rect => ({ position: { x, y }, size });

  if (occupied.length === 0) return at(0, 0);

  for (const a of anchors) {
    const right = at(a.position.x + a.size.width + GAP, a.position.y);
    const below = at(a.position.x, a.position.y + a.size.height + GAP);
    const left = at(a.position.x - size.width - GAP, a.position.y);
    const above = at(a.position.x, a.position.y - size.height - GAP);
    for (const candidate of [right, below, left, above]) if (fits(candidate)) return candidate;
    // Continua à direita da âncora até achar espaço.
    let x = right.position.x;
    for (let i = 0; i < 200; i++) {
      x += GAP + size.width / 2;
      const candidate = at(x, a.position.y);
      if (fits(candidate)) return candidate;
    }
  }

  const maxRight = Math.max(...occupied.map((o) => o.position.x + o.size.width));
  const minTop = Math.min(...occupied.map((o) => o.position.y));
  return at(maxRight + GAP, minTop);
}

export interface PlacementRequest {
  position?: Rect["position"];
  anchorIds?: string[];
  regionId?: string;
  strategy?: "free_space_near";
  /** Unidade de contexto do item: sem região, posição ou âncoras visuais, o lugar sai dela (doc 09). */
  unitId?: string;
}

/** Margem interna da região: espaço para o título em cima e respiro nas laterais. */
export const REGION_PADDING = { top: 56, side: 32 } as const;

/**
 * Onde colocar um objeto novo. Dentro de uma região, o objeto vai para o primeiro espaço livre dela,
 * e a região cresce se for preciso (o chamador grava `grownRegion`). Fora, vale findFreeSpot.
 */
export function placeNew(
  doc: AnchorDoc,
  size: Size,
  placement: PlacementRequest = {},
): { rect: Rect; regionId?: string; grownRegion?: Region } {
  const occupied = [...doc.canvas.objects.map(rectOf), ...doc.canvas.regions.map((r) => r.bounds)];
  const lookup = (id: string): Rect | undefined =>
    doc.canvas.objects.find((o) => o.id === id) ?? doc.canvas.regions.find((r) => r.id === id)?.bounds;
  if (placement.position) return { rect: { position: placement.position, size } };

  const region = placement.regionId ? doc.canvas.regions.find((r) => r.id === placement.regionId) : undefined;
  if (region) {
    const inside = doc.canvas.objects.filter((o) => o.regionId === region.id).map(rectOf);
    const origin = {
      x: region.bounds.position.x + REGION_PADDING.side,
      y: region.bounds.position.y + REGION_PADDING.top,
    };
    const first: Rect = { position: origin, size };
    const rect = inside.length === 0 ? first : findFreeSpot(doc.canvas.objects.map(rectOf), size, inside.slice(-1));
    const bounds = boundsOfRects([region.bounds, pad(rect)]);
    const grew =
      bounds.size.width !== region.bounds.size.width ||
      bounds.size.height !== region.bounds.size.height ||
      bounds.position.x !== region.bounds.position.x ||
      bounds.position.y !== region.bounds.position.y;
    return { rect, regionId: region.id, ...(grew ? { grownRegion: { ...region, bounds } } : {}) };
  }

  const anchors = (placement.anchorIds ?? []).map(lookup).filter((r): r is Rect => r !== undefined);
  if (!anchors.length && placement.unitId) return { rect: placeAnchored(doc, size, placement.unitId) };
  return { rect: findFreeSpot(occupied, size, anchors) };
}

const rectOf = (o: { position: Rect["position"]; size: Size }): Rect => ({ position: o.position, size: o.size });

function pad(rect: Rect): Rect {
  return {
    position: { x: rect.position.x - REGION_PADDING.side, y: rect.position.y - REGION_PADDING.top },
    size: { width: rect.size.width + 2 * REGION_PADDING.side, height: rect.size.height + REGION_PADDING.top + REGION_PADDING.side },
  };
}

export function boundsOfRects(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.position.x));
  const minY = Math.min(...rects.map((r) => r.position.y));
  const maxX = Math.max(...rects.map((r) => r.position.x + r.size.width));
  const maxY = Math.max(...rects.map((r) => r.position.y + r.size.height));
  return { position: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } };
}

/** Região que contém o centro do retângulo, se houver. */
export function regionAt(regions: Region[], rect: Rect): Region | undefined {
  const cx = rect.position.x + rect.size.width / 2;
  const cy = rect.position.y + rect.size.height / 2;
  return regions.find(
    (r) =>
      cx >= r.bounds.position.x &&
      cx <= r.bounds.position.x + r.bounds.size.width &&
      cy >= r.bounds.position.y &&
      cy <= r.bounds.position.y + r.bounds.size.height,
  );
}
