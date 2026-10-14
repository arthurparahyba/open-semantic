// O avaliador do teste de uso: o Opus com esforço baixo olha o screenshot e o resumo do workspace a cada passo,
// julga explicação, diagramas e organização do canvas, e responde perguntas do agente no lugar do usuário.
// Chamada direta à API (sem SDK) para não somar dependência ao app.
import { readFile } from "node:fs/promises";

export const MODELO_AVALIADOR = process.env.USO_MODELO_AVALIADOR ?? "claude-opus-5-5";
// US$ por milhão de tokens do Opus 5.5 (packages/llm/src/anthropic.ts).
const PRECO = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export interface Avaliacao {
  passo: string;
  nota: number;
  explicacao: string;
  organizacao: { nota: number; comentario: string };
  bugs: string[];
  melhorias: string[];
}

export const gasto = { chamadas: 0, entrada: 0, saida: 0, usd: 0 };

const SISTEMA =
  "Você é um usuário experiente avaliando o Open Semantic, um app desktop em que um agente explica e especifica software " +
  "com diagramas num canvas, organizados em camadas (base = discovery do repositório; camada 2 = especificação com BPMN, " +
  "wireframe, sequência e ER; camada 3 = \"Implementação: <assunto>\", que gera specs/<assunto>.md e tem o botão Copiar pedido). " +
  "Seja direto e crítico, em português. Ao avaliar a organização do canvas, julgue se o conjunto é legível como um todo: " +
  "diagramas relacionados próximos e agrupados por contexto, sem distâncias desnecessárias (por exemplo um BPMN largo no topo " +
  "e a tela jogada longe, no canto inferior), sem sobreposição, sem confusão, cada diagrama claro e o fluxo de leitura evidente. " +
  "Não exija posições fixas. Bug é algo que está quebrado ou errado; melhoria é o que deixaria a experiência melhor. " +
  "Responda só com JSON válido, sem texto em volta.";

async function chamar(conteudo: unknown[], maxTokens = 1500): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY ausente");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODELO_AVALIADOR,
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      system: SISTEMA,
      messages: [{ role: "user", content: conteudo }],
    }),
  });
  if (!res.ok) throw new Error(`avaliador: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  const u = body.usage;
  gasto.chamadas++;
  gasto.entrada += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  gasto.saida += u.output_tokens;
  gasto.usd +=
    (u.input_tokens * PRECO.input + u.output_tokens * PRECO.output + (u.cache_read_input_tokens ?? 0) * PRECO.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRECO.cacheWrite) / 1e6;
  return body.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function json<T>(texto: string, padrao: T): T {
  const m = texto.match(/\{[\s\S]*\}/);
  try {
    return m ? (JSON.parse(m[0]) as T) : padrao;
  } catch {
    return padrao;
  }
}

/** Julga um passo do roteiro pelo screenshot e pelo resumo do workspace. */
export async function avaliar(passo: string, objetivo: string, screenshot: string, resumo: unknown, resposta: string): Promise<Avaliacao> {
  const imagem = (await readFile(screenshot)).toString("base64");
  const texto = await chamar([
    { type: "image", source: { type: "base64", media_type: "image/png", data: imagem } },
    {
      type: "text",
      text:
        `Passo: ${passo}\nO que o usuário espera: ${objetivo}\n\nÚltima resposta do agente:\n${resposta.slice(0, 3000)}\n\n` +
        `Resumo do workspace (camadas, diagramas e posições no canvas):\n${JSON.stringify(resumo)}\n\n` +
        'Responda: {"nota":1-5,"explicacao":"por que a nota, 2 a 4 frases","organizacao":{"nota":1-5,"comentario":"..."},' +
        '"bugs":["..."],"melhorias":["..."]}',
    },
  ]);
  const r = json<Omit<Avaliacao, "passo">>(texto, { nota: 0, explicacao: `resposta ilegível do avaliador: ${texto.slice(0, 300)}`, organizacao: { nota: 0, comentario: "" }, bugs: [], melhorias: [] });
  return { passo, ...r };
}

/** Responde, como o usuário, a uma pergunta que o agente fez com opções. */
export async function escolher(objetivo: string, pergunta: string, opcoes: string[]): Promise<number> {
  const texto = await chamar(
    [{ type: "text", text: `Você é o usuário e quer: ${objetivo}\nO agente perguntou: ${pergunta}\nOpções: ${opcoes.map((o, i) => `${i}) ${o}`).join("; ")}\nResponda {"opcao": índice}.` }],
    200,
  );
  const i = json<{ opcao: number }>(texto, { opcao: 0 }).opcao;
  return Number.isInteger(i) && i >= 0 && i < opcoes.length ? i : 0;
}

/** Junta os achados de todos os passos numa lista priorizada de bugs e melhorias. */
export async function consolidar(avaliacoes: Avaliacao[], falhas: string[]): Promise<{ bugs: string[]; melhorias: string[]; resumo: string }> {
  const texto = await chamar(
    [
      {
        type: "text",
        text:
          `Avaliações por passo:\n${JSON.stringify(avaliacoes)}\n\nChecagens determinísticas que falharam:\n${JSON.stringify(falhas)}\n\n` +
          'Consolide sem repetir, do mais importante para o menos: {"resumo":"2 a 3 frases sobre a experiência","bugs":["..."],"melhorias":["..."]}',
      },
    ],
    2000,
  );
  return json(texto, { resumo: texto.slice(0, 500), bugs: [], melhorias: [] });
}
