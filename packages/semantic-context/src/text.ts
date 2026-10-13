// Normalização de texto para a busca: minúsculas, sem acento, plural simples e sinônimos do domínio.
// Tudo determinístico e barato: nada aqui chama rede ou modelo.

const STOPWORDS = new Set(
  (
    "a o os as um uma uns umas de do da dos das no na nos nas em e ou que se para pra pro por com como ao aos " +
    "e eh ser esta estao este esse essa isso isto aquele aquela ela ele eles elas eu voce voces nos me mim meu minha " +
    "seu sua seus suas sobre entre mais muito muita ja nao sim tem ter ha foi era sao pelo pela pelos pelas entao " +
    "aqui ali la tambem so quando onde qual quais porque quem cada todo toda todos todas outro outra mas porem " +
    "fazer faz faca mostre mostra mostrar crie cria criar ajuste ajusta altere mude adicione explique desenhe refine " +
    "detalhe abra compare liste veja ver quero preciso pode poderia favor ok certo acho hoje ontem agora " +
    "the an of to in on for and or is are was with how what which this that it its be do does please show " +
    "ponto principal principalmente especificamente importante foco problema verdade " +
    "interacao integracao funciona funcionamento desenhado esta"
  ).split(/\s+/),
);

/**
 * Sinônimos do domínio. A primeira palavra é a forma canônica. Aliases das entidades não precisam estar
 * aqui: eles já entram no índice como nomes alternativos.
 */
export const DEFAULT_SYNONYMS: string[][] = [
  ["backend", "back", "servidor", "server"],
  ["frontend", "front", "web", "ui", "tela", "spa"],
  ["banco", "database", "db", "bd"],
  ["autenticacao", "auth", "login", "autenticar"],
  ["pagamento", "payment", "pagar"],
  ["usuario", "user"],
  ["pedido", "order"],
  ["fila", "queue", "mensageria", "broker"],
];

export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

/** Separa camelCase e números antes de baixar a caixa: OrderService → Order Service. */
function splitCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/** Plural e variações simples do português, só o suficiente para "servicos" achar "servico". */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("coes")) return word.slice(0, -4) + "cao";
  if (word.endsWith("oes") || word.endsWith("aes")) return word.slice(0, -3) + "ao";
  if (word.length > 4 && word.endsWith("ais")) return word.slice(0, -3) + "al";
  if (word.length > 4 && word.endsWith("eis")) return word.slice(0, -3) + "el";
  if (word.length > 4 && (word.endsWith("res") || word.endsWith("zes"))) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ns")) return word.slice(0, -2) + "m";
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function prepare(text: string): string {
  return stripAccents(splitCase(text))
    .toLowerCase()
    .replace(/\bback[\s_-]?end\b/g, "backend")
    .replace(/\bfront[\s_-]?end\b/g, "frontend")
    .replace(/\be-mail\b/g, "email");
}

/** Termos de um texto, na ordem, já sem acento, sem palavras vazias e no singular. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of prepare(text).split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!STOPWORDS.has(s)) out.push(s);
  }
  return out;
}

/** Termos com a palavra como apareceu no texto (para perguntar "de qual back-end?" com as palavras do usuário). */
export function termsWithRaw(text: string): { term: string; raw: string }[] {
  const out: { term: string; raw: string }[] = [];
  const re = /back[\s_-]?end|front[\s_-]?end|[\p{L}\p{N}]+/giu;
  for (const m of text.matchAll(re)) {
    for (const term of terms(m[0])) out.push({ term, raw: m[0] });
  }
  return out;
}

export class Synonyms {
  private readonly canonical = new Map<string, string>();
  private readonly groups = new Map<string, string[]>();

  constructor(groups: string[][] = DEFAULT_SYNONYMS) {
    for (const group of groups) {
      const words = group.map((w) => stem(stripAccents(w.toLowerCase())));
      const head = words[0]!;
      this.groups.set(head, words);
      for (const w of words) this.canonical.set(w, head);
    }
  }

  /** Forma canônica de um termo (ou o próprio termo). */
  canon(term: string): string {
    return this.canonical.get(term) ?? term;
  }

  /** O termo e seus sinônimos, todos no formato do índice. */
  expand(term: string): string[] {
    const head = this.canonical.get(term);
    return head ? this.groups.get(head)! : [term];
  }
}

export interface Sentence {
  index: number;
  raw: string;
  weight: number;
  isQuestion: boolean;
}

const QUESTION_START = /^(como|qual|quais|onde|por que|porque|o que|quem|quando|quanto|existe|tem|ha)\b/;
const REQUEST_START =
  /^(voce pode |pode |por favor |quero que |preciso que |queria que )?(mostr|cri|fac|ajust|alter|mud|adicion|expliq|explic|desenh|refin|detalh|foc|abr|compar|list|revis|corrij|melhor|inclu|remov|separ|organiz|document)/;
const EMPHASIS = /\b(o ponto|principal|principalmente|especificamente|importante|o foco|o problema|na verdade|o que importa|preciso entender)\b/;
const CONTRAST_START = /^(mas|porem|entretanto|contudo|so que)\b/;
const BACKGROUND = /\b(ontem|antes|ja revisei|revisei|esta ok|estao ok|tudo certo|ja esta|ja estao|tranquilo)\b/;

/**
 * Quebra o texto em frases e dá um peso a cada uma: pedidos e perguntas pesam mais que contexto,
 * marcadores como "o ponto aqui é" multiplicam o peso, e a última pergunta ou pedido vale mais.
 */
export function sentences(text: string): Sentence[] {
  const parts = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = parts.map((raw, index): Sentence => {
    const flat = stripAccents(raw).toLowerCase();
    const isQuestion = raw.endsWith("?") || QUESTION_START.test(flat);
    const isRequest = REQUEST_START.test(flat);
    let weight = 1;
    if (isQuestion) weight *= 1.5;
    else if (isRequest) weight *= 1.4;
    if (EMPHASIS.test(flat)) weight *= 1.8;
    if (CONTRAST_START.test(flat)) weight *= 1.2;
    if (BACKGROUND.test(flat) && !EMPHASIS.test(flat)) weight *= 0.5;
    return { index, raw, weight, isQuestion: isQuestion || isRequest };
  });
  const last = [...out].reverse().find((s) => s.isQuestion);
  if (last && out.length > 1) last.weight *= 1.3;
  return out;
}

/** Estimativa local de tokens (calibrada depois pelo uso real que o provedor devolve). */
export function estimateTokens(text: string, charsPerToken = 3.5): number {
  return Math.ceil(text.length / charsPerToken);
}
