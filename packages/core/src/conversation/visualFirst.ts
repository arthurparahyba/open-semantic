// Visual first: um pedido de entendimento termina num diagrama, e a resposta é a legenda do que foi desenhado.
import type { WorkspaceSnapshot } from "@open-semantic/protocol";

import { normalized } from "./text.js";

/** Revisão de cada diagrama, para saber o que um pedido desenhou ou mudou. */
export function diagramRevisions(snapshot: WorkspaceSnapshot): Map<string, number> {
  return new Map(snapshot.diagrams.map((d) => [d.id, d.revision]));
}

export function changedDiagrams(before: Map<string, number>, snapshot: WorkspaceSnapshot): string[] {
  return snapshot.diagrams.filter((d) => before.get(d.id) !== d.revision).map((d) => d.id);
}

const EXPLAIN = [
  /\b(bpmn|modelo de dados|processo de negocio|fluxo de negocio|diagrama er)\b/,
  /\bexpli(que|ca|car|cacao|ca-me|que-me)\b/,
  /\bcomo (funciona|e organizad|esta organizad|se organiza|e a arquitetura|flui|passa)/,
  /\bdesenh[ae]\b/,
  /\b(arquitetura|fluxo|visao geral|overview|estrutura|dependencias|camadas|implementad[ao]|implementacao|sequencia)\b/,
  /\bo que (e|faz) (o|a|esse|essa|este|esta) (projeto|repositorio|sistema|aplicacao|app|modulo|servico)\b/,
  /\b(entender|compreender|conhecer) (o|a|esse|essa|este|esta)\b/,
  /\bpor onde (passa|anda|vai)\b/,
  /\b(wireframe|mockup|como (e|sao|fica|ficam) (a|as) (tela|telas|pagina|paginas|interface)|tela (inicial|principal|de))\b/,
  /\b(explain|how does|walk me through|overview|architecture)\b/,
];

/**
 * O pedido é de entendimento de estrutura ou fluxo (a resposta deve ser um diagrama)?
 * Pergunta pontual ("qual a versão do Java?") não entra: a resposta é uma linha de texto.
 */
export function asksForExplanation(message: string): boolean {
  const text = normalized(message);
  return EXPLAIN.some((re) => re.test(text));
}

/** Tipos de diagrama que o app sabe sugerir pelo pedido. */
export type SuggestedKind = "layers" | "sequence" | "tree" | "wireframe" | "bpmn" | "er";

const KIND_HINTS: [SuggestedKind, RegExp][] = [
  ["bpmn", /\b(bpmn|processo de negocio|fluxo de negocio|processo (do|da|de) (cadastro|venda|compra|atendimento|pedido))\b/],
  ["er", /\b(modelo de dados|diagrama er|entidade.relacionamento|tabelas? do banco|quais (sao )?as tabelas|estrutura do banco)\b/],
  ["layers", /\b(camadas?|layers?|niveis|tiers?|frontend.{0,20}backend.{0,20}(banco|dados)|apresentacao.{0,30}(dominio|negocio|infra))\b/],
  ["tree", /\b(como (o|a)? ?(repositorio|projeto|monorepo|codigo|pastas?) (esta|e|foi) (dividid|organizad|estruturad)|estrutura de pastas|arvore|pastas e (modulos|pacotes)|quais (sao )?os (pacotes|modulos))/],
  ["wireframe", /\b(wireframe|mockup|como (e|sao|fica|ficam|seria) (a|as) (tela|telas|interface|pagina|paginas)|(tela|pagina) (inicial|principal))\b/],
  [
    "sequence",
    /\b(como (esta|foi|e) implementad|implementacao d|como funciona (a|o) (funcionalidade|fluxo|recurso|login|cadastro|salvamento|requisicao)|o que acontece quando|passo a passo|sequencia|quando (o usuario|eu) (clic|salv|envi|abr))/,
  ],
  // Tela citada de passagem ("o que acontece quando clico na tela") fica com a sequência acima.
  ["wireframe", /\b(telas?|interface (grafica|do usuario)|o que (o usuario|eu) ve(jo)?)\b/],
];

/**
 * A forma sugerida para o diagrama, pelo jeito da pergunta: camadas, sequência, árvore ou wireframe.
 * Sem sugestão, o modelo escolhe pelo guia do show_diagram (visão geral, fluxo, dependências).
 */
export function suggestDiagramKind(message: string): SuggestedKind | undefined {
  const text = normalized(message);
  return KIND_HINTS.find(([, re]) => re.test(text))?.[0];
}

const KIND_REASON: Record<SuggestedKind, string> = {
  layers: "o pedido é sobre os níveis da aplicação",
  sequence: "o pedido é sobre como uma funcionalidade acontece passo a passo",
  tree: "o pedido é sobre como o código está dividido",
  wireframe: "o pedido é sobre como a tela se parece",
  bpmn: "o pedido é sobre um processo de negócio",
  er: "o pedido é sobre as tabelas e relações dos dados",
};

/** A dica que vai junto do pedido para o modelo. */
export function kindHint(message: string): string | undefined {
  const kind = suggestDiagramKind(message);
  return kind && `[app] Forma sugerida para o diagrama: ${kind} (${KIND_REASON[kind]}).`;
}

/** Mensagem do app para o modelo quando uma explicação terminou sem diagrama. Vai uma vez por pedido. */
export const VISUAL_NUDGE =
  "[app] Este pedido é de entendimento de estrutura ou fluxo e a resposta terminou sem diagrama. Responda desenhando: chame show_diagram (se já existe diagrama sobre o assunto no <workspace>, use o mesmo diagramId para completá-lo) com o que você já leu, e deixe o texto final como uma legenda curta que cita as caixas do desenho.";

export const isAppNote = (text: string) => text.startsWith("[app] ");
