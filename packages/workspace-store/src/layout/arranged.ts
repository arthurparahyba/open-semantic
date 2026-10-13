// Lugar de um objeto novo que declarou uma relação (docs/funcionalidades/13-layout-semantico.md):
// colado ao alvo (annotates), embaixo da explicação (continues) ou à direita do que ele aprofunda (details).
import type { Arrangement, Rect, Size } from "@open-semantic/protocol";

import { SPACING, annotations, arrangedOn, arrangementOf, boundsOfIds, flowIds, rectOf, sectionIds, type FlowDoc } from "./flow.js";
import { overlaps } from "./placement.js";

export interface ArrangedPlacement {
  rect: Rect;
  /** Objetos que descem para abrir espaço (um título novo acima de um diagrama que já tem algo em cima). */
  shift?: { ids: string[]; dy: number };
}

/** Lugar pela relação, ou undefined quando o alvo não está no canvas (vale o posicionamento comum). */
export function placeArranged(doc: FlowDoc, size: Size, arrangement: Arrangement): ArrangedPlacement | undefined {
  const target = rectOf(doc, arrangement.targetId);
  if (!target) return undefined;
  if (arrangement.relation === "annotates") return annotate(doc, size, arrangement);
  if (arrangement.relation === "continues") return { rect: continueAfter(doc, size, arrangement.targetId) };
  return { rect: detail(doc, size, arrangement.targetId) };
}

const at = (x: number, y: number, size: Size): Rect => ({ position: { x, y }, size });

/** Acima: em cima dos títulos que o alvo já tem; se não couber, a seção desce. Abaixo: embaixo das notas. */
function annotate(doc: FlowDoc, size: Size, { targetId, side }: Arrangement): ArrangedPlacement {
  const target = rectOf(doc, targetId)!;
  if (side === "below") {
    const below = boundsOfIds(doc, [targetId, ...annotations(doc, targetId, "below")])!;
    return { rect: at(target.position.x, below.position.y + below.size.height + SPACING.together, size) };
  }
  const above = boundsOfIds(doc, [targetId, ...annotations(doc, targetId, "above")])!;
  const rect = at(target.position.x, above.position.y - SPACING.together - size.height, size);
  const section = new Set(sectionIds(doc, targetId));
  // Um detalhe tem o topo alinhado ao do que ele detalha: o título dele desce o detalhe em vez de subir.
  const blocked = arrangementOf(doc, targetId)?.relation === "details" || doc.canvas.objects.some((o) => !section.has(o.id) && overlaps(rect, o, SPACING.together / 2));
  if (!blocked) return { rect };
  return { rect: at(target.position.x, above.position.y, size), shift: { ids: [...section], dy: size.height + SPACING.together } };
}

/** Embaixo de tudo que vem do alvo (inclusive os detalhes à direita, que podem descer mais). */
function continueAfter(doc: FlowDoc, size: Size, targetId: string): Rect {
  const flow = boundsOfIds(doc, flowIds(doc, targetId))!;
  return firstFree(doc, at(rectOf(doc, targetId)!.position.x, flow.position.y + flow.size.height + SPACING.near, size));
}

/** À direita da seção do alvo; os detalhes seguintes empilham embaixo dos anteriores. */
function detail(doc: FlowDoc, size: Size, targetId: string): Rect {
  const section = boundsOfIds(doc, sectionIds(doc, targetId))!;
  const x = section.position.x + section.size.width + SPACING.near;
  const previous = arrangedOn(doc, targetId, "details");
  const below = previous.length ? boundsOfIds(doc, previous.flatMap((id) => flowIds(doc, id))) : undefined;
  const y = below ? below.position.y + below.size.height + SPACING.near : section.position.y;
  return firstFree(doc, at(x, y, size));
}

/** Desce até não encostar em nada. */
function firstFree(doc: FlowDoc, rect: Rect): Rect {
  let candidate = rect;
  for (let i = 0; i < 400 && doc.canvas.objects.some((o) => overlaps(candidate, o, SPACING.together / 2)); i++) {
    candidate = at(candidate.position.x, candidate.position.y + SPACING.near, candidate.size);
  }
  return candidate;
}
