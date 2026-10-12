// Contratos do Motor de contexto semântico (docs/funcionalidades/08-gestao-de-contexto.md).
// O motor não importa nenhum outro pacote do app: tudo o que ele sabe entra por estes tipos,
// e tudo o que ele faz sai pelas portas que o app implementa.

/** Id estável do workspace: unidade (sem_), diagrama (dgm_), nó (nd_), aresta (edg_), mod (mod_), região (rgn_). */
export type TargetRef = string;

/** Uma coisa que pode ser encontrada pela busca. O adaptador do app traduz o workspace nisto. */
export interface IndexDoc {
  id: TargetRef;
  kind: "unit" | "diagram" | "node" | "edge" | "mod" | "region";
  /** Nome ou rótulo principal (peso maior na busca). */
  name: string;
  aliases?: string[];
  description?: string;
  /** Texto de apoio: tipo da entidade, papel, título do diagrama de um nó… (peso menor). */
  extra?: string;
  /** Unidades de contexto a que este item pertence (para uma unidade, ela mesma). */
  unitIds: TargetRef[];
  /** Diagrama que contém o nó ou a aresta. */
  diagramId?: TargetRef;
  /** Tipo do diagrama (do próprio diagrama, ou do diagrama que contém o nó/aresta). */
  diagramKind?: string;
  /** Para unidades: tipo semântico (repository, module, service, concept…). */
  unitKind?: string;
  /** Para arestas: nós das pontas. */
  sourceId?: TargetRef;
  targetId?: TargetRef;
  /** Qualidade do conhecimento; `rejected`/`invalid` nunca entram como fato. */
  status?: string;
  /** Projeto (repositório) do item, quando houver. */
  projectId?: string;
}

/** Ligação entre unidades: relação semântica, `contains` (pai → filho) ou aresta de diagrama entre unidades. */
export interface UnitLink {
  from: TargetRef;
  to: TargetRef;
  type: string;
}

/** Atualização do índice. O app envia o estado das coisas que mudaram; o motor ignora o que já sabe igual. */
export interface IndexUpdate {
  upsert?: IndexDoc[];
  remove?: TargetRef[];
  /** Quando presente, substitui todas as ligações entre unidades. */
  links?: UnitLink[];
}

/** O que está na tela agora: selecionado, enquadrado, aberto. */
export interface VisualFocus {
  selectedIds?: TargetRef[];
  visibleIds?: TargetRef[];
}

/** Unidades que foram assunto nos pedidos recentes, da mais recente para a mais antiga. */
export type RecentTopics = TargetRef[];

/** Um assunto da mensagem, já como unidade de contexto. */
export interface Topic {
  /** A unidade principal do assunto. */
  unitId: TargetRef;
  /** Todas as unidades do assunto (a principal primeiro). */
  unitIds: TargetRef[];
  /** Elementos achados (nós, arestas, diagramas) que pertencem ao assunto. */
  refs: TargetRef[];
  salience: number;
}

export interface Assumption {
  /** O termo da mensagem que tinha mais de um candidato. */
  term: string;
  chosen: TargetRef;
  alternatives: TargetRef[];
  why: "selection" | "recent" | "graph" | "margin";
}

export interface Clarification {
  term: string;
  text: string;
  options: { ref: TargetRef; label: string }[];
}

export interface Relevance {
  /** Ordenados por saliência; topics[0] é o assunto principal. */
  topics: Topic[];
  /** Onde a câmera deve ir: o lugar com mais detalhe sobre o assunto principal. */
  primaryTarget?: TargetRef;
  emphasis: { ref: TargetRef; level: "primary" | "secondary" }[];
  assumptions: Assumption[];
  /** Só quando a dúvida está no assunto principal e muda o foco. */
  question?: Clarification;
  timings: { analyzeMs: number };
}

/** Como o motor pede reações visuais. Não sabe o que é câmera, nó ou canvas. */
export interface AttentionPort {
  focus(target: TargetRef, reason: string): void | Promise<void>;
  emphasize(items: Relevance["emphasis"]): void | Promise<void>;
  clear(): void | Promise<void>;
  ask(question: Clarification): Promise<TargetRef | undefined>;
}

export type DetailLevel = 0 | 1 | 2 | 3;

/** Como o motor obtém conteúdo que não está no índice (trechos de arquivo, seções de documento). */
export interface ContentPort {
  read(ref: TargetRef, level: DetailLevel): Promise<string | undefined>;
}

export interface TokenBudget {
  /** Tokens para o pacote de contexto do pedido (sem histórico nem instruções). */
  context: number;
}

export interface ContextItem {
  ref: TargetRef;
  level: DetailLevel;
  tokens: number;
  why: string;
}

export interface ContextPack {
  /** Texto compacto pronto para ir no prompt. */
  text: string;
  items: ContextItem[];
  /** Itens que ficaram de fora por orçamento. */
  dropped: TargetRef[];
  tokens: number;
}
