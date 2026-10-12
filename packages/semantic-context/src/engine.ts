// Motor de contexto semântico (docs/funcionalidades/08-gestao-de-contexto.md).
// analyze() descobre do que a mensagem fala, em milissegundos e sem IA; buildContext() monta o contexto
// enxuto para a IA a partir do mesmo resultado.
import { SearchIndex, type QueryTerm, type TermHit } from "./search.js";
import { Synonyms, estimateTokens, sentences, stripAccents, terms, termsWithRaw } from "./text.js";
import type {
  Assumption,
  Clarification,
  ContentPort,
  ContextItem,
  ContextPack,
  DetailLevel,
  IndexDoc,
  IndexUpdate,
  RecentTopics,
  Relevance,
  TargetRef,
  TokenBudget,
  Topic,
  UnitLink,
  VisualFocus,
} from "./types.js";

/** Tipos de diagrama que mostram mais detalhe de uma interação; vencem na escolha do ponto principal. */
const DETAIL_BY_KIND: Record<string, number> = { sequence: 1.4, flow: 1.25, bpmn: 1.25, architecture: 1, dependency: 0.95, freeform: 0.9 };
const DEAD = new Set(["rejected", "invalid"]);
const EXPLICIT_ID = /\b(?:sem|dgm|nd|edg|mod|rgn)_[A-Za-z0-9_-]{3,64}\b/g;
const MENTION = /@([\p{L}\p{N}_.-]+)/gu;
/** Palavras de quem pergunta como as peças conversam entre si. */
const INTERACTION = /\b(interac|integra|chama|chamada|call|fala|conversa|comunica|envia|manda|consome|publica|requisi|request|talk)/;

export interface AnalyzeInput {
  text: string;
  focus?: VisualFocus;
  recent?: RecentTopics;
  /** Respostas do usuário a perguntas anteriores: termo → unidade escolhida. */
  choices?: Record<string, TargetRef>;
  /** Para depuração e para a avaliação: recebe o estado de cada passo. */
  trace?: (stage: string, data: unknown) => void;
}

export interface BuildContextInput {
  relevance: Relevance;
  budget?: Partial<TokenBudget>;
  content?: ContentPort;
}

export interface SearchResult {
  ref: TargetRef;
  kind: IndexDoc["kind"];
  name: string;
  unitIds: TargetRef[];
  score: number;
}

interface Graph {
  parent: Map<string, string>;
  neighbors: Map<string, Set<string>>;
  /** Diagrama → nós e arestas dele. */
  parts: Map<string, string[]>;
  /** Unidade → diagramas ancorados nela ou com nós dela. */
  unitDiagrams: Map<string, Set<string>>;
  /** Unidade → quem a contém, do pai para cima (preenchido sob demanda). */
  ancestors: Map<string, string[]>;
}

export const DEFAULT_BUDGET: TokenBudget = { context: 12_000 };

export class SemanticContextEngine {
  private readonly index = new SearchIndex();
  private links: UnitLink[] = [];
  private graph: Graph | undefined;
  private names: Map<string, string[]> | undefined;
  private readonly synonyms: Synonyms;
  private charsPerToken = 3.5;

  constructor(options: { synonyms?: string[][] } = {}) {
    this.synonyms = new Synonyms(options.synonyms);
  }

  get size() {
    return this.index.size;
  }

  /** Mantém o índice atualizado. Itens iguais aos que já estão são ignorados. */
  feed(update: IndexUpdate) {
    let changed = false;
    for (const id of update.remove ?? []) {
      if (this.index.get(id)) {
        this.index.remove(id);
        changed = true;
      }
    }
    for (const doc of update.upsert ?? []) changed = this.index.upsert(doc) || changed;
    if (update.links) {
      this.links = update.links;
      changed = true;
    }
    if (changed) {
      this.graph = undefined;
      this.names = undefined;
    }
  }

  /** Ids que o índice tem hoje (o adaptador usa para saber o que remover). */
  ids(): TargetRef[] {
    return this.index.ids();
  }

  doc(id: TargetRef): IndexDoc | undefined {
    return this.index.get(id);
  }

  /** Busca simples, para a ferramenta de consulta da IA. */
  search(text: string, limit = 15): SearchResult[] {
    const hits = this.index.search(this.queryTerms(text));
    return [...hits]
      .filter(([id]) => !DEAD.has(this.index.get(id)!.status ?? ""))
      .sort((a, b) => b[1].score - a[1].score || cmp(a[0], b[0]))
      .slice(0, limit)
      .map(([id, hit]) => {
        const d = this.index.get(id)!;
        return { ref: id, kind: d.kind, name: d.name, unitIds: d.unitIds, score: round(hit.score) };
      });
  }

  /** Calibra a estimativa de tokens com o uso real que o provedor devolveu. */
  observe(estimatedTokens: number, realTokens: number) {
    if (estimatedTokens <= 0 || realTokens <= 0) return;
    const observed = (this.charsPerToken * estimatedTokens) / realTokens;
    this.charsPerToken = clamp(this.charsPerToken * 0.7 + observed * 0.3, 2, 6);
  }

  estimate(text: string): number {
    return estimateTokens(text, this.charsPerToken);
  }

  // ----- analyze -----

  analyze(input: AnalyzeInput): Relevance {
    const started = performance.now();
    const g = this.ensureGraph();
    const focus = input.focus ?? {};
    const recent = input.recent ?? [];
    const choices = input.choices ?? {};

    // 1. Busca por frase, com o peso de cada frase.
    const hits = new Map<string, { score: number; byTerm: Map<string, number>; sentences: Set<number> }>();
    const raws = new Map<string, string>();
    for (const { term, raw } of termsWithRaw(input.text)) {
      const canon = this.synonyms.canon(term);
      if (!raws.has(canon)) raws.set(canon, raw);
    }
    for (const s of sentences(input.text)) {
      const found = this.index.search(this.queryTerms(s.raw));
      let max = 0;
      for (const h of found.values()) max = Math.max(max, h.score);
      if (!max) continue;
      // Só os melhores de cada frase, e os melhores de cada termo (um termo fraco na frase ainda conta:
      // "o app mobile fala com o back-end" precisa achar o back-end). O resto é ruído e custa tempo.
      const maxByTerm = new Map<string, number>();
      for (const h of found.values()) for (const [t, v] of h.byTerm) maxByTerm.set(t, Math.max(maxByTerm.get(t) ?? 0, v));
      // Uma passada separa quem passa em cada critério; só esses são ordenados (um termo comum acha milhares).
      const byScore: [string, TermHit][] = [];
      const byTerm = new Map<string, [string, TermHit][]>();
      for (const entry of found) {
        const [id, h] = entry;
        if (DEAD.has(this.index.get(id)!.status ?? "")) continue;
        if (h.score >= max * 0.35) byScore.push(entry);
        for (const [t, v] of h.byTerm) {
          if (v < maxByTerm.get(t)! * 0.6) continue;
          let list = byTerm.get(t);
          if (!list) byTerm.set(t, (list = []));
          list.push(entry);
        }
      }
      const top = (list: [string, TermHit][], limit: number) => list.sort((a, b) => b[1].score - a[1].score || cmp(a[0], b[0])).slice(0, limit);
      const keep = new Map(top(byScore, 60));
      for (const list of byTerm.values()) for (const [id, h] of top(list, 25)) keep.set(id, h);
      for (const [id, h] of keep) {
        let acc = hits.get(id);
        if (!acc) hits.set(id, (acc = { score: 0, byTerm: new Map(), sentences: new Set() }));
        acc.score += s.weight * h.score;
        acc.sentences.add(s.index);
        for (const [t, v] of h.byTerm) acc.byTerm.set(t, (acc.byTerm.get(t) ?? 0) + s.weight * v);
      }
    }

    input.trace?.("busca", [...hits].sort((a, b) => b[1].score - a[1].score).slice(0, 25).map(([id, h]) => [id, round(h.score), Object.fromEntries(h.byTerm)]));

    // 2. O que o usuário citou ou selecionou vale mais que qualquer busca. Um nó selecionado vale pela unidade
    // que ele representa: o foco ainda vai para onde houver mais detalhe sobre ela.
    const explicit = this.explicitRefs(input.text, focus);
    let globalMax = 0;
    for (const h of hits.values()) globalMax = Math.max(globalMax, h.score);
    const boost = Math.max(globalMax, 5);
    for (const id of explicit) {
      let acc = hits.get(id);
      if (!acc) hits.set(id, (acc = { score: 0, byTerm: new Map(), sentences: new Set([-1]) }));
      acc.score += boost;
    }

    // 3. Termos com mais de um candidato: supor quando dá, perguntar quando não dá.
    const assumptions: Assumption[] = [];
    const candidatesByTerm = this.termCandidates(hits, g);
    const subtract = (term: string, keep: (owner: string) => boolean) => {
      for (const [id, h] of hits) {
        const owner = this.owner(id);
        if (!owner || keep(owner)) continue;
        const part = h.byTerm.get(term);
        if (!part) continue;
        h.score -= part;
        h.byTerm.delete(term);
        if (h.score <= 1e-9) hits.delete(id);
      }
    };
    // Um termo que acha a unidade e as peças dentro dela fala da unidade ("estoque" é o repositório):
    // as peças perdem o que ganharam só por esse termo.
    for (const [term, { candidates }] of candidatesByTerm) {
      const set = new Set(candidates);
      subtract(term, (owner) => set.has(owner) || !this.coveredBy(g, set, owner));
    }
    input.trace?.("candidatos", Object.fromEntries([...candidatesByTerm].map(([t, c]) => [t, c.candidates])));
    const pending = [...candidatesByTerm].filter(([, c]) => c.candidates.length > 1).map(([term]) => term);
    // Unidades já identificadas: as de termos com um candidato só e as que o usuário citou ou selecionou.
    const strongUnits = new Set<string>();
    for (const [, c] of candidatesByTerm) if (c.candidates.length === 1) strongUnits.add(c.candidates[0]!);
    for (const id of explicit) {
      const o = this.owner(id);
      if (o) strongUnits.add(o);
    }
    // Um diagrama citado pelo título ("o diagrama de criação do pedido") identifica as unidades em que está ancorado.
    let bestDiagram: [string, number] | undefined;
    let bestOther = 0;
    for (const [id, h] of hits) {
      if (this.index.get(id)?.kind === "diagram") {
        if (!bestDiagram || h.score > bestDiagram[1]) bestDiagram = [id, h.score];
      } else bestOther = Math.max(bestOther, h.score);
    }
    if (bestDiagram && bestDiagram[1] >= bestOther * 1.5) for (const u of this.index.get(bestDiagram[0])!.unitIds) strongUnits.add(u);
    // Em que frases cada termo e cada unidade aparecem: o que é citado junto pesa mais.
    const termSentences = new Map<string, Set<number>>();
    const unitSentences = new Map<string, Set<number>>();
    for (const [id, h] of hits) {
      for (const t of h.byTerm.keys()) for (const s of h.sentences) (termSentences.get(t) ?? termSentences.set(t, new Set()).get(t)!).add(s);
      const o = this.owner(id);
      if (o) for (const s of h.sentences) (unitSentences.get(o) ?? unitSentences.set(o, new Set()).get(o)!).add(s);
    }
    const narrowed = new Map<string, string[]>();
    for (let progress = true; progress && pending.length; ) {
      progress = false;
      for (const term of [...pending]) {
        const { candidates, scores } = candidatesByTerm.get(term)!;
        const others = [...candidatesByTerm].filter(([t, c]) => t !== term && c.candidates.length > 0).map(([, c]) => c.candidates);
        const here = termSentences.get(term) ?? new Set<number>();
        const local = new Set([...strongUnits].filter((u) => [...(unitSentences.get(u) ?? [])].some((s) => here.has(s))));
        const result = this.resolve(term, candidates, scores, { choices, explicit, focus, recent, strongUnits, local, otherSets: others, g });
        if ("narrowed" in result) {
          narrowed.set(term, result.narrowed);
          continue;
        }
        if (result.why !== "choice" && result.why !== "obvious") {
          assumptions.push({ term: raws.get(term) ?? term, chosen: result.units[0]!, alternatives: candidates.filter((c) => !result.units.includes(c)), why: result.why });
        }
        for (const u of result.units) strongUnits.add(u);
        const chosen = new Set(result.units);
        const all = new Set(candidates);
        subtract(term, (owner) => this.coveredBy(g, chosen, owner) || !this.coveredBy(g, all, owner));
        pending.splice(pending.indexOf(term), 1);
        narrowed.delete(term);
        progress = true;
      }
    }
    const unresolved = pending.map((term) => ({ term, candidates: narrowed.get(term) ?? candidatesByTerm.get(term)!.candidates }));

    // 4. Tópicos: itens ligados entre si (mesmo diagrama, mesma unidade, unidades relacionadas) e citados juntos.
    globalMax = 0;
    for (const h of hits.values()) globalMax = Math.max(globalMax, h.score);
    const kept = [...hits].filter(([id, h]) => h.score >= globalMax * 0.15 || strongUnits.has(this.owner(id) ?? "")).sort((a, b) => b[1].score - a[1].score || cmp(a[0], b[0]));
    const topics = this.cluster(kept, g, strongUnits);
    input.trace?.("topicos", { unresolved, assumptions, topics: topics.slice(0, 4) });

    const interaction = INTERACTION.test(stripAccents(input.text).toLowerCase());

    // 5. Dúvida que muda o foco: está no assunto principal.
    let question: Clarification | undefined;
    const main = topics[0];
    for (const u of unresolved) {
      const inMain = main && u.candidates.some((c) => main.unitIds.includes(c) || main.unitIds.some((m) => this.isAncestor(g, c, m) || this.isAncestor(g, m, c)));
      if (!inMain || !main) continue;
      // Só pergunta se a resposta muda para onde o foco vai.
      const targets = new Set(
        u.candidates.slice(0, 6).map((c) => {
          const others = u.candidates.filter((o) => o !== c);
          const owned = (ref: string) => others.includes(this.owner(ref) ?? "");
          const narrowedTopic: Topic = { ...main, unitIds: [c, ...main.unitIds.filter((x) => x !== c && !others.includes(x))], refs: main.refs.filter((r) => !owned(r)) };
          return this.primaryTarget(narrowedTopic, hits, g, interaction)?.ref;
        }),
      );
      if (targets.size <= 1) continue;
      const raw = raws.get(u.term) ?? u.term;
      question = {
        term: u.term,
        text: `De qual ${raw} você está falando?`,
        options: u.candidates.slice(0, 6).map((c) => ({ ref: c, label: this.label(c, g) })),
      };
      break;
    }

    // 6. Ponto principal e ênfase.
    const relevance: Relevance = { topics, emphasis: [], assumptions, timings: { analyzeMs: 0 } };
    if (question) {
      relevance.question = question;
      relevance.emphasis = question.options.map((o) => ({ ref: o.ref, level: "secondary" as const }));
    } else if (main) {
      const target = this.primaryTarget(main, hits, g, interaction);
      if (target) relevance.primaryTarget = target.ref;
      relevance.emphasis = this.emphasisFor(main, topics.slice(1), target?.diagramId, hits, g);
    }
    relevance.timings.analyzeMs = round(performance.now() - started);
    return relevance;
  }

  private queryTerms(text: string): QueryTerm[] {
    const out: QueryTerm[] = [];
    const seen = new Set<string>();
    for (const t of terms(text)) {
      const origin = this.synonyms.canon(t);
      for (const s of this.synonyms.expand(t)) {
        const key = `${origin}|${s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ term: s, origin, weight: s === t ? 1 : 0.8 });
      }
    }
    return out;
  }

  private explicitRefs(text: string, focus: VisualFocus): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(EXPLICIT_ID)) if (this.index.get(m[0])) out.add(m[0]);
    for (const m of text.matchAll(MENTION)) {
      const wanted = terms(m[1]!).join(" ");
      if (!wanted) continue;
      for (const id of this.unitsByName().get(wanted) ?? []) out.add(id);
    }
    for (const id of focus.selectedIds ?? []) {
      const d = this.index.get(id);
      if (!d) continue;
      const unit = d.kind === "unit" ? undefined : d.unitIds[0];
      out.add(unit && this.index.get(unit) && this.index.get(unit)!.unitKind !== "repository" ? unit : id);
    }
    return [...out].sort();
  }

  /** Nome normalizado → unidades com esse nome, para menções com @ (refeito quando o índice muda). */
  private unitsByName(): Map<string, string[]> {
    if (this.names) return this.names;
    const names = new Map<string, string[]>();
    for (const d of this.index.docs()) {
      if (d.kind !== "unit") continue;
      const key = terms(d.name).join(" ");
      names.set(key, [...(names.get(key) ?? []), d.id]);
    }
    return (this.names = names);
  }

  /** Unidade dona de um item: a própria unidade, a entidade do nó, ou a âncora do diagrama. */
  private owner(id: string): string | undefined {
    const d = this.index.get(id);
    if (!d) return undefined;
    return d.kind === "unit" ? d.id : d.unitIds[0];
  }

  private ancestors(g: Graph, unit: string): string[] {
    let list = g.ancestors.get(unit);
    if (list) return list;
    list = [];
    for (let p = g.parent.get(unit); p && !list.includes(p) && p !== unit; p = g.parent.get(p)) list.push(p);
    g.ancestors.set(unit, list);
    return list;
  }

  private isAncestor(g: Graph, ancestor: string, unit: string): boolean {
    return this.ancestors(g, unit).includes(ancestor);
  }

  /** Algum destes é a própria unidade ou a contém? */
  private coveredBy(g: Graph, set: Set<string>, unit: string): boolean {
    return set.has(unit) || this.ancestors(g, unit).some((a) => set.has(a));
  }

  /**
   * Candidatos de cada termo: unidades identificadas por ele (nome, alias, papel; não só a descrição).
   * Unidade e quem a contém não são dúvida: vale a mais geral.
   */
  private termCandidates(hits: Map<string, TermHit>, g: Graph) {
    const byTerm = new Map<string, Map<string, number>>();
    const expanded = new Map<string, string[]>();
    for (const [id, h] of hits) {
      const owner = this.owner(id);
      if (!owner) continue;
      // Arestas e títulos de diagrama citam várias coisas; quem identifica uma unidade é ela mesma ou um nó dela.
      const kind = this.index.get(id)!.kind;
      if (kind === "edge" || kind === "diagram") continue;
      for (const [t, v] of h.byTerm) {
        let forms = expanded.get(t);
        if (!forms) expanded.set(t, (forms = this.synonyms.expand(t)));
        if (!this.index.identifiedBy(id, forms)) continue;
        let m = byTerm.get(t);
        if (!m) byTerm.set(t, (m = new Map()));
        // O melhor item de cada unidade, não a soma: uma unidade com muitos diagramas não ganha só por isso.
        m.set(owner, Math.max(m.get(owner) ?? 0, v));
      }
    }
    const out = new Map<string, { candidates: string[]; scores: Map<string, number> }>();
    for (const [term, units] of [...byTerm].sort((a, b) => cmp(a[0], b[0]))) {
      const best = Math.max(...units.values());
      let candidates = [...units].filter(([, v]) => v >= best * 0.5).map(([u]) => u);
      const set = new Set(candidates);
      candidates = candidates.filter((c) => !this.ancestors(g, c).some((a) => set.has(a)));
      candidates.sort((a, b) => units.get(b)! - units.get(a)! || cmp(a, b));
      out.set(term, { candidates, scores: units });
    }
    return out;
  }

  private resolve(
    term: string,
    candidates: string[],
    scores: Map<string, number>,
    ctx: {
      choices: Record<string, string>;
      explicit: string[];
      focus: VisualFocus;
      recent: RecentTopics;
      strongUnits: Set<string>;
      /** Unidades identificadas nas mesmas frases que o termo. */
      local: Set<string>;
      otherSets: string[][];
      g: Graph;
    },
  ): { units: string[]; why: Assumption["why"] | "choice" | "obvious" } | { narrowed: string[] } {
    const { g } = ctx;
    const one = (list: string[]) => (list.length === 1 ? list : undefined);
    const choice = ctx.choices[term];
    if (choice && candidates.includes(choice)) return { units: [choice], why: "choice" };
    const covers = (c: string, ids: string[]) =>
      ids.some((id) => {
        const o = this.owner(id) ?? id;
        return o === c || this.isAncestor(g, c, o);
      });
    let found = one(candidates.filter((c) => covers(c, ctx.explicit)));
    if (found) return { units: found, why: "selection" };
    // O termo só descreve o que outros termos já identificaram ("o serviço de pagamentos", "app-web").
    const known = candidates.filter((c) => ctx.strongUnits.has(c));
    if (known.length) return { units: known, why: "obvious" };
    found = one(candidates.filter((c) => ctx.otherSets.some((set) => set.includes(c))));
    if (found) return { units: found, why: "obvious" };
    for (const r of ctx.recent) {
      found = one(candidates.filter((c) => c === r || this.isAncestor(g, c, r)));
      if (found) return { units: found, why: "recent" };
    }
    found = one(candidates.filter((c) => covers(c, ctx.focus.visibleIds ?? [])));
    if (found) return { units: found, why: "recent" };
    // Dentro de algo já identificado ("o back-end da loja") ou ligado a ele ("o back-end do app-web").
    // Primeiro o que foi citado na mesma frase, depois o resto da mensagem.
    let pool = candidates;
    for (const scope of [[...ctx.local], [...ctx.strongUnits]]) {
      const others = scope.filter((u) => !candidates.includes(u));
      if (!others.length) continue;
      const inside = candidates.filter((c) => others.some((o) => this.isAncestor(g, o, c)));
      found = one(inside);
      if (found) return { units: found, why: "graph" };
      const base = inside.length > 1 ? inside : candidates;
      const linked = base.filter((c) => others.some((o) => g.neighbors.get(c)?.has(o)));
      found = one(linked);
      if (found) return { units: found, why: "graph" };
      if (linked.length > 1) pool = linked;
      else if (inside.length > 1 && pool === candidates) pool = inside;
      if (pool !== candidates) break;
    }
    for (const r of ctx.recent) {
      found = one(pool.filter((c) => g.neighbors.get(c)?.has(r)));
      if (found) return { units: found, why: "recent" };
    }
    const [a, b] = pool.map((c) => scores.get(c) ?? 0);
    if (a !== undefined && b !== undefined && a >= b * 1.4) return { units: [pool[0]!], why: a >= b * 2 ? "obvious" : "margin" };
    return { narrowed: pool };
  }

  private cluster(kept: [string, TermHit & { sentences: Set<number> }][], g: Graph, strongUnits: Set<string>): Topic[] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const [id] of kept) parent.set(id, id);
    // Mesma unidade dona: sempre o mesmo assunto, em qualquer frase.
    const byOwner = new Map<string, string>();
    for (const [id] of kept) {
      const o = this.owner(id);
      if (!o) continue;
      const first = byOwner.get(o);
      if (first) union(first, id);
      else byOwner.set(o, id);
    }
    // Citados na mesma frase e ligados: mesmo diagrama, unidades vizinhas, ou uma dentro da outra (fora o repositório).
    const bySentence = new Map<number, string[]>();
    for (const [id, h] of kept) for (const s of h.sentences) bySentence.set(s, [...(bySentence.get(s) ?? []), id]);
    for (const ids of bySentence.values()) {
      // Os já identificados entram primeiro: um verbo comum ("consome") acha arestas em todo o workspace
      // e não pode empurrar para fora as peças que a mensagem nomeou.
      const strong = ids.filter((id) => strongUnits.has(this.owner(id) ?? ""));
      const top = [...strong, ...ids.filter((id) => !strong.includes(id))].slice(0, 12);
      for (let i = 0; i < top.length; i++) {
        for (let j = i + 1; j < top.length; j++) {
          const a = this.index.get(top[i]!)!;
          const b = this.index.get(top[j]!)!;
          const da = a.kind === "diagram" ? a.id : a.diagramId;
          const db = b.kind === "diagram" ? b.id : b.diagramId;
          const oa = this.owner(a.id)!;
          const ob = this.owner(b.id)!;
          const sameDiagram = da !== undefined && da === db;
          const linked = g.neighbors.get(oa)?.has(ob) ?? false;
          // Um repositório citado junto com algo dele ("o back-end da loja") é o escopo do mesmo assunto.
          const nested = this.isAncestor(g, oa, ob) || this.isAncestor(g, ob, oa);
          if (sameDiagram || linked || nested) union(a.id, b.id);
        }
      }
    }
    const groups = new Map<string, [string, TermHit][]>();
    for (const entry of kept) {
      const r = find(entry[0]);
      groups.set(r, [...(groups.get(r) ?? []), entry]);
    }
    const topics: Topic[] = [];
    for (const members of groups.values()) {
      const unitScore = new Map<string, number>();
      let salience = 0;
      for (const [id, h] of members) {
        salience += h.score;
        const o = this.owner(id);
        if (o) unitScore.set(o, (unitScore.get(o) ?? 0) + h.score);
      }
      // Primeiro as unidades achadas pelo nome; o repositório só lidera quando é ele o assunto.
      const direct = new Set(members.filter(([id]) => this.index.get(id)?.kind === "unit").map(([id]) => id));
      const rank = (u: string) => (this.index.get(u)?.unitKind === "repository" ? 2 : direct.has(u) ? 0 : 1);
      const unitIds = [...unitScore].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || cmp(a[0], b[0])).map(([u]) => u);
      if (!unitIds.length) continue;
      topics.push({ unitId: unitIds[0]!, unitIds, refs: members.map(([id]) => id), salience: round(salience) });
    }
    return topics.sort((a, b) => b.salience - a.salience || cmp(a.unitId, b.unitId));
  }

  private primaryTarget(topic: Topic, hits: Map<string, TermHit>, g: Graph, interaction = false): { ref: string; diagramId?: string } | undefined {
    // Assunto amplo (um repositório inteiro): enquadra a unidade, que mostra tudo o que está ancorado nela.
    // Exceção: um diagrama dele citado pelo título ("a arquitetura do banco digital") casa com mais termos que o repositório.
    if (this.index.get(topic.unitId)?.unitKind === "repository") {
      const terms = (id: string) => hits.get(id)?.byTerm.size ?? 0;
      const named = topic.refs
        .filter((r) => this.index.get(r)?.kind === "diagram" && terms(r) > terms(topic.unitId))
        .sort((a, b) => terms(b) - terms(a) || (hits.get(b)?.score ?? 0) - (hits.get(a)?.score ?? 0) || cmp(a, b))[0];
      return named ? { ref: named, diagramId: named } : { ref: topic.unitId };
    }
    const scores = new Map<string, { score: number; units: Set<string> }>();
    const bump = (diagramId: string, score: number, unit?: string) => {
      let s = scores.get(diagramId);
      if (!s) scores.set(diagramId, (s = { score: 0, units: new Set() }));
      s.score += score;
      if (unit) s.units.add(unit);
    };
    // O que só pertence ao repositório pesa pouco quando o assunto tem peças dele: o repositório ali é escopo.
    const scoped = topic.unitIds.some((u) => this.index.get(u)?.unitKind !== "repository");
    for (const ref of topic.refs) {
      const d = this.index.get(ref)!;
      const owner = this.owner(ref);
      const h = (hits.get(ref)?.score ?? 0) * (scoped && owner && this.index.get(owner)?.unitKind === "repository" ? 0.3 : 1);
      if (d.kind === "diagram") bump(d.id, h * 0.5);
      else if (d.diagramId) bump(d.diagramId, h, this.owner(ref));
    }
    for (const u of topic.unitIds) for (const dg of g.unitDiagrams.get(u) ?? []) bump(dg, 0, u);
    // Unidades cobertas por cada diagrama: pelos nós e pelas âncoras.
    for (const [dg, s] of scores) {
      for (const part of g.parts.get(dg) ?? []) {
        const o = this.owner(part);
        if (o && topic.unitIds.includes(o)) s.units.add(o);
      }
      for (const a of this.index.get(dg)?.unitIds ?? []) if (topic.unitIds.includes(a)) s.units.add(a);
      if (scoped) for (const u of [...s.units]) if (this.index.get(u)?.unitKind === "repository") s.units.delete(u);
    }
    let best: { id: string; value: number } | undefined;
    for (const [dg, s] of scores) {
      const kind = this.index.get(dg)?.diagramKind ?? "freeform";
      const covered = Math.max(1, s.units.size);
      // Pergunta sobre como as peças conversam: o diagrama de sequência é onde está o detalhe.
      const talk = interaction && kind === "sequence" && covered > 1 ? 1.5 : 1;
      const value = (s.score + 0.1) * (DETAIL_BY_KIND[kind] ?? 1) * talk * (1 + 0.6 * (covered - 1));
      if (!best || value > best.value + 1e-9 || (Math.abs(value - best.value) <= 1e-9 && dg < best.id)) best = { id: dg, value };
    }
    if (best) return { ref: best.id, diagramId: best.id };
    const unit = topic.unitId;
    if (this.index.get(unit)) return { ref: unit };
    return topic.refs[0] ? { ref: topic.refs[0] } : undefined;
  }

  private emphasisFor(main: Topic, rest: Topic[], diagramId: string | undefined, hits: Map<string, TermHit>, g: Graph): Relevance["emphasis"] {
    const out = new Map<string, "primary" | "secondary">();
    const set = (ref: string, level: "primary" | "secondary") => {
      if (out.get(ref) !== "primary") out.set(ref, level);
    };
    const inTarget = new Set<string>();
    for (const ref of main.refs) {
      const d = this.index.get(ref)!;
      if (d.kind === "unit") continue;
      if (d.kind === "diagram") {
        set(ref, ref === diagramId ? "primary" : "secondary");
        continue;
      }
      if (diagramId && d.diagramId === diagramId) {
        set(ref, "primary");
        inTarget.add(ref);
      } else set(ref, "secondary");
    }
    if (diagramId) {
      // Nós do diagrama que representam unidades do assunto, e as arestas entre eles.
      for (const part of g.parts.get(diagramId) ?? []) {
        const d = this.index.get(part)!;
        if (d.kind === "node" && main.unitIds.includes(this.owner(part) ?? "") && this.owner(part) !== this.index.get(diagramId)?.unitIds[0]) {
          set(part, "primary");
          inTarget.add(part);
        }
      }
      for (const part of g.parts.get(diagramId) ?? []) {
        const d = this.index.get(part)!;
        if (d.kind === "edge" && d.sourceId && d.targetId && inTarget.has(d.sourceId) && inTarget.has(d.targetId)) set(part, "primary");
      }
      if (![...out.values()].includes("primary")) set(diagramId, "primary");
    }
    for (const u of main.unitIds) if (this.index.get(u)) set(u, "secondary");
    for (const t of rest.slice(0, 3)) for (const ref of t.refs.slice(0, 4)) if (this.index.get(ref)?.kind !== "unit" || g.unitDiagrams.has(ref)) set(ref, "secondary");
    void hits;
    return [...out].map(([ref, level]) => ({ ref, level })).sort((a, b) => (a.level === b.level ? cmp(a.ref, b.ref) : a.level === "primary" ? -1 : 1));
  }

  private label(unit: string, g: Graph): string {
    const d = this.index.get(unit);
    if (!d) return unit;
    const root = this.rootOf(g, unit);
    const rootName = root && root !== unit ? this.index.get(root)?.name : undefined;
    return rootName ? `${d.name} (${rootName})` : d.name;
  }

  private rootOf(g: Graph, unit: string): string | undefined {
    let top = unit;
    const seen = new Set<string>([unit]);
    for (let p = g.parent.get(top); p && !seen.has(p); p = g.parent.get(p)) {
      seen.add(p);
      top = p;
    }
    return top;
  }

  private ensureGraph(): Graph {
    if (this.graph) return this.graph;
    const parent = new Map<string, string>();
    const neighbors = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (a === b) return;
      (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
      (neighbors.get(b) ?? neighbors.set(b, new Set()).get(b)!).add(a);
    };
    for (const l of [...this.links].sort((a, b) => `${a.from}${a.to}${a.type}`.localeCompare(`${b.from}${b.to}${b.type}`))) {
      if (l.type === "contains") {
        if (!parent.has(l.to)) parent.set(l.to, l.from);
      } else link(l.from, l.to);
    }
    const parts = new Map<string, string[]>();
    const unitDiagrams = new Map<string, Set<string>>();
    const addUnitDiagram = (u: string, dg: string) => (unitDiagrams.get(u) ?? unitDiagrams.set(u, new Set()).get(u)!).add(dg);
    const nodeOwner = new Map<string, string>();
    for (const d of this.index.docs()) {
      if (d.kind === "diagram") for (const u of d.unitIds) addUnitDiagram(u, d.id);
      if ((d.kind === "node" || d.kind === "edge") && d.diagramId) {
        parts.set(d.diagramId, [...(parts.get(d.diagramId) ?? []), d.id]);
        if (d.kind === "node" && d.unitIds[0]) {
          addUnitDiagram(d.unitIds[0], d.diagramId);
          nodeOwner.set(d.id, d.unitIds[0]);
        }
      }
    }
    // Aresta de diagrama entre nós de unidades diferentes também liga as unidades.
    for (const d of this.index.docs()) {
      if (d.kind !== "edge" || !d.sourceId || !d.targetId) continue;
      const a = nodeOwner.get(d.sourceId);
      const b = nodeOwner.get(d.targetId);
      if (a && b) link(a, b);
    }
    for (const list of parts.values()) list.sort();
    this.graph = { parent, neighbors, parts, unitDiagrams, ancestors: new Map() };
    return this.graph;
  }

  // ----- buildContext -----

  /**
   * Contexto enxuto para a IA: o assunto principal no maior detalhe que couber, o resto como referência.
   * Determinístico: mesmo índice e mesmo resultado de analyze dão o mesmo texto.
   */
  async buildContext(input: BuildContextInput): Promise<ContextPack> {
    const g = this.ensureGraph();
    const budget = { ...DEFAULT_BUDGET, ...input.budget }.context;
    const { relevance } = input;
    const items: ContextItem[] = [];
    const dropped: string[] = [];
    const lines: string[] = [];
    let used = 0;
    const included = new Set<string>();

    /** Tenta cada nível, do mais detalhado ao mais curto; usa o primeiro que couber. */
    const offer = (ref: string, why: string, variants: [DetailLevel, string][]) => {
      if (included.has(ref)) return;
      for (const [level, text] of variants) {
        if (!text) continue;
        const tokens = this.estimate(text) + 1;
        if (used + tokens > budget) continue;
        used += tokens;
        lines.push(text);
        items.push({ ref, level, tokens, why });
        included.add(ref);
        return;
      }
      dropped.push(ref);
    };
    const section = (title: string) => {
      const text = `## ${title}`;
      used += this.estimate(text) + 1;
      lines.push(text);
    };

    const units = [...this.index.docs()].filter((d) => d.kind === "unit" && !DEAD.has(d.status ?? "")).sort(byId);
    const diagrams = [...this.index.docs()].filter((d) => d.kind === "diagram").sort(byId);
    const main = relevance.topics[0];
    const mainUnits = new Set(main?.unitIds ?? []);
    const secondaryUnits = new Set(relevance.topics.slice(1, 4).flatMap((t) => t.unitIds));

    // Assunto principal: unidades com descrição, ligações e evidências; o diagrama principal inteiro.
    if (main) {
      section("Assunto principal");
      for (const u of main.unitIds) {
        const d = this.index.get(u);
        if (!d) continue;
        const evidence = (await input.content?.read(u, 1)) ?? "";
        const full = [this.unitLine(d, g, true), ...this.unitLinks(u, g), evidence].filter(Boolean).join("\n");
        offer(u, "assunto principal", [
          [1, full],
          [0, this.unitLine(d, g, false)],
        ]);
      }
      const target = relevance.primaryTarget && this.index.get(relevance.primaryTarget)?.kind === "diagram" ? relevance.primaryTarget : undefined;
      const topicDiagrams = new Set<string>(target ? [target] : []);
      for (const u of main.unitIds) for (const dg of [...(g.unitDiagrams.get(u) ?? [])].sort()) topicDiagrams.add(dg);
      for (const ref of main.refs) {
        const d = this.index.get(ref);
        if (d?.kind === "diagram") topicDiagrams.add(d.id);
        else if (d?.diagramId) topicDiagrams.add(d.diagramId);
      }
      for (const dg of topicDiagrams) {
        const d = this.index.get(dg);
        if (!d) continue;
        offer(dg, dg === target ? "ponto principal" : "diagrama do assunto", [
          [2, this.diagramText(d, g, mainUnits)],
          [1, this.diagramText(d, g, mainUnits, true)],
          [0, this.diagramLine(d)],
        ]);
      }
    }

    // Assuntos secundários: só referência.
    if (secondaryUnits.size) {
      section("Também citado");
      for (const u of [...secondaryUnits].sort()) {
        const d = this.index.get(u);
        if (d) offer(u, "assunto secundário", [[0, this.unitLine(d, g, false)]]);
      }
    }

    // Mapa: unidades de primeiro nível sempre; as demais e os diagramas restantes conforme o orçamento.
    section("Mapa do workspace");
    for (const d of units.filter((u) => !g.parent.has(u.id))) offer(d.id, "mapa", [[0, this.unitLine(d, g, false)]]);
    for (const d of diagrams) offer(d.id, "mapa", [[1, this.diagramText(d, g, new Set(), true)], [0, this.diagramLine(d)]]);
    for (const d of units.filter((u) => g.parent.has(u.id))) offer(d.id, "mapa", [[0, this.unitLine(d, g, false)]]);
    const others = [...this.index.docs()].filter((d) => d.kind === "mod" || d.kind === "region").sort(byId);
    for (const d of others) offer(d.id, "mapa", [[0, this.otherLine(d)]]);

    if (dropped.length) lines.push(`(${dropped.length} itens fora do contexto por tamanho; use search_workspace para achar outros)`);
    const text = lines.join("\n");
    return { text, items, dropped, tokens: this.estimate(text) };
  }

  private unitLine(d: IndexDoc, g: Graph, withDescription: boolean): string {
    const parent = g.parent.get(d.id);
    const bits = [d.unitKind, d.status && d.status !== "verified" ? d.status : undefined, parent ? `em ${parent}` : undefined].filter(Boolean);
    const aliases = d.aliases?.length ? ` aka ${d.aliases.join(", ")}` : "";
    const desc = withDescription && d.description ? ` — ${d.description}` : "";
    return `${d.id} "${d.name}"${aliases} [${bits.join(", ")}]${desc}`;
  }

  private unitLinks(unit: string, g: Graph): string[] {
    return this.links
      .filter((l) => l.type !== "contains" && (l.from === unit || l.to === unit))
      .map((l) => `  ${l.from} -${l.type}-> ${l.to}`)
      .sort();
  }

  private diagramLine(d: IndexDoc): string {
    const parts = d.unitIds.length ? ` sobre ${d.unitIds.join(", ")}` : "";
    return `${d.id} "${d.name}" (${d.diagramKind ?? "diagrama"})${parts}`;
  }

  /** Diagrama em texto compacto. Em diagramas grandes, só o recorte com as unidades do assunto e vizinhos. */
  private diagramText(d: IndexDoc, g: Graph, focusUnits: Set<string>, summary = false): string {
    const parts = (g.parts.get(d.id) ?? []).map((p) => this.index.get(p)!);
    const nodes = parts.filter((p) => p.kind === "node");
    const edges = parts.filter((p) => p.kind === "edge");
    if (summary) {
      const labels = nodes.slice(0, 12).map((n) => n.name);
      return `${this.diagramLine(d)}: ${labels.join(", ")}${nodes.length > 12 ? `, +${nodes.length - 12}` : ""}`;
    }
    let shownNodes = nodes;
    if (nodes.length > 40 && focusUnits.size) {
      const core = new Set(nodes.filter((n) => focusUnits.has(n.unitIds[0] ?? "")).map((n) => n.id));
      const near = new Set(core);
      for (const e of edges) {
        if (core.has(e.sourceId ?? "")) near.add(e.targetId ?? "");
        if (core.has(e.targetId ?? "")) near.add(e.sourceId ?? "");
      }
      shownNodes = nodes.filter((n) => near.has(n.id));
    }
    const shown = new Set(shownNodes.map((n) => n.id));
    const out = [`${this.diagramLine(d)}${shownNodes.length < nodes.length ? ` (recorte: ${shownNodes.length} de ${nodes.length} nós)` : ""}`];
    for (const n of shownNodes) {
      const unit = n.unitIds[0] && n.unitIds[0] !== d.unitIds[0] ? ` -> ${n.unitIds[0]}` : "";
      out.push(`  ${n.id} "${n.name}" [${n.extra ?? ""}]${unit}`);
    }
    for (const e of edges) {
      if (!shown.has(e.sourceId ?? "") || !shown.has(e.targetId ?? "")) continue;
      out.push(`  ${e.id}: ${e.sourceId} -> ${e.targetId}${e.name ? ` "${e.name}"` : ""}`);
    }
    return out.join("\n");
  }

  private otherLine(d: IndexDoc): string {
    return `${d.id} "${d.name}" (${d.extra ?? d.kind})${d.unitIds.length ? ` sobre ${d.unitIds.join(", ")}` : ""}`;
  }
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
/** Ordem estável e barata para ids (localeCompare custa caro nos laços da análise). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
