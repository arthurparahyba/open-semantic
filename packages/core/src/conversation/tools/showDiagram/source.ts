// O formato híbrido do show_diagram: o desenho vem em texto curto, no estilo do Mermaid, e as evidências
// de cada nó em JSON ao lado. Daqui saem os nós e ligações que o resto do plano já entende.
// Gramática (docs/funcionalidades/12-tipos-de-diagrama.md):
//   nó:          id[Rótulo]   ou   id[Rótulo]:tipo        (só id: o rótulo é o id)
//   ligação:     a --> b : rótulo      (a -.-> b é ligação suposta, igual sem "seen")
//   layers:      "layer Nome" abre uma faixa; os nós seguintes são dela (de cima para baixo)
//   sequence:    "participant id[Rótulo]" na ordem das colunas; a ->> b : mensagem; a -->> b : retorno
//   tree:        um nó por linha; o recuo diz quem contém quem
//   wireframe:   um elemento da tela por linha (id[Rótulo]:tipo); o recuo diz dentro de quem ele está
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
  const reader = new SourceReader(kind, evidence);
  source.split("\n").forEach((raw, i) => reader.line(raw.replace(/%%.*$/, "").trimEnd(), i + 1));
  return reader.result();
}

class SourceReader {
  private readonly nodes = new Map<string, ShowDiagramNode>();
  private readonly edges: ShowDiagramEdge[] = [];
  private readonly parents: { indent: number; id: string }[] = [];
  private layer: string | undefined;

  constructor(
    private readonly kind: ShowDiagramInput["kind"],
    private readonly evidence: Record<string, NodeEvidence>,
  ) {}

  line(text: string, line: number) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const layerHead = /^layer\s+(.+)$/i.exec(trimmed);
    if (layerHead) return this.openLayer(layerHead[1]!.trim(), line);
    const participant = /^(?:participant|actor)\s+(.+)$/i.exec(trimmed);
    if (participant) return void this.node(participant[1]!, line);
    const link = LINK.exec(trimmed);
    if (link) return this.link(link as unknown as [string, string, string, string, string | undefined], line);
    const id = this.node(trimmed, line);
    const indent = text.length - text.trimStart().length;
    if (this.kind === "tree") this.nest(id, indent);
    if (this.kind === "wireframe") this.place(id, indent);
  }

  private openLayer(name: string, line: number) {
    if (this.kind !== "layers") throw new SourceError(`linha ${line}: 'layer' só vale em diagramas layers.`);
    this.layer = name;
  }

  /** Um nó novo, ou o mesmo nó citado de novo (o rótulo e o tipo novos valem). */
  private node(text: string, line: number): string {
    const m = NODE.exec(text.trim());
    if (!m) throw new SourceError(`linha ${line}: '${text.trim()}' não é um nó (use id[Rótulo]).`);
    const [, id, label, nodeKind] = m as unknown as [string, string, string | undefined, string | undefined];
    const old = this.nodes.get(id);
    const found = this.evidence[id] ?? {};
    const kind = nodeKind ?? old?.kind ?? found.kind;
    const layer = old?.layer ?? this.layer;
    this.nodes.set(id, {
      ...old,
      id,
      label: label?.trim() ?? old?.label ?? id,
      ...(kind ? { kind } : {}),
      ...pick(found, ["unit", "path", "seen"]),
      ...(layer ? { layer } : {}),
    });
    return id;
  }

  private link([, a, arrow, b, label]: [string, string, string, string, string | undefined], line: number) {
    const from = this.node(a, line);
    const to = this.node(b, line);
    const ev = this.evidence[`${from}->${to}`] as { seen?: unknown; type?: unknown } | undefined;
    this.edges.push({
      from,
      to,
      ...(label?.trim() ? { label: label.trim() } : {}),
      ...(typeof ev?.type === "string" ? { type: ev.type } : {}),
      ...(arrow !== "-.->" && ev?.seen === true ? { seen: true } : {}),
      ...(this.kind === "sequence" ? { order: this.edges.length + 1 } : {}),
      ...(arrow === "-->>" ? { reply: true } : {}),
    });
  }

  /** Na árvore, o recuo diz quem contém quem. */
  private nest(id: string, indent: number) {
    while (this.parents.length && this.parents.at(-1)!.indent >= indent) this.parents.pop();
    const parent = this.parents.at(-1);
    if (parent) this.edges.push({ from: parent.id, to: id, type: "contains" });
    this.parents.push({ indent, id });
  }

  /** No wireframe, o recuo põe o elemento dentro do anterior menos recuado; não vira ligação. */
  private place(id: string, indent: number) {
    while (this.parents.length && this.parents.at(-1)!.indent >= indent) this.parents.pop();
    const parent = this.parents.at(-1);
    if (parent) this.nodes.set(id, { ...this.nodes.get(id)!, parent: parent.id });
    this.parents.push({ indent, id });
  }

  result(): { nodes: ShowDiagramNode[]; edges: ShowDiagramEdge[] } {
    if (!this.nodes.size) throw new SourceError("o texto não tem nenhum nó.");
    const missing = Object.keys(this.evidence).filter((k) => !k.includes("->") && !this.nodes.has(k));
    if (missing.length) throw new SourceError(`evidence cita nós que não estão no texto: ${missing.join(", ")}.`);
    if (this.kind === "sequence" && !this.edges.length) throw new SourceError("um diagrama sequence precisa de mensagens (a ->> b : mensagem).");
    if (this.kind === "wireframe" && this.edges.length) throw new SourceError("wireframe não tem setas: use o recuo para pôr um elemento dentro do outro.");
    if (this.kind === "layers" && [...this.nodes.values()].some((n) => !n.layer)) {
      throw new SourceError("em layers, todo nó fica dentro de uma faixa: escreva 'layer Nome' antes dos nós.");
    }
    return { nodes: [...this.nodes.values()], edges: this.edges };
  }
}

/** Só os campos de texto preenchidos. */
function pick(from: NodeEvidence, keys: (keyof NodeEvidence)[]): Partial<NodeEvidence> {
  return Object.fromEntries(keys.filter((k) => typeof from[k] === "string" && from[k]).map((k) => [k, from[k]]));
}
