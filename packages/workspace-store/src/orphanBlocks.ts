// Blocos de explicação cujo alvo saiu (docs/funcionalidades/13-layout-semantico.md): colados ao alvo (annotates)
// saem junto; quem continuava ou detalhava o alvo perde só a relação. Usado ao tirar um projeto e ao abrir o workspace.
import type { Block, DiagramModel, WorkspaceSnapshot } from "@open-semantic/protocol";

type Arranged = Pick<Block | DiagramModel, "arrangement">;

const withoutArrangement = <T extends Arranged>({ arrangement: _gone, ...item }: T): T => item as T;

/** Tira os blocos órfãos e as relações quebradas, em cópias novas; devolve quantos blocos saíram. */
export function dropOrphanBlocks(doc: WorkspaceSnapshot): number {
  const projects = new Set(doc.projects.map((p) => p.id));
  let blocks = (doc.blocks ?? []).filter((b) => !b.projectId || projects.has(b.projectId));
  // Um bloco colado em outro bloco que saiu também sai: repete até estabilizar.
  for (let changed = true; changed; ) {
    const alive = new Set([...doc.diagrams.map((d) => d.id), ...blocks.map((b) => b.id)]);
    const next = blocks.filter((b) => b.arrangement?.relation !== "annotates" || alive.has(b.arrangement.targetId));
    changed = next.length !== blocks.length;
    blocks = next;
  }
  const alive = new Set([...doc.diagrams.map((d) => d.id), ...blocks.map((b) => b.id)]);
  const unlink = <T extends Arranged>(item: T): T => (item.arrangement && !alive.has(item.arrangement.targetId) ? withoutArrangement(item) : item);
  const removed = (doc.blocks ?? []).length - blocks.length;
  doc.blocks = blocks.map(unlink);
  doc.diagrams = doc.diagrams.map(unlink);
  doc.canvas.objects = doc.canvas.objects.filter((o) => o.objectKind !== "block" || alive.has(o.id));
  return removed;
}
