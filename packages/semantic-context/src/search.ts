// Índice invertido em memória com pontuação BM25 (da família do TF-IDF, mais precisa para textos curtos
// como rótulos de diagrama). Atualizado por item: só o que mudou é reindexado.
import type { IndexDoc } from "./types.js";
import { terms } from "./text.js";

/** Peso de cada campo na contagem de termos. Nome e alias valem mais que descrição. */
const FIELD_WEIGHT = { name: 3, aliases: 3, id: 1.5, extra: 1, description: 0.7 } as const;
const K1 = 1.2;
const B = 0.5;
/**
 * Termos comuns (achados em milhares de itens) só percorrem os itens em que pesam mais, além dos já achados
 * por termos raros: o resto não chegaria ao topo e custaria a maior parte do tempo.
 */
const COMMON_LIMIT = 300;

interface Entry {
  doc: IndexDoc;
  tf: Map<string, number>;
  /** Termos do nome, aliases, id e texto de apoio (sem a descrição): o que identifica o item. */
  strong: Set<string>;
  length: number;
  hash: string;
}

export interface TermHit {
  score: number;
  /** Quanto cada termo da consulta contribuiu. */
  byTerm: Map<string, number>;
}

export interface QueryTerm {
  term: string;
  /** O termo original da mensagem a que este pertence (sinônimos apontam para ele). */
  origin: string;
  weight: number;
}

function idTerms(id: string): string[] {
  return terms(id.replace(/^[a-z]+_/, "").replace(/[_-]+/g, " "));
}

export class SearchIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;
  /** Termo comum → os itens em que ele pesa mais, em ordem. Refeito quando o índice muda. */
  private readonly topByTerm = new Map<string, string[]>();

  get size() {
    return this.entries.size;
  }

  get(id: string): IndexDoc | undefined {
    return this.entries.get(id)?.doc;
  }

  docs(): IterableIterator<IndexDoc> {
    return (function* (entries: Map<string, Entry>) {
      for (const e of entries.values()) yield e.doc;
    })(this.entries);
  }

  /** Grava ou troca um item. Devolve false quando nada mudou. */
  upsert(doc: IndexDoc): boolean {
    const hash = JSON.stringify(doc);
    const current = this.entries.get(doc.id);
    if (current?.hash === hash) return false;
    if (current) this.remove(doc.id);
    this.topByTerm.clear();
    const tf = new Map<string, number>();
    const add = (text: string | undefined, weight: number) => {
      if (!text) return;
      for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + weight);
    };
    add(doc.name, FIELD_WEIGHT.name);
    for (const a of doc.aliases ?? []) add(a, FIELD_WEIGHT.aliases);
    // O id de uma unidade é escolhido para ser lido (sem_backend); o de nós e arestas repete o diagrama e só faz ruído.
    if (doc.kind === "unit") for (const t of idTerms(doc.id)) tf.set(t, (tf.get(t) ?? 0) + FIELD_WEIGHT.id);
    add(doc.extra, FIELD_WEIGHT.extra);
    const strong = new Set(tf.keys());
    add(doc.description, FIELD_WEIGHT.description);
    let length = 0;
    for (const v of tf.values()) length += v;
    this.entries.set(doc.id, { doc, tf, strong, length, hash });
    this.totalLength += length;
    for (const t of tf.keys()) {
      let set = this.postings.get(t);
      if (!set) this.postings.set(t, (set = new Set()));
      set.add(doc.id);
    }
    return true;
  }

  remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.topByTerm.clear();
    this.entries.delete(id);
    this.totalLength -= entry.length;
    for (const t of entry.tf.keys()) {
      const set = this.postings.get(t);
      set?.delete(id);
      if (set && !set.size) this.postings.delete(t);
    }
  }

  /** O item tem algum destes termos no nome, alias, id ou texto de apoio? */
  identifiedBy(id: string, forms: string[]): boolean {
    const entry = this.entries.get(id);
    return !!entry && forms.some((f) => entry.strong.has(f));
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** BM25 sobre os termos da consulta. Termos repetidos (sinônimos do mesmo termo) contam uma vez por item. */
  search(query: QueryTerm[]): Map<string, TermHit> {
    const out = new Map<string, TermHit>();
    const n = this.entries.size;
    if (!n || !query.length) return out;
    const avg = this.totalLength / n || 1;
    const part = (entry: Entry, term: string, f: number, idf: number) => idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * entry.length) / avg)));
    const add = (id: string, origin: string, value: number) => {
      let hit = out.get(id);
      if (!hit) out.set(id, (hit = { score: 0, byTerm: new Map() }));
      // Sinônimos do mesmo termo não somam: vale o melhor.
      const previous = hit.byTerm.get(origin) ?? 0;
      if (value > previous) {
        hit.score += value - previous;
        hit.byTerm.set(origin, value);
      }
    };
    // Raros primeiro: quando chega a vez de um termo comum, os itens que importam já estão em `out`.
    const ordered = query
      .map((q) => ({ q, posting: this.postings.get(q.term) }))
      .filter((x): x is { q: QueryTerm; posting: Set<string> } => !!x.posting)
      .sort((a, b) => a.posting.size - b.posting.size);
    for (const { q, posting } of ordered) {
      const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
      if (posting.size <= COMMON_LIMIT) {
        for (const id of posting) {
          const entry = this.entries.get(id)!;
          add(id, q.origin, q.weight * part(entry, q.term, entry.tf.get(q.term)!, idf));
        }
        continue;
      }
      for (const id of [...out.keys()]) {
        const entry = this.entries.get(id)!;
        const f = entry.tf.get(q.term);
        if (f) add(id, q.origin, q.weight * part(entry, q.term, f, idf));
      }
      for (const id of this.top(q.term, posting, idf)) {
        const entry = this.entries.get(id)!;
        add(id, q.origin, q.weight * part(entry, q.term, entry.tf.get(q.term)!, idf));
      }
    }
    return out;
  }

  private top(term: string, posting: Set<string>, idf: number): string[] {
    let list = this.topByTerm.get(term);
    if (list) return list;
    const avg = this.totalLength / this.entries.size || 1;
    const score = new Map<string, number>();
    for (const id of posting) {
      const entry = this.entries.get(id)!;
      const f = entry.tf.get(term)!;
      score.set(id, idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * entry.length) / avg))));
    }
    list = [...posting].sort((a, b) => score.get(b)! - score.get(a)! || (a < b ? -1 : a > b ? 1 : 0)).slice(0, COMMON_LIMIT);
    this.topByTerm.set(term, list);
    return list;
  }
}
