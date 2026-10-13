// A seção do show_diagram (docs/funcionalidades/13-layout-semantico.md): título e introdução acima do diagrama,
// notas (texto, lista, tabela) embaixo, e a relação com a explicação que já está no canvas.
import type { Arrangement, WorkspaceSnapshot } from "@open-semantic/protocol";

import type { BatchStepInput, SectionNote, ShowDiagramInput } from "./types.js";

/** Ids estáveis dos blocos da seção: chamar de novo com o mesmo diagrama atualiza os mesmos blocos. */
const blockId = (diagramId: string, part: string) => `blk_${diagramId.slice(4, 54)}_${part}`;

/**
 * Onde o diagrama novo entra na explicação: o que o modelo disse (continues/details), ou, por padrão,
 * embaixo do último diagrama do mesmo projeto (a explicação desce, em vez de ir para o lado).
 */
export function arrangementFor(input: ShowDiagramInput, snapshot: WorkspaceSnapshot, projectId: string): Arrangement | undefined {
  const onCanvas = (id: string | undefined) => !!id && snapshot.canvas.objects.some((o) => o.id === id);
  if (onCanvas(input.details)) return { relation: "details", targetId: input.details! };
  if (onCanvas(input.continues)) return { relation: "continues", targetId: input.continues! };
  if (input.about || input.continues || input.details) return undefined;
  const previous = snapshot.diagrams.filter((d) => d.projectId === projectId && d.id !== input.diagramId && onCanvas(d.id)).pop();
  return previous && { relation: "continues", targetId: previous.id };
}

/** Os blocos da seção: cria os que faltam, atualiza os que já existem. Rodam depois do desenho. */
export function sectionSteps(input: ShowDiagramInput, snapshot: WorkspaceSnapshot, dependsOn: string[]): BatchStepInput[] {
  const exists = (id: string) => (snapshot.blocks ?? []).some((b) => b.id === id);
  const wanted: { id: string; content: Record<string, unknown>; side: "above" | "below" }[] = [];
  if (input.heading?.trim() || input.intro?.trim()) {
    const content = input.heading?.trim() ? { kind: "heading", title: input.heading.trim(), ...(input.intro?.trim() ? { text: input.intro.trim() } : {}) } : { kind: "text", text: input.intro!.trim() };
    wanted.push({ id: blockId(input.diagramId, "intro"), content, side: "above" });
  }
  (input.notes ?? []).slice(0, 4).forEach((note, i) => wanted.push({ id: blockId(input.diagramId, `n${i + 1}`), content: noteContent(note), side: "below" }));

  const created = wanted.filter((w) => !exists(w.id));
  const steps: BatchStepInput[] = wanted
    .filter((w) => exists(w.id))
    .map((w, i) => {
      const { kind: _kind, ...set } = w.content;
      return { id: `section_update_${i + 1}`, operation: "block.update", arguments: { blockId: w.id, set }, ...(dependsOn.length ? { dependsOn } : {}) };
    });
  if (created.length) {
    const blocks = created.map((w) => ({ blockId: w.id, ...w.content, arrangement: { relation: "annotates", targetId: input.diagramId, side: w.side } }));
    steps.push({ id: "section", operation: "block.create", arguments: { blocks }, ...(dependsOn.length ? { dependsOn } : {}) });
  }
  return steps;
}

/** Ids dos blocos da seção, para enquadrar junto com o diagrama. */
export function sectionBlockIds(input: ShowDiagramInput): string[] {
  const ids = input.heading?.trim() || input.intro?.trim() ? [blockId(input.diagramId, "intro")] : [];
  return [...ids, ...(input.notes ?? []).slice(0, 4).map((_, i) => blockId(input.diagramId, `n${i + 1}`))];
}

function noteContent(note: SectionNote): Record<string, unknown> {
  const { kind, title, text, items, ordered, columns, rows } = note;
  return {
    kind,
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(kind === "list" ? { items: items ?? [], ...(ordered ? { ordered: true } : {}) } : {}),
    ...(kind === "table" ? { rows: rows ?? [], ...(columns ? { columns } : {}) } : {}),
  };
}
