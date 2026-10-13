// Pedido amplo: "como crio a funcionalidade X, da tela ao banco". Não é refinar um diagrama: a IA planeja as seções,
// desenha uma por vez numa camada própria para a discussão e só então apresenta. O motor de contexto não pergunta "de qual X".
import type { TurnLimits } from "./budget.js";
import { normalized } from "./text.js";

const PLANNING = [
  /\bcomo (eu )?(faco|faria|crio|criaria|criar|implemento|implementaria|implementar|adiciono|adicionar|construo|construir|desenvolvo|desenvolver|monto|montar|fazer) (uma|um|a|o|esse|essa|novas?|novos?)? ?(nova |novo )?(funcionalidade|feature|recurso|tela|cadastro|crud|modulo|servico|endpoint|api|fluxo)/,
  /\b(quero|queria|preciso|gostaria de|vou) (criar|implementar|adicionar|construir|desenvolver) (uma|um) (nova |novo )?(funcionalidade|feature|recurso|tela|cadastro|crud|modulo|servico)/,
  /\bdesde (a|o) .{1,40}\bate (o|a|os|as) /,
  /\bda tela (ate|ao|aos) /,
  /\bdo (front ?end|frontend) (ate|ao) /,
  /\b(planeje|planejar|planejamento|me ajude a planejar|passo a passo para (criar|implementar|construir))\b/,
];

/** O pedido é amplo, de planejamento (várias partes do sistema), e pede um plano com vários diagramas? */
export function asksForPlanning(message: string): boolean {
  const text = normalized(message);
  return PLANNING.some((re) => re.test(text));
}

/** Instrução que vai junto do pedido amplo para o modelo. */
export const PLANNING_HINT =
  "[app] Pedido amplo, de planejamento. Não pergunte de qual parte o usuário fala: cubra todas as que o pedido precisa. " +
  "Primeiro leia o suficiente do projeto para seguir os padrões dele. Depois abra uma camada para esta discussão com layer.create " +
  "(ancorada no elemento da visão geral de onde ela nasce, normalmente o sistema ou a camada que muda) e, nela, responda como um documento: " +
  "um show_blocks com o título e o plano em passos curtos; depois uma seção por parte, cada uma com seu show_diagram (heading e intro) " +
  "do tipo certo: wireframe para a tela nova, architecture para controller, serviço e repositório, sequence para o caminho da requisição " +
  "da tela ao banco, e o modelo de dados (tabelas e relações). O que ainda não existe no código é suposição (caixas sem path). " +
  "No fim, uma legenda curta dizendo a camada criada e as seções desenhadas.";

/** Resposta curta que só aceita todas as opções ("todos", "tanto faz"): vira "decida você e cubra todas". */
export function acceptsAll(message: string): boolean {
  return /^(todos|todas|ambos|ambas|os dois|as duas|tanto faz|qualquer( um| uma)?|todos? (os|as )?(que )?(for|forem) necessari[oa]s?|todos? eles|todas? elas)$/.test(
    normalized(message),
  );
}

export const ACCEPT_ALL_HINT =
  "[app] O usuário respondeu à pergunta do app com \"todos\": considere todas as opções que o pedido anterior precisa e continue o pedido anterior, sem perguntar de novo.";

/** Tetos de um pedido amplo: o dobro de chamadas, lotes e passos (o teto de custo do usuário continua valendo). */
export function planningLimits(limits: TurnLimits): TurnLimits {
  return { ...limits, maxModelCalls: limits.maxModelCalls * 2, maxBatches: limits.maxBatches * 2, maxSteps: limits.maxSteps * 2, maxTokens: limits.maxTokens * 2 };
}
