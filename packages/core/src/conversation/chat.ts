// O que a interface mostra de um pedido em andamento: as entradas do chat e o status. Cada mudança avisa a interface.
import type { ChatEntry, ChoiceEntry, ConversationView, NewChatEntry } from "./types.js";

export class Chat {
  entries: ChatEntry[] = [];
  status: ConversationView["status"] = "idle";

  constructor(private readonly options: { newId(): string; now(): Date; changed(): void }) {}

  push(entry: NewChatEntry): ChatEntry {
    const full = { ...entry, id: `ent_${this.options.newId()}`, at: this.options.now().toISOString() } as ChatEntry;
    this.entries.push(full);
    this.changed();
    return full;
  }

  notice(text: string, tone: "info" | "limit" | "error") {
    this.push({ kind: "notice", text, tone });
  }

  setStatus(status: ConversationView["status"]) {
    this.status = status;
    this.changed();
  }

  /** Avisa a interface de uma mudança feita numa entrada que já estava no chat. */
  changed() {
    this.options.changed();
  }

  choice(entryId: string): ChoiceEntry | undefined {
    return this.entries.find((e): e is ChoiceEntry => e.id === entryId && e.kind === "choice");
  }

  /** A resposta do pedido entra antes dos avisos dele (limite, interrupção), na ordem em que o usuário leu. */
  answer(text: string, diagramIds: string[], extra?: { mode?: { id: string; name: string; request: string }; next?: string[] }) {
    const trailing: ChatEntry[] = [];
    while (this.entries.length && this.entries[this.entries.length - 1]!.kind === "notice") trailing.unshift(this.entries.pop()!);
    this.push({ kind: "assistant", text, ...(diagramIds.length ? { diagramIds } : {}), ...extra });
    if (trailing.length) {
      this.entries.push(...trailing);
      this.changed();
    }
  }

  clear() {
    this.entries = [];
  }
}
