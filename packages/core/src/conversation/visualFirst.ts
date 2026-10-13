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
  /\bexpli(que|ca|car|cacao|ca-me|que-me)\b/,
  /\bcomo (funciona|e organizad|esta organizad|se organiza|e a arquitetura|flui|passa)/,
  /\bdesenh[ae]\b/,
  /\b(arquitetura|fluxo|visao geral|overview|estrutura|dependencias|camadas)\b/,
  /\bo que (e|faz) (o|a|esse|essa|este|esta) (projeto|repositorio|sistema|aplicacao|app|modulo|servico)\b/,
  /\b(entender|compreender|conhecer) (o|a|esse|essa|este|esta)\b/,
  /\bpor onde (passa|anda|vai)\b/,
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

/** Mensagem do app para o modelo quando uma explicação terminou sem diagrama. Vai uma vez por pedido. */
export const VISUAL_NUDGE =
  "[app] Este pedido é de entendimento de estrutura ou fluxo e a resposta terminou sem diagrama. Responda desenhando: chame show_diagram (se já existe diagrama sobre o assunto no <workspace>, use o mesmo diagramId para completá-lo) com o que você já leu, e deixe o texto final como uma legenda curta que cita as caixas do desenho.";

export const isAppNote = (text: string) => text.startsWith("[app] ");
