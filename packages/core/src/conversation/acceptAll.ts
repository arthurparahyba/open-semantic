// "todos" respondendo à pergunta rápida: o pedido anterior continua, cobrindo todas as opções.
import { normalized } from "./text.js";

/** Resposta curta que só aceita todas as opções ("todos", "tanto faz"). */
export function acceptsAll(message: string): boolean {
  return /^(todos|todas|ambos|ambas|os dois|as duas|tanto faz|qualquer( um| uma)?|todos? (os|as )?(que )?(for|forem) necessari[oa]s?|todos? eles|todas? elas)$/.test(
    normalized(message),
  );
}

export const ACCEPT_ALL_HINT =
  "[app] O usuário respondeu à pergunta do app com \"todos\": considere todas as opções que o pedido anterior precisa e continue o pedido anterior, sem perguntar de novo.";
