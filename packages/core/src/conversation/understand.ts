// Antes do modelo: do que a mensagem fala. O motor de contexto acha o assunto, pergunta quando a dúvida muda o foco,
// a câmera vai até o assunto e só ele (com um mapa enxuto do resto) vai junto do pedido, no bloco <workspace>.
import type { Dispatcher, WorkspaceSnapshot } from "@open-semantic/protocol";
import type { AttentionPort, Clarification, Relevance, TargetRef } from "@open-semantic/semantic-context";

import { WorkspaceContext, canvasAttention, layerView, topicReason } from "../context.js";
import type { Chat } from "./chat.js";
import { CLAUDE_AGENT } from "./types.js";
import { workspaceHeader } from "./workspaceSummary.js";

export class Understanding {
  readonly context: WorkspaceContext;
  private readonly attention: AttentionPort;
  /** Unidades dos últimos assuntos, da mais recente para a mais antiga. */
  private recent: string[] = [];
  private asking: { entryId: string; resolve: (ref: TargetRef | undefined) => void } | undefined;

  constructor(private readonly options: { dispatcher: Dispatcher; snapshot(): WorkspaceSnapshot; newId(): string; chat: Chat }) {
    this.context = new WorkspaceContext(options.snapshot);
    this.attention = canvasAttention({
      dispatcher: options.dispatcher,
      snapshot: options.snapshot,
      actor: CLAUDE_AGENT,
      newId: options.newId,
      ask: (question) => this.ask(question),
    });
  }

  /** O bloco <workspace> do pedido, ou undefined quando a pessoa parou na pergunta rápida. */
  async understand(message: string): Promise<string | undefined> {
    const snapshot = this.context.sync();
    const relevance = await this.relevance(message, snapshot);
    if (!relevance) return undefined;
    this.offerAssumptions(relevance);
    if (relevance.primaryTarget) {
      try {
        await this.attention.focus(relevance.primaryTarget, relevance.emphasis, topicReason(relevance, this.context.engine));
      } catch {
        // O foco ajuda, mas não pode derrubar o pedido.
      }
    }
    const main = relevance.topics[0];
    if (main) this.recent = [...main.unitIds, ...this.recent.filter((u) => !main.unitIds.includes(u))].slice(0, 8);
    const layer = layerView(snapshot);
    const pack = await this.context.engine.buildContext({ relevance, content: this.context.content(snapshot), ...(layer ? { layer } : {}) });
    return `${JSON.stringify(workspaceHeader(snapshot))}\n\n${pack.text}`;
  }

  /** O que a mensagem cita. Uma dúvida que muda o foco vira pergunta rápida, e a análise refaz com a resposta. */
  private async relevance(message: string, snapshot: WorkspaceSnapshot): Promise<Relevance | undefined> {
    const engine = this.context.engine;
    const choices: Record<string, string> = {};
    const input = () => ({ text: message, focus: { visibleIds: snapshot.navigation.focus.targetIds ?? [] }, recent: this.recent, choices });
    const first = engine.analyze(input());
    if (!first.question) return first;
    const answer = await this.attention.ask(first.question);
    if (!answer) return undefined;
    choices[first.question.term] = answer;
    this.options.chat.setStatus("thinking");
    return engine.analyze(input());
  }

  /** As suposições do motor aparecem no chat, com as alternativas para trocar. */
  private offerAssumptions(relevance: Relevance) {
    const engine = this.context.engine;
    for (const a of relevance.assumptions.slice(0, 2)) {
      this.options.chat.push({
        kind: "choice",
        mode: "assumption",
        term: a.term,
        text: `Supus que ${a.said} é ${engine.describe(a.chosen)}.`,
        options: [a.chosen, ...a.alternatives].slice(0, 6).map((ref) => ({ ref, label: engine.describe(ref) })),
        chosen: a.chosen,
      });
    }
  }

  /** Pergunta rápida no chat: o pedido espera a escolha (ou o Parar). */
  private ask(question: Clarification): Promise<TargetRef | undefined> {
    const { chat } = this.options;
    const { id: entryId } = chat.push({ kind: "choice", mode: "question", term: question.term, text: question.text, options: question.options });
    chat.setStatus("waiting_user");
    return new Promise((resolve) => {
      this.asking = {
        entryId,
        resolve: (ref) => {
          this.asking = undefined;
          resolve(ref);
        },
      };
    });
  }

  /**
   * Resposta a uma opção do motor de contexto. Na pergunta rápida, o pedido que esperava continua.
   * Numa suposição, a escolha passa a ser o assunto mais recente (os próximos pedidos partem dela)
   * e o foco vai para ela. Nenhuma das duas vira regra fixa: "o back-end" do portal não é o do app mobile.
   */
  choose(entryId: string, ref: string) {
    const entry = this.options.chat.choice(entryId);
    if (!entry || !entry.options.some((o) => o.ref === ref)) throw new Error("Opção desconhecida.");
    if (entry.mode === "question" && this.asking?.entryId !== entryId) throw new Error("Essa pergunta já foi respondida.");
    entry.chosen = ref;
    if (entry.mode === "question") {
      this.asking!.resolve(ref);
      return;
    }
    const label = entry.options.find((o) => o.ref === ref)!.label;
    entry.text = entry.text.replace(/ é .*\.$/, ` é ${label}.`);
    this.recent = [ref, ...this.recent.filter((u) => u !== ref)];
    this.options.chat.changed();
    void Promise.resolve(this.attention.focus(ref, [{ ref, level: "primary" }], `Assunto: ${label}`)).catch(() => {});
  }

  /** Parar: a pergunta rápida em aberto fica sem resposta, e o pedido termina antes do modelo. */
  cancel() {
    this.asking?.resolve(undefined);
  }

  /** Conversa nova: nenhum assunto recente. */
  reset() {
    this.recent = [];
  }
}
