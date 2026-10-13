// O formato híbrido do show_diagram: o desenho vem em texto curto, no estilo do Mermaid, e as evidências
// de cada nó em JSON ao lado. Daqui saem os nós e ligações que o resto do plano já entende.
// Gramática (docs/funcionalidades/12-tipos-de-diagrama.md):
//   nó:          id[Rótulo]   ou   id[Rótulo]:tipo        (só id: o rótulo é o id)
//   ligação:     a --> b : rótulo      (a -.-> b é ligação suposta, igual sem "seen")
//   layers:      "layer Nome" abre uma faixa; os nós seguintes são dela (de cima para baixo)
//   sequence:    "participant id[Rótulo]" na ordem das colunas; a ->> b : mensagem; a -->> b : retorno
//   tree:        um nó por linha; o recuo diz quem contém quem
import type { ShowDiagramEdge, ShowDiagramInput, ShowDiagramNode } from "./types.js";

export interface NodeEvidence {
  kind?: string;
  unit?: string;
  path?: string;
  seen?: string;
}

const NODE = /^([A-Za-z_][\w.-]*)(?:\[([^\]]+)\])?(?::([a-z_]+))?$/;
const LINK = /^(.+?)\s*(-->>|->>|-\.->|-->)\s*(.+?)(?:\s*:\s*(.*))?$/;

export class SourceError extends Error {}

/** Nós e ligações descritos pelo texto, com as evidências por id de nó. */
export function parseSource(kind: ShowDiagramInput["kind"], source: string, evidence: Record<string, NodeEvidence> = {}): { nodes: ShowDiagramNode[]; edges: ShowDiagramEdge[] } {
  const nodes = new Map<string, ShowDiagramNode>();
  const edges: ShowDiagramEdge[] = [];
  const parents: { indent: number; id: string }[] = [];
  let layer: string | undefined;

  const node = (text: string, line: number): string => {
    const m = NODE.exec(text.trim());
    if (!m) throw new SourceError(`linha ${line}: '${text.trim()}' não é um nó (use id[Rótulo]).`);
    const [, id, label, nodeKind] = m as unknown as [string, string, string | undefined, string | undefined];
    const old = nodes.get(id);
    const found = evidence[id] ?? {};
    const next: ShowDiagramNode = {
      ...old,
      id,
      label: label?.trim() ?? old?.label ?? id,
      ...(nodeKind ?? old?.kind ?? found.kind ? { kind: nodeKind ?? old?.kind ?? found.kind } : {}),
      ...(found.unit ? { unit: found.unit } : {}),
      ...(found.path ? { path: found.path } : {}),
      ...(found.seen ? { seen: found.seen } : {}),
      ...(old?.layer ?? layer ? { layer: old?.layer ?? layer } : {}),
    };
    nodes.set(id, next);
    return id;
  };

  source.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const text = raw.replace(/%%.*$/, "").trimEnd();
    if (!text.trim()) return;
    const trimmed = text.trim();
    const layerHead = /^layer\s+(.+)$/i.exec(trimmed);
    if (layerHead) {
      if (kind !== "layers") throw new SourceError(`linha ${line}: 'layer' só vale em diagramas layers.`);
      layer = layerHead[1]!.trim();
      return;
    }
    const participant = /^(?:participant|actor)\s+(.+)$/i.exec(trimmed);
    if (participant) {
      node(participant[1]!, line);
      return;
    }
    const link = LINK.exec(trimmed);
    if (link) {
      const [, a, arrow, b, label] = link as unknown as [string, string, string, string, string | undefined];
      const from = node(a, line);
      const to = node(b, line);
      const ev = evidence[`${from}->${to}`] as { seen?: unknown; type?: unknown } | undefined;
      edges.push({
        from,
        to,
        ...(label?.trim() ? { label: label.trim() } : {}),
        ...(typeof ev?.type === "string" ? { type: ev.type } : {}),
        ...(arrow !== "-.->" && ev?.seen === true ? { seen: true } : {}),
        ...(kind === "sequence" ? { order: edges.length + 1 } : {}),
        ...(arrow === "-->>" ? { reply: true } : {}),
      });
      return;
    }
    const id = node(trimmed, line);
    if (kind === "tree") {
      const indent = text.length - text.trimStart().length;
      while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
      const parent = parents.at(-1);
      if (parent) edges.push({ from: parent.id, to: id, type: "contains" });
      parents.push({ indent, id });
    }
  });

  if (!nodes.size) throw new SourceError("o texto não tem nenhum nó.");
  const missing = Object.keys(evidence).filter((k) => !k.includes("->") && !nodes.has(k));
  if (missing.length) throw new SourceError(`evidence cita nós que não estão no texto: ${missing.join(", ")}.`);
  if (kind === "sequence" && !edges.length) throw new SourceError("um diagrama sequence precisa de mensagens (a ->> b : mensagem).");
  if (kind === "layers" && [...nodes.values()].some((n) => !n.layer)) throw new SourceError("em layers, todo nó fica dentro de uma faixa: escreva 'layer Nome' antes dos nós.");
  return { nodes: [...nodes.values()], edges };
}
