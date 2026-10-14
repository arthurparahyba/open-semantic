// A camada de implementação vira um markdown em `specs/` do repositório (docs/funcionalidades/16-fluxo-end-to-end.md).
// Conversão determinística, sem modelo: só reorganiza o que está na camada (blocos e diagramas, na ordem de leitura
// que o layout semântico usa no canvas),
// sem inventar conteúdo. O arquivo é regerado a cada mudança e é o que um agente de código recebe para implementar.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Block, DiagramModel, Layer, WorkspaceSnapshot } from "@open-semantic/protocol";

import { documentOrder } from "./layout/flow.js";
import { SPEC_LAYER, isSpecLayer, specPath } from "./specName.js";

export { SPECS_DIR, handoffPrompt, isSpecLayer, specPath, specSlug } from "./specName.js";

type Node = DiagramModel["nodes"][number];
type Edge = DiagramModel["edges"][number];

/** Arquivos de especificação por projeto: caminho relativo à raiz e texto. */
export function specFiles(snapshot: WorkspaceSnapshot): Map<string, { path: string; text: string }[]> {
  const files = new Map<string, { path: string; text: string }[]>();
  for (const layer of snapshot.layers ?? []) {
    if (!isSpecLayer(layer)) continue;
    const projectId = projectOf(snapshot, layer);
    if (!projectId) continue;
    const list = files.get(projectId) ?? [];
    list.push({ path: specPath(layer), text: renderSpec(snapshot, layer) });
    files.set(projectId, list);
  }
  return files;
}

function projectOf(snapshot: WorkspaceSnapshot, layer: Layer): string | undefined {
  const ids = [...layer.members.map((m) => m.id), ...layer.anchors];
  for (const id of ids) {
    const owner = snapshot.diagrams.find((d) => d.id === id)?.projectId ?? (snapshot.blocks ?? []).find((b) => b.id === id)?.projectId;
    if (owner) return owner;
  }
  const parent = layer.parentId ? (snapshot.layers ?? []).find((l) => l.id === layer.parentId) : undefined;
  return parent ? projectOf(snapshot, parent) : undefined;
}

/** O markdown da camada: título, aviso de arquivo gerado, o conteúdo na ordem de leitura e os diagramas da especificação. */
export function renderSpec(snapshot: WorkspaceSnapshot, layer: Layer): string {
  const out = [`# ${layer.name.replace(SPEC_LAYER, "") || layer.name}`, "", `> Gerado pelo Open Semantic a partir da camada "${layer.name}". Não edite à mão: o arquivo é regerado quando a camada muda.`];
  if (layer.description) out.push("", layer.description);
  for (const item of inReadingOrder(snapshot, layer.members.map((m) => m.id))) out.push("", ...render(item));
  const parent = layer.parentId ? (snapshot.layers ?? []).find((l) => l.id === layer.parentId) : undefined;
  const specDiagrams = parent ? inReadingOrder(snapshot, parent.members.map((m) => m.id)).filter((i) => i.kind === "diagram") : [];
  if (specDiagrams.length) {
    out.push("", `## Diagramas da especificação (camada "${parent!.name}")`);
    for (const item of specDiagrams) out.push("", ...render(item, 3));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

type Item = { kind: "block"; block: Block } | { kind: "diagram"; diagram: DiagramModel };

/** A mesma ordem que o layout semântico usa no canvas (título, objeto, notas, detalhes, continuação), não as coordenadas. */
function inReadingOrder(snapshot: WorkspaceSnapshot, ids: string[]): Item[] {
  return documentOrder(snapshot, ids).flatMap<Item>((id) => {
    const diagram = snapshot.diagrams.find((d) => d.id === id);
    if (diagram) return [{ kind: "diagram", diagram }];
    const block = (snapshot.blocks ?? []).find((b) => b.id === id);
    return block ? [{ kind: "block", block }] : [];
  });
}

function render(item: Item, level = 2): string[] {
  return item.kind === "block" ? renderBlock(item.block) : renderDiagram(item.diagram, level);
}

function renderBlock(b: Block): string[] {
  const title = b.title ? [`**${b.title}**`, ""] : [];
  if (b.kind === "heading") return [`## ${b.title ?? ""}`.trimEnd(), ...(b.text ? ["", b.text] : [])];
  if (b.kind === "text") return [...title, b.text ?? ""];
  if (b.kind === "list") return [...title, ...(b.items ?? []).map((item, i) => (b.ordered ? `${i + 1}. ${item}` : `- ${item}`))];
  const columns = b.columns ?? [];
  const rows = (b.rows ?? []) as string[][];
  if (!columns.length) return [...title, ...rows.map((r) => `- ${r.join(" · ")}`)];
  const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [...title, `| ${columns.map(cell).join(" | ")} |`, `|${columns.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${columns.map((_, i) => cell(r[i])).join(" | ")} |`)];
}

function renderDiagram(d: DiagramModel, level: number): string[] {
  const head = [`${"#".repeat(level)} ${d.title}`, ...(d.caption ? ["", d.caption] : [])];
  const marks = marksOf(d);
  const body = d.kind === "sequence" ? mermaid(sequence(d)) : d.kind === "er" ? mermaid(er(d)) : d.kind === "wireframe" || d.kind === "tree" ? outline(d) : mermaid(flowchart(d));
  return [...head, "", ...body, ...(marks.length ? ["", ...marks] : [])];
}

const mermaid = (lines: string[]) => ["```mermaid", ...lines, "```"];
const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
const short = (id: string) => id.replace(/^nd_/, "").replace(/[^A-Za-z0-9_]/g, "_");

/** bpmn, flow, architecture, dependency e layers: um flowchart; raias e faixas viram subgraphs. */
function flowchart(d: DiagramModel): string[] {
  const direction = d.kind === "bpmn" || d.layout.direction === "LR" ? "LR" : "TD";
  const shape = (n: Node) => {
    const label = quote(n.label);
    if (d.kind === "bpmn" && /^(start|end|inicio|fim)$/.test(n.kind)) return `${short(n.id)}((${label}))`;
    if (d.kind === "bpmn" && n.kind === "gateway") return `${short(n.id)}{${label}}`;
    if (n.kind === "data_store") return `${short(n.id)}[(${label})]`;
    return `${short(n.id)}[${label}]`;
  };
  const lines = [`flowchart ${direction}`];
  const groups = new Map<string, Node[]>();
  for (const n of d.nodes) {
    const group = typeof n.attributes?.layer === "string" ? n.attributes.layer : "";
    groups.set(group, [...(groups.get(group) ?? []), n]);
  }
  let g = 0;
  for (const [group, nodes] of groups) {
    if (group) lines.push(`  subgraph g${++g}[${quote(group)}]`);
    for (const n of nodes) lines.push(`${group ? "    " : "  "}${shape(n)}`);
    if (group) lines.push("  end");
  }
  for (const e of d.edges) lines.push(`  ${short(e.sourceNodeId)} -->${e.label ? `|${quote(e.label)}|` : ""} ${short(e.targetNodeId)}`);
  return lines;
}

function sequence(d: DiagramModel): string[] {
  const order = (e: Edge) => (typeof e.attributes?.order === "number" ? e.attributes.order : 0);
  return [
    "sequenceDiagram",
    ...d.nodes.map((n) => `  participant ${short(n.id)} as ${n.label.replace(/[;:]/g, " ")}`),
    ...[...d.edges].sort((a, b) => order(a) - order(b)).map((e) => `  ${short(e.sourceNodeId)}${e.attributes?.reply ? "-->>" : "->>"}${short(e.targetNodeId)}: ${(e.label ?? "").replace(/[;]/g, ",")}`),
  ];
}

function er(d: DiagramModel): string[] {
  const name = (n: Node) => n.label.replace(/[^A-Za-z0-9_]/g, "_");
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const lines = ["erDiagram"];
  for (const n of d.nodes) {
    const columns = Array.isArray(n.attributes?.columns) ? (n.attributes.columns as string[]) : [];
    if (!columns.length) {
      lines.push(`  ${name(n)} {`, "  }");
      continue;
    }
    lines.push(`  ${name(n)} {`);
    for (const c of columns) {
      const [field = "", type = "string", ...rest] = c.trim().split(/\s+/);
      const key = rest.find((r) => /^(PK|FK|UK)$/i.test(r));
      lines.push(`    ${type.replace(/[^A-Za-z0-9_()]/g, "_")} ${field.replace(/[^A-Za-z0-9_]/g, "_")}${key ? ` ${key.toUpperCase()}` : ""}`);
    }
    lines.push("  }");
  }
  for (const e of d.edges) {
    const a = byId.get(e.sourceNodeId);
    const b = byId.get(e.targetNodeId);
    if (a && b) lines.push(`  ${name(a)} ${cardinality(e.label)} ${name(b)} : ${quote(e.label ?? "relaciona")}`);
  }
  return lines;
}

function cardinality(label = ""): string {
  const l = label.replace(/\s/g, "").toUpperCase();
  if (/^(N|\*)\.\.(N|\*)$|^N:N$|^M:N$/.test(l)) return "}o--o{";
  if (/^1\.\.1$|^1:1$/.test(l)) return "||--||";
  return "||--o{";
}

/** Wireframe e árvore: uma lista aninhada, cada elemento com o seu tipo. */
function outline(d: DiagramModel): string[] {
  const parentOf = new Map<string, string>();
  for (const n of d.nodes) if (typeof n.attributes?.parent === "string") parentOf.set(n.id, n.attributes.parent);
  for (const e of d.edges) if (e.kind === "contains" || d.kind === "tree") parentOf.set(e.targetNodeId, e.sourceNodeId);
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const n of d.nodes.filter((x) => parentOf.get(x.id) === parent)) {
      lines.push(`${"  ".repeat(depth)}- ${n.label} (${n.kind})`);
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines;
}

const MARK_LABEL: Record<string, string> = { novo: "novo", muda: "muda", remove: "sai", pendente: "pendente", passou: "passou", falhou: "falhou" };

/** As marcas do diagrama (diferença em relação à base, status dos critérios) como lista. */
function marksOf(d: DiagramModel): string[] {
  const marked = d.nodes.filter((n) => typeof n.attributes?.mark === "string" && MARK_LABEL[n.attributes.mark as string]);
  return marked.map((n) => `- ${n.label}: ${MARK_LABEL[n.attributes!.mark as string]}`);
}

/** Grava os arquivos de especificação que mudaram (o texto que o app gravou por último fica em memória). */
export class SpecWriter {
  private readonly known = new Map<string, string>();

  async write(rootPath: string, files: { path: string; text: string }[]): Promise<string[]> {
    const written: string[] = [];
    for (const { path, text } of files) {
      const file = join(rootPath, path);
      if (this.known.get(file) === text) continue;
      if ((await readFile(file, "utf8").catch(() => undefined)) !== text) {
        await mkdir(join(file, ".."), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, text, "utf8");
        await rename(tmp, file);
        written.push(file);
      }
      this.known.set(file, text);
    }
    return written;
  }
}
