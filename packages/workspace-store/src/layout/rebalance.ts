// Reorganização (docs/funcionalidades/13-layout-semantico.md): refaz a disposição das explicações pelas relações
// (colado, embaixo, à direita) e devolve só o plano de movimentos. Quem aplica é a operação canvas.rebalance;
// quem anima é o canvas. Sem dependências de Node.
import type { CanvasObject, Point, Rect } from "@open-semantic/protocol";

import { SPACING, annotations, arrangedOn, arrangementOf, rectOf, type FlowDoc } from "./flow.js";
import { overlaps } from "./placement.js";

export interface Move {
  objectId: string;
  from: Point;
  to: Point;
}

export interface RebalanceOptions {
  /** Só estes objetos podem mudar de lugar (a camada ativa). Ausente: todos. */
  scope?: ReadonlySet<string>;
  /** Também os que o usuário pôs à mão ("reorganizar tudo"). */
  all?: boolean;
}

/** Abaixo disso (soma dos deslocamentos, em px) a reorganização automática não vale o movimento. */
export const REBALANCE_THRESHOLD = 120;

export const displacement = (moves: Move[]) => moves.reduce((sum, m) => sum + Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), 0);

/** O plano de movimentos; vazio quando tudo já está no lugar. */
export function planRebalance(doc: FlowDoc, options: RebalanceOptions = {}): Move[] {
  return new Planner(doc, options).run();
}

class Planner {
  private readonly planned = new Map<string, Point>();
  private readonly flow: Set<string>;
  private readonly obstacles: CanvasObject[];

  constructor(
    private readonly doc: FlowDoc,
    private readonly options: RebalanceOptions,
  ) {
    const arranged = doc.canvas.objects.filter((o) => arrangementOf(doc, o.id) && rectOf(doc, arrangementOf(doc, o.id)!.targetId));
    this.flow = new Set([...arranged.map((o) => o.id), ...arranged.map((o) => arrangementOf(doc, o.id)!.targetId)]);
    this.obstacles = doc.canvas.objects.filter((o) => !this.flow.has(o.id));
  }

  run(): Move[] {
    const roots = [...this.flow].filter((id) => !this.flow.has(arrangementOf(this.doc, id)?.targetId ?? ""));
    for (const root of roots) this.visit(root, this.object(root).position);
    return [...this.planned]
      .map(([objectId, to]) => ({ objectId, from: this.object(objectId).position, to }))
      .filter((m) => Math.abs(m.to.x - m.from.x) > 1 || Math.abs(m.to.y - m.from.y) > 1);
  }

  private object(id: string): CanvasObject {
    return this.doc.canvas.objects.find((o) => o.id === id)!;
  }

  private movable(id: string): boolean {
    const o = this.object(id);
    return (!this.options.scope || this.options.scope.has(id)) && (this.options.all || o.placedBy !== "user");
  }

  /** O lugar pedido, ou o atual quando o objeto não pode mudar (fora da camada, posto à mão, ou bateria em algo). */
  private settle(id: string, wanted: Point): Point {
    const o = this.object(id);
    const rect: Rect = { position: wanted, size: o.size };
    const free = !this.obstacles.some((x) => overlaps(rect, x, SPACING.together / 2));
    const where = this.movable(id) && free ? wanted : o.position;
    this.planned.set(id, where);
    return where;
  }

  /** Altura do que fica colado acima do objeto. */
  private aboveHeight(id: string): number {
    return annotations(this.doc, id, "above").reduce((h, a) => h + this.object(a).size.height + SPACING.together, 0);
  }

  /** Dispõe o objeto, seus textos, os detalhes à direita e a continuação embaixo; devolve onde a explicação termina. */
  private visit(id: string, wanted: Point): number {
    if (this.planned.has(id)) return wanted.y;
    const pos = this.settle(id, wanted);
    const { size } = this.object(id);
    let top = pos.y;
    for (const a of annotations(this.doc, id, "above")) {
      top -= SPACING.together + this.object(a).size.height;
      this.settle(a, { x: pos.x, y: top });
    }
    let bottom = pos.y + size.height;
    let right = pos.x + size.width;
    for (const a of annotations(this.doc, id, "below")) {
      const placed = this.settle(a, { x: pos.x, y: bottom + SPACING.together });
      bottom = placed.y + this.object(a).size.height;
      right = Math.max(right, placed.x + this.object(a).size.width);
    }
    const detailsBottom = this.visitDetails(id, { x: right + SPACING.near, y: top }, bottom);
    let end = detailsBottom;
    for (const c of arrangedOn(this.doc, id, "continues")) end = this.visit(c, { x: pos.x, y: end + SPACING.near + this.aboveHeight(c) });
    return end;
  }

  private visitDetails(id: string, start: Point, bottom: number): number {
    let y = start.y;
    let end = bottom;
    for (const d of arrangedOn(this.doc, id, "details")) {
      const dEnd = this.visit(d, { x: start.x, y: y + this.aboveHeight(d) });
      y = dEnd + SPACING.near;
      end = Math.max(end, dEnd);
    }
    return end;
  }
}
