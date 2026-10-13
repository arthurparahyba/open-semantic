// O histórico que vai ao modelo: toda chamada de ferramenta respondida e, quando fica longo, compactado.
import type { ChatMessage, ToolCall } from "@open-semantic/llm";

import { isAppNote } from "./visualFirst.js";

/** Toda chamada de ferramenta precisa de resposta antes da próxima mensagem, ou a API recusa o histórico. */
export function closePendingCalls(history: ChatMessage[], calls: ToolCall[], reason: string) {
  if (calls.length) history.push({ role: "tool", results: calls.map((c) => ({ callId: c.id, content: reason, isError: true })) });
}

/** Depois de um erro no meio do laço: as chamadas da última resposta do modelo ficam respondidas como não executadas. */
export function closeDangling(history: ChatMessage[]) {
  const last = history[history.length - 1];
  if (last?.role === "assistant" && last.toolCalls.length) closePendingCalls(history, last.toolCalls, "Interrompido; não executado.");
}

/**
 * Compacta os pedidos anteriores sem chamar o modelo: fica o que o usuário pediu, o que o agente respondeu
 * e o resultado real de cada lote (`batchTools`: as ferramentas que rodam lotes). Saem o resumo do workspace
 * daquela hora, as leituras de arquivo e pasta e os detalhes das chamadas de ferramenta (o agente consulta de novo se precisar).
 */
export function compactHistory(history: ChatMessage[], batchTools: ReadonlySet<string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  let request: { user: string; replies: string[]; facts: string[] } | undefined;
  const flush = () => {
    if (!request) return;
    out.push({ role: "user", text: request.user });
    const parts = [...request.replies];
    if (request.facts.length) parts.push(`[Resultado dos lotes]\n${request.facts.join("\n")}`);
    out.push({ role: "assistant", text: parts.join("\n\n") || "(sem resposta)", toolCalls: [] });
  };
  for (const m of history) {
    if (m.role === "user") {
      if (isAppNote(m.text)) continue;
      flush();
      request = { user: m.text.replace(/^<workspace>[\s\S]*?<\/workspace>\s*/, ""), replies: [], facts: [] };
    } else if (m.role === "assistant") {
      if (m.text) request?.replies.push(m.text);
      for (const c of m.toolCalls) toolNames.set(c.id, c.name);
    } else {
      const batches = m.results.filter((r) => batchTools.has(toolNames.get(r.callId) ?? ""));
      request?.facts.push(...batches.map((r) => batchFact(r.content)));
    }
  }
  flush();
  return out;
}

/** O que fica de um lote no histórico compactado: o resumo que o usuário viu, ou o status. */
function batchFact(content: string): string {
  try {
    const parsed = JSON.parse(content) as { status?: string; summaryShownToUser?: string; error?: string };
    return parsed.summaryShownToUser ?? `Lote ${parsed.status ?? "?"}${parsed.error ? `: ${parsed.error}` : ""}`;
  } catch {
    return `Lote não executado: ${content.slice(0, 200)}`;
  }
}
