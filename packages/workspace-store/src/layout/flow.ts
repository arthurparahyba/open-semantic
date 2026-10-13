// Relações de layout entre diagramas e blocos (docs/funcionalidades/13-layout-semantico.md).
// Quem cria diz a relação (annotates, continues, details); daqui sai o que está ligado a quê no canvas.
// Sem dependências de Node: a interface usa as mesmas regras.
import type { Arrangement, Block, DiagramModel, Rect, WorkspaceSnapshot } from "@open-semantic/protocol";

/** As três distâncias: junto (um objeto e seus textos), próximo (mesma explicação), separado (assuntos diferentes). */
export const SPACING = { together: 16, near: 48, apart: 160 } as const;

export type FlowDoc = Pick<WorkspaceSnapshot, "canvas" | "diagrams"> & { blocks?: Block[] };

type Relation = Arrangement["relation"];

export function arrangementOf(doc: FlowDoc, id: string): Arrangement | undefined {
  const item: Pick<DiagramModel | Block, "arrangement"> | undefined = doc.diagrams.find((d) => d.id === id) ?? doc.blocks?.find((b) => b.id === id);
  return item?.arrangement;
}

export function rectOf(doc: FlowDoc, id: string): Rect | undefined {
  const o = doc.canvas.objects.find((x) => x.id === id);
  return o && { position: o.position, size: o.size };
}

/** Quem tem a relação com o alvo, na ordem em que entrou no canvas. */
export function arrangedOn(doc: FlowDoc, targetId: string, relation: Relation): string[] {
  return doc.canvas.objects
    .map((o) => o.id)
    .filter((id) => {
      const a = arrangementOf(doc, id);
      return a?.targetId === targetId && a.relation === relation;
    });
}

/** Blocos colados ao alvo de um lado. Acima, o primeiro é o mais perto do alvo. */
export function annotations(doc: FlowDoc, targetId: string, side: "above" | "below"): string[] {
  return arrangedOn(doc, targetId, "annotates").filter((id) => (arrangementOf(doc, id)?.side ?? "above") === side);
}

/** O objeto e tudo que está colado nele (inclusive o que está colado nos blocos colados). */
export function sectionIds(doc: FlowDoc, id: string, seen = new Set<string>()): string[] {
  if (seen.has(id)) return [];
  seen.add(id);
  return [id, ...arrangedOn(doc, id, "annotates").flatMap((a) => sectionIds(doc, a, seen))];
}

/** O objeto, o que está colado nele e, recursivamente, o que o continua ou detalha. */
export function flowIds(doc: FlowDoc, id: string, seen = new Set<string>()): string[] {
  const own = sectionIds(doc, id, seen);
  const next = [...arrangedOn(doc, id, "details"), ...arrangedOn(doc, id, "continues")].filter((x) => !seen.has(x));
  return [...own, ...next.flatMap((x) => flowIds(doc, x, seen))];
}

export function boundsOf(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.position.x));
  const minY = Math.min(...rects.map((r) => r.position.y));
  const maxX = Math.max(...rects.map((r) => r.position.x + r.size.width));
  const maxY = Math.max(...rects.map((r) => r.position.y + r.size.height));
  return { position: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } };
}

/** Retângulo que envolve os ids que estão no canvas. */
export function boundsOfIds(doc: FlowDoc, ids: string[]): Rect | undefined {
  const rects = ids.map((id) => rectOf(doc, id)).filter((r): r is Rect => r !== undefined);
  return rects.length ? boundsOf(rects) : undefined;
}

/** O objeto de onde a cadeia de relações parte (o próprio, se não tiver relação). Protegido contra ciclos. */
export function flowRoot(doc: FlowDoc, id: string): string {
  const seen = new Set([id]);
  let current = id;
  for (let a = arrangementOf(doc, current); a && rectOf(doc, a.targetId) && !seen.has(a.targetId); a = arrangementOf(doc, current)) {
    current = a.targetId;
    seen.add(current);
  }
  return current;
}
