import type { Rect, Size } from "@open-semantic/protocol";

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
