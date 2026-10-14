// Fluxo de camadas garantido pelo app, não pelo modelo (docs/funcionalidades/16-fluxo-end-to-end.md):
// o planejamento de uma funcionalidade nova abre "Especificação: <assunto>" sobre a base, e a implementação
// abre "Implementação: <assunto>" como filha dela. A camada fica ativa, então os diagramas novos nascem nela;
// durante o pedido, o modelo não abre outra camada nem puxa diagramas de outras camadas.
import type { Dispatcher, Layer, WorkspaceSnapshot } from "@open-semantic/protocol";

import { asksForPlanning } from "../modes/index.js";
import { normalized, slug } from "./text.js";
import { CLAUDE_AGENT } from "./types.js";

export const SPEC_PREFIX = "Especificação: ";
export const IMPL_PREFIX = "Implementação: ";
const isSpec = (l: Layer) => /^especifica[cç][aã]o\b/i.test(l.name);
const isImpl = (l: Layer) => /^implementa[cç][aã]o\b/i.test(l.name);
const subjectOfLayer = (l: Layer) => l.name.replace(/^[^:]*:\s*/, "") || l.name;

/** Nomes que dizem só "uma funcionalidade"; o assunto vem depois deles. */
const GENERIC = /^(funcionalidade|feature|recurso)s?$/;
const NOUNS = /\b(funcionalidade|feature|recurso|tela|cadastro|crud|modulo|servico|endpoint|api|fluxo|processo)\b/;
/** Onde o assunto acaba: pontuação ou o começo de um detalhe ("com nome e preço", "para o pet shop"). */
const STOP = /[.,;:!?()[\]\n]|\s(com|que|para|onde|usando|incluindo|e depois|desde|comece|começando)\s/i;

/** O assunto de um pedido de funcionalidade nova: "quero especificar uma funcionalidade nova: cadastro de produtos (…)" → "Cadastro de produtos". */
export function specSubject(message: string): string {
  const words = message.trim().split(/\s+/);
  const norm = words.map((w) => normalized(w));
  const i = norm.findIndex((w) => NOUNS.test(w));
  let rest: string[] = [];
  if (i >= 0) {
    let j = GENERIC.test(norm[i]!) ? i + 1 : i;
    // "funcionalidade nova: cadastro", "funcionalidade de cadastro": pula o adjetivo e a preposição.
    while (j < words.length && /^(nova|novo|novas|novos|de|do|da)$/.test(norm[j]!) && GENERIC.test(norm[i]!)) j++;
    rest = words.slice(j);
  }
  if (!rest.length) rest = words;
  const text = rest.join(" ").replace(/^[\s:–-]+/, "");
  const cut = text.search(STOP);
  const subject = (cut > 0 ? text.slice(0, cut) : text).split(/\s+/).slice(0, 6).join(" ").trim();
  return subject ? subject[0]!.toUpperCase() + subject.slice(1) : "Funcionalidade nova";
}

/** A camada preparada pelo app para o pedido: o destino dos diagramas, travado até o fim dele. */
export interface PreparedLayer {
  layer: Layer;
  /** draft: primeira etapa da especificação; refine: ajuste dela; impl: camada de implementação. */
  phase: "draft" | "refine" | "impl";
  /** Instrução que vai junto do pedido. */
  hint: string;
}

interface Deps {
  dispatcher: Dispatcher;
  snapshot(): WorkspaceSnapshot;
  newId(): string;
}

/**
 * Antes do modelo: no planejamento de algo novo, abre (ou reabre) a camada de especificação;
 * na implementação, a filha dela. Fora desses modos, ou sem onde ancorar, não faz nada.
 */
export async function prepareLayer(modeId: string, request: string, deps: Deps): Promise<PreparedLayer | undefined> {
  const snap = deps.snapshot();
  const layers = snap.layers ?? [];
  const active = layers.find((l) => l.id === snap.navigation.activeLayerId);
  if (modeId === "planejamento") return prepareSpec(request, snap, active, deps);
  if (modeId === "implementacao") return prepareImpl(snap, active, deps);
  // Qualquer outro pedido com a especificação ativa é um ajuste dela ("adicione um campo na tela").
  return active && isSpec(active) ? locked(active, "refine", snap) : undefined;
}

async function prepareSpec(request: string, snap: WorkspaceSnapshot, active: Layer | undefined, deps: Deps): Promise<PreparedLayer | undefined> {
  const layers = snap.layers ?? [];
  // Continuação de uma etapa: a especificação ativa continua sendo o destino.
  if (!asksForPlanning(request)) return active && isSpec(active) ? locked(active, "refine", snap) : undefined;
  const name = SPEC_PREFIX + specSubject(request);
  const existing = layers.find((l) => isSpec(l) && !l.parentId && normalized(l.name) === normalized(name));
  if (existing) return activate(existing, deps).then((l) => l && locked(l, "draft", snap));
  const anchor = baseAnchor(snap);
  if (!anchor) return undefined;
  const layer = await create(deps, { name, anchors: [anchor] });
  return layer && locked(layer, "draft", snap);
}

async function prepareImpl(snap: WorkspaceSnapshot, active: Layer | undefined, deps: Deps): Promise<PreparedLayer | undefined> {
  const layers = snap.layers ?? [];
  const spec = specOf(layers, active);
  if (!spec) return undefined;
  const child = layers.find((l) => l.parentId === spec.id && isImpl(l));
  if (child) return activate(child, deps).then((l) => l && locked(l, "impl", snap, spec));
  const diagrams = spec.members.filter((m) => m.id.startsWith("dgm_")).map((m) => snap.diagrams.find((d) => d.id === m.id)).filter((d) => d !== undefined);
  const anchor = (diagrams.find((d) => d.kind === "bpmn") ?? diagrams[0])?.id ?? spec.anchors[0];
  if (!anchor) return undefined;
  const layer = await create(deps, { name: IMPL_PREFIX + subjectOfLayer(spec), parentId: spec.id, anchors: [anchor] });
  return layer && locked(layer, "impl", snap, spec);
}


/** A especificação da implementação: a ativa, a mãe da implementação ativa, ou a usada por último. */
function specOf(layers: Layer[], active: Layer | undefined): Layer | undefined {
  if (active && isSpec(active)) return active;
  if (active && isImpl(active) && active.parentId) return layers.find((l) => l.id === active.parentId);
  return layers.filter(isSpec).sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""))[0];
}

/** Âncora na base: a visão geral (arquitetura) se houver, senão o primeiro diagrama fora das camadas. */
function baseAnchor(snap: WorkspaceSnapshot): string | undefined {
  const inLayers = new Set((snap.layers ?? []).flatMap((l) => l.members.map((m) => m.id)));
  const base = snap.diagrams.filter((d) => !inLayers.has(d.id));
  return (base.find((d) => d.kind === "architecture" || d.kind === "layers") ?? base[0])?.id;
}

async function create(deps: Deps, args: { name: string; parentId?: string; anchors: string[] }): Promise<Layer | undefined> {
  const layerId = `lyr_${slug(args.name.replace(/^[^:]*:\s*/, ""), 28)}_${deps.newId().slice(0, 4)}`;
  const result = await deps.dispatcher.dispatch({
    operationId: `act_${deps.newId()}`,
    operation: "layer.create",
    arguments: { layerId, ...args, activate: true },
    authorization: { actor: CLAUDE_AGENT },
  });
  if (result.status !== "succeeded") return undefined;
  return deps.snapshot().layers?.find((l) => l.id === layerId);
}

async function activate(layer: Layer, deps: Deps): Promise<Layer | undefined> {
  if (deps.snapshot().navigation.activeLayerId === layer.id) return layer;
  const result = await deps.dispatcher.dispatch({
    operationId: `act_${deps.newId()}`,
    operation: "layer.activate",
    arguments: { layerId: layer.id },
    authorization: { actor: CLAUDE_AGENT },
  });
  return result.status === "succeeded" ? layer : undefined;
}

function locked(layer: Layer, phase: PreparedLayer["phase"], snap: WorkspaceSnapshot, spec?: Layer): PreparedLayer {
  const rule = "Não chame layer.create, layer.activate nem layer.add_members com diagramas de outras camadas.";
  const where =
    phase === "impl"
      ? `A camada "${layer.name}" (${layer.id}) já está aberta e ativa, filha de "${spec!.name}" (${spec!.id}): os blocos novos entram nela sozinhos. Os diagramas da especificação ficam na camada deles; leia-os de lá.`
      : `A camada "${layer.name}" (${layer.id}) já está aberta e ativa: é a especificação; os diagramas novos entram nela sozinhos.`;
  const task =
    phase === "draft"
      ? " Nesta primeira etapa, desenhe os dois: o processo em bpmn e o wireframe da tela principal."
      : phase === "refine"
        ? ` Este pedido ajusta a especificação. Os artefatos dela: ${artifacts(layer, snap)}. Atualize todos os que o ajuste afeta (a tela, o processo e os textos que descrevem a tela), não só um, e marque com mark_diagram o que entrou (novo) e o que mudou (muda).`
        : "";
  return { layer, phase, hint: `[app] ${where}${task} ${rule}` };
}

function artifacts(layer: Layer, snap: WorkspaceSnapshot): string {
  const ids = new Set(layer.members.map((m) => m.id));
  const diagrams = snap.diagrams.filter((d) => ids.has(d.id)).map((d) => `${d.kind} "${d.title}" (${d.id})`);
  const blocks = (snap.blocks ?? []).filter((b) => ids.has(b.id)).map((b) => `${b.kind} "${b.title ?? b.text?.slice(0, 40) ?? ""}" (${b.id})`);
  return [...diagrams, ...blocks].join("; ") || "nenhum ainda";
}

/**
 * Depois que o modelo respondeu: o que falta para a etapa estar completa. O app cobra uma vez, sem depender
 * de o modelo lembrar: na primeira etapa, bpmn e wireframe; num ajuste, os artefatos da especificação que
 * ficaram para trás e as marcas do que mudou.
 */
export function pendingWork(prepared: PreparedLayer, before: Map<string, number>, snap: WorkspaceSnapshot): string | undefined {
  const layer = (snap.layers ?? []).find((l) => l.id === prepared.layer.id);
  if (!layer || prepared.phase === "impl") return undefined;
  const ids = new Set(layer.members.map((m) => m.id));
  const diagrams = snap.diagrams.filter((d) => ids.has(d.id));
  if (prepared.phase === "draft") {
    const missing = (["bpmn", "wireframe"] as const).filter((k) => !diagrams.some((d) => d.kind === k));
    if (!missing.length) return undefined;
    const what = missing.map((k) => (k === "bpmn" ? "o processo em bpmn" : "o wireframe da tela principal (kind wireframe)")).join(" e ");
    return `[app] Falta na camada de especificação: ${what}. Desenhe agora com show_diagram, sem refazer o que já existe, e termine com a legenda.`;
  }
  const changed = diagrams.filter((d) => before.get(d.id) !== d.revision);
  if (!changed.length) return undefined;
  const behind = diagrams.filter((d) => !changed.includes(d) && (d.kind === "bpmn" || d.kind === "wireframe"));
  const unmarked = changed.filter((d) => !d.nodes.some((n) => ["novo", "muda"].includes(String((n.attributes as Record<string, unknown> | undefined)?.mark))));
  if (!behind.length && !unmarked.length) return undefined;
  const parts = [
    behind.length ? `Você mudou ${changed.map((d) => `"${d.title}"`).join(", ")}, mas ${behind.map((d) => `"${d.title}" (${d.id})`).join(", ")} não mudou: se o ajuste também vale para ele (um passo de validação no processo, um campo novo), atualize-o agora.` : "",
    unmarked.length ? `Marque com mark_diagram o que entrou (novo) e o que mudou (muda) em ${unmarked.map((d) => `"${d.title}" (${d.id})`).join(", ")}.` : "",
  ];
  return `[app] ${parts.filter(Boolean).join(" ")} Se nada mais precisar mudar, só responda.`;
}

/** O que o modelo não pode fazer com as camadas enquanto o app segura o destino. Devolve o motivo da recusa. */
export function layerGuard(prepared: PreparedLayer, snapshot: WorkspaceSnapshot, steps: Record<string, unknown>[]): string | undefined {
  const layers = snapshot.layers ?? [];
  for (const step of steps) {
    const op = String(step.operation ?? "");
    const args = (step.arguments ?? {}) as Record<string, unknown>;
    if (op === "layer.create" || (op === "layer.activate" && args.layerId !== prepared.layer.id))
      return `O app já abriu a camada "${prepared.layer.name}" (${prepared.layer.id}) para este pedido; desenhe nela, sem ${op}.`;
    if (op === "layer.add_members") {
      const ids = ((args.members ?? []) as { id?: string }[]).map((m) => m.id);
      const taken = ids.filter((id) => layers.some((l) => l.id !== args.layerId && l.members.some((m) => m.id === id)));
      if (taken.length) return `Os elementos ${taken.join(", ")} são de outra camada e ficam lá; não os mova.`;
    }
  }
  return undefined;
}
