// mark_diagram: marca nós de um diagrama sem redesenhá-lo (docs/funcionalidades/16-fluxo-end-to-end.md).
// Na especificação, a diferença em relação à base (novo, muda, remove); na implementação, o status dos
// critérios de aceite no próprio diagrama de origem (pendente, passou, falhou).
import type { ConversationTool } from "./tool.js";

export const MARKS = ["novo", "muda", "remove", "pendente", "passou", "falhou"] as const;
export type NodeMark = (typeof MARKS)[number];

export const markDiagram: ConversationTool = {
  name: "mark_diagram",
  description:
    "Colors boxes of an existing diagram without redrawing it. In a specification layer that changes the current system, mark what the change adds (novo), changes (muda) or takes out (remove); unmarked boxes stay as they are. In an implementation layer, mark the boxes an acceptance criterion comes from with its status: pendente, passou or falhou. null clears a mark. The diagram can be in any layer.",
  runsBatch: true,
  inputSchema: () => ({
    type: "object",
    required: ["diagramId", "marks"],
    properties: {
      diagramId: { type: "string", description: "dgm_ id of a diagram in <workspace>." },
      marks: {
        type: "object",
        description: 'By node id (the nd_ id from <workspace> or from the show_diagram result) or by the box label: {"nd_salva": "passou", "nd_valida": "falhou"}.',
        additionalProperties: { anyOf: [{ enum: [...MARKS] }, { type: "null" }] },
      },
    },
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const diagramId = String(input.diagramId ?? "");
    const diagram = ctx.snapshot().diagrams.find((d) => d.id === diagramId);
    if (!diagram) throw new Error(`O diagrama ${diagramId} não existe.`);
    const marks = (input.marks ?? {}) as Record<string, NodeMark | null>;
    const missing: string[] = [];
    const ops = Object.entries(marks).flatMap(([ref, mark]) => {
      const node = diagram.nodes.find((n) => n.id === ref || n.id === `nd_${ref}`) ?? diagram.nodes.find((n) => n.label.toLowerCase() === ref.toLowerCase());
      if (!node) return missing.push(ref), [];
      if (mark !== null && !MARKS.includes(mark)) throw new Error(`Marca desconhecida: ${String(mark)}.`);
      const { mark: _old, ...rest } = (node.attributes ?? {}) as Record<string, unknown>;
      return [{ op: "update_node", nodeId: node.id, set: { attributes: mark ? { ...rest, mark } : rest } }];
    });
    if (!ops.length) throw new Error(`Nenhum destes nós está no diagrama: ${missing.join(", ")}.`);
    const result = await ctx.runBatch({
      intent: `Marcar ${ops.length === 1 ? "um nó" : `${ops.length} nós`} de ${diagram.title}`.slice(0, 200),
      steps: [{ id: "mark", operation: "diagram.apply_patch", arguments: { diagramId, ops } }],
    });
    return { ...result, ...(missing.length ? { notes: [`Não achei no diagrama: ${missing.join(", ")}.`] } : {}) };
  },
};

/** Ao redesenhar um nó, a marca que ele já tinha continua (o desenho não sabe de marcas). */
export function keepMark(old: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const mark = old?.mark;
  if (mark === undefined || next?.mark !== undefined) return next;
  return { ...next, mark };
}
