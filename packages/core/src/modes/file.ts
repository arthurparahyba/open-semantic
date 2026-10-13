// Um modo de execução escrito em texto: cabeçalho com quando ativa e como interage, e o corpo com as instruções.
// É assim que o usuário (e o workspace) criam modos novos sem mudar código:
//
//   ---
//   id: revisao
//   nome: Revisão de código
//   ativa-quando: revisar, revisão, code review, o que está errado
//   cadencia: etapas            (ou: uma-vez)
//   proximos-passos: Ver o próximo arquivo | Corrigir isto | Encerrar
//   orcamento: grande           (ou: normal)
//   ---
//   Instruções em texto livre para o agente.
import { normalized } from "../conversation/text.js";
import type { ExecutionMode } from "./index.js";

export class ModeFileError extends Error {}

/** O modo descrito pelo arquivo. `ativa-quando` é uma lista de frases; a mensagem que contém uma delas ativa o modo. */
export function parseModeFile(text: string, fallbackId = "modo"): ExecutionMode {
  const { head, instructions } = split(text);
  const triggers = (head.get("ativa-quando") ?? "")
    .split(",")
    .map((t) => normalized(t))
    .filter(Boolean);
  if (!triggers.length) throw new ModeFileError("falta 'ativa-quando' com ao menos uma frase.");
  if (!instructions) throw new ModeFileError("falta o texto com as instruções do modo, depois do cabeçalho.");
  const id = normalized(head.get("id") ?? fallbackId).replace(/ /g, "-");
  const cadence = /etapa/.test(normalized(head.get("cadencia") ?? "")) ? "steps" : "once";
  const next = (head.get("proximos-passos") ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const big = normalized(head.get("orcamento") ?? "") === "grande";
  return {
    id,
    name: head.get("nome") ?? id,
    activatesWhen: (message, state) => {
      const text = ` ${normalized(message)} `;
      return triggers.some((t) => text.includes(` ${t} `)) || (cadence === "steps" && state.previous === id && normalized(message).split(" ").length <= 12);
    },
    cadence,
    instructions: `[app] Modo: ${head.get("nome") ?? id}. ${instructions}`,
    ...(next.length ? { nextSteps: next.slice(0, 4) } : {}),
    ...(big ? { limits: (base) => ({ ...base, maxModelCalls: base.maxModelCalls * 2, maxBatches: base.maxBatches * 2, maxSteps: base.maxSteps * 2 }) } : {}),
  };
}

/** O cabeçalho (chave: valor) e o corpo do arquivo. */
function split(text: string): { head: Map<string, string>; instructions: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n").trimStart());
  if (!m) throw new ModeFileError("o arquivo precisa começar com um cabeçalho entre linhas '---'.");
  const head = new Map<string, string>();
  for (const line of m[1]!.split("\n")) {
    const kv = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) head.set(normalized(kv[1]!).replace(/ /g, "-"), kv[2]!.trim());
  }
  return { head, instructions: m[2]!.trim() };
}
