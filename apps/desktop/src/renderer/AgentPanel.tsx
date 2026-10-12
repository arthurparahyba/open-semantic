import { useEffect, useRef, useState } from "react";

import type { AgentActivity, AgentSettingsView, ConversationView, ScriptInfo } from "../shared/api.js";
import { AgentSettingsDialog } from "./AgentSettingsDialog.js";
import { api, run } from "./client.js";

interface Props {
  hasProject: boolean;
  onError(message: string): void;
}

const STATUS_LABEL: Record<string, string> = {
  validating: "validando",
  awaiting_confirmation: "esperando você",
  running: "executando",
  completed: "concluído",
  partially_completed: "concluído em parte",
  failed: "falhou",
  rejected: "recusado pelo runtime",
  cancelled: "cancelado",
};

const STEP_ICON: Record<string, string> = {
  pending: "○",
  succeeded: "✓",
  failed: "✗",
  rejected: "✗",
  skipped: "↷",
  cancelled: "–",
  confirmation_required: "?",
};

const CONVERSATION_STATUS: Record<ConversationView["status"], string> = {
  idle: "",
  thinking: "pensando…",
  working: "executando…",
  waiting_user: "esperando sua confirmação",
};

export const formatUsd = (value: number) =>
  value === 0 ? "US$ 0" : value < 0.01 ? `US$ ${value.toFixed(4).replace(".", ",")}` : `US$ ${value.toFixed(2).replace(".", ",")}`;

type FeedItem = { at: string; key: string } & (
  | { kind: "entry"; entry: ConversationView["entries"][number] }
  | { kind: "script"; activity: AgentActivity }
);

/**
 * Conversa com o agente de IA. Cada lote de mudanças aparece como um cartão com os passos,
 * a confirmação quando precisa e o resultado efetivo. Os roteiros de teste do M2 continuam disponíveis.
 */
export function AgentPanel({ hasProject, onError }: Props) {
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [settings, setSettings] = useState<AgentSettingsView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyScript, setBusyScript] = useState(false);
  const feedEnd = useRef<HTMLLIElement>(null);
  const conversationBatches = useRef(new Set<string>());

  useEffect(() => {
    void api().agentScripts().then(setScripts);
    void api().agentActivity().then(setActivity);
    void api().conversation().then(setConversation);
    void api().agentSettings().then(setSettings);
    const offActivity = api().onAgentActivity((next) =>
      setActivity((list) => {
        const i = list.findIndex((a) => a.batchId === next.batchId);
        if (i < 0) return [...list, next];
        const copy = list.slice();
        copy[i] = next;
        return copy;
      }),
    );
    const offConversation = api().onConversation(setConversation);
    return () => {
      offActivity();
      offConversation();
    };
  }, []);

  const busy = conversation !== null && conversation.status !== "idle";
  const itemCount = (conversation?.entries.length ?? 0) + activity.length;
  useEffect(() => {
    feedEnd.current?.scrollIntoView?.({ block: "end" });
  }, [itemCount, conversation?.status]);

  const runScript = async (id: string) => {
    setBusyScript(true);
    try {
      const result = await api().runAgentScript(id);
      if (!result.ok) onError(result.message);
    } finally {
      setBusyScript(false);
    }
  };

  const sendChat = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const result = await api().sendChat(text);
    if (result.ok) setDraft("");
    else onError(result.message);
  };

  const resetChat = async () => {
    const result = await api().resetChat();
    if (!result.ok) onError(result.message);
  };

  // Os lotes da conversa aparecem no lugar onde foram pedidos; os dos roteiros, pela hora em que começaram.
  const byBatch = new Map(activity.map((a) => [a.batchId, a]));
  // Lotes de conversas anteriores (depois de "Nova conversa") também não voltam como se fossem de roteiros.
  for (const e of conversation?.entries ?? []) if (e.kind === "batch") conversationBatches.current.add(e.batchId);
  const inConversation = conversationBatches.current;
  const feed: FeedItem[] = [
    ...(conversation?.entries ?? []).map((entry): FeedItem => ({ kind: "entry", entry, at: entry.at, key: entry.id })),
    ...activity.filter((a) => !inConversation.has(a.batchId)).map((a): FeedItem => ({ kind: "script", activity: a, at: a.startedAt, key: a.batchId })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const model = settings?.models.find((m) => m.id === (conversation?.model ?? settings.model));
  const keyMissing = settings !== null && !settings.key.configured;

  return (
    <aside className="agent-panel" data-testid="agent-panel">
      <header className="agent-head">
        <div className="agent-head-row">
          <strong>Agente</strong>
          <span className="agent-head-actions">
            <button type="button" onClick={() => void resetChat()} disabled={busy || !conversation?.entries.length} title="Começa uma conversa nova (o histórico deixa de ser enviado ao modelo)">
              Nova conversa
            </button>
            <button type="button" onClick={() => setSettingsOpen(true)} title="Modelo, chave da API e teto de custo" aria-label="Configurações do agente" data-testid="agent-settings-button">
              ⚙
            </button>
          </span>
        </div>
        <span className="agent-sub" data-testid="agent-cost">
          {model?.label ?? "Claude"} · conversa {formatUsd(conversation?.costUsd ?? 0)}
          {conversation?.lastRequest ? ` · último pedido ${formatUsd(conversation.lastRequest.costUsd)}` : ""}
          {settings ? ` · teto ${formatUsd(settings.maxCostPerRequestUsd)} por pedido` : ""}
        </span>
      </header>

      <ol className="agent-feed" data-testid="agent-feed">
        {keyMissing && (
          <li className="agent-empty">
            <p>Para conversar com o Claude, coloque a sua chave da API da Anthropic.</p>
            <button type="button" className="primary" onClick={() => setSettingsOpen(true)}>
              Configurar chave
            </button>
          </li>
        )}
        {!keyMissing && feed.length === 0 && (
          <li className="agent-empty">
            <p>Peça algo sobre o seu projeto, por exemplo: “crie uma pasta api e mostre a arquitetura”.</p>
          </li>
        )}
        {feed.map((item) => {
          if (item.kind === "script") return <BatchCard key={item.key} activity={item.activity} onError={onError} />;
          const entry = item.entry;
          switch (entry.kind) {
            case "user":
              return (
                <li key={entry.id} className="chat-msg chat-user" data-testid="chat-user">
                  {entry.text}
                </li>
              );
            case "assistant":
              return (
                <li key={entry.id} className="chat-msg chat-assistant" data-testid="chat-assistant">
                  {entry.text}
                </li>
              );
            case "tool":
              return (
                <li key={entry.id} className="chat-tool">
                  {entry.text}
                </li>
              );
            case "notice":
              return (
                <li key={entry.id} className={`chat-notice tone-${entry.tone}`} data-testid="chat-notice">
                  {entry.text}
                </li>
              );
            case "batch": {
              const a = byBatch.get(entry.batchId);
              return a ? <BatchCard key={entry.id} activity={a} onError={onError} /> : null;
            }
          }
        })}
        {busy && (
          <li className="chat-progress" data-testid="chat-progress">
            {CONVERSATION_STATUS[conversation!.status]}
          </li>
        )}
        <li ref={feedEnd} aria-hidden className="feed-end" />
      </ol>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void sendChat();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          placeholder={keyMissing ? "Configure a chave para conversar" : hasProject ? "Peça algo ao agente…" : "Cole o caminho de uma pasta ou o link de um repositório…"}
          disabled={keyMissing}
          rows={2}
          data-testid="chat-input"
        />
        {busy ? (
          <button type="button" onClick={() => void api().stopChat()} data-testid="chat-stop">
            Parar
          </button>
        ) : (
          <button type="submit" className="primary" disabled={keyMissing || !draft.trim()} data-testid="chat-send">
            Enviar
          </button>
        )}
      </form>

      <details className="agent-scripts">
        <summary>Roteiros de teste (sem IA, sem custo)</summary>
        {scripts.map((s) => (
          <button key={s.id} type="button" disabled={!hasProject || busyScript || busy} onClick={() => void runScript(s.id)} title={s.description} data-script={s.id}>
            {s.title}
          </button>
        ))}
        {!hasProject && <p className="agent-note">Abra uma pasta para o agente ter onde trabalhar.</p>}
      </details>

      {settingsOpen && settings && (
        <AgentSettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </aside>
  );
}

/** Cartão de um lote: passos, confirmação (quando precisa), narração do resultado efetivo e sugestão de navegação. */
function BatchCard({ activity: a, onError }: { activity: AgentActivity; onError(message: string): void }) {
  const suggestion = a.steps.find((s) => s.output?.deferred === true);
  const respond = (approve: boolean) => void api().respondToAgent(a.batchId, approve);
  // O usuário aceita a sugestão de navegação que o agente deixou enquanto ele mexia no canvas.
  const acceptSuggestion = async (framedIds: string[]) => {
    const result = await run("navigation.frame", { targets: { visualIds: framedIds }, intent: "focus" });
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível mostrar.");
  };
  return (
    <li className={`agent-batch is-${a.status}`} data-testid="agent-batch" data-status={a.status}>
      <div className="agent-batch-head">
        <span className="agent-intent">“{a.intent}”</span>
        <span className={`agent-status s-${a.status}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
      </div>
      <ul className="agent-steps">
        {a.steps.map((s) => (
          <li key={s.stepId} className={`agent-step st-${s.status}`} title={s.error ?? s.operation}>
            <span className="agent-step-icon" aria-hidden>
              {STEP_ICON[s.status] ?? "·"}
            </span>
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
      {a.confirmation && (
        <div className={`confirm-card risk-${a.confirmation.risk}`} role="alertdialog" data-testid="confirm-card">
          <strong>O agente precisa da sua confirmação</strong>
          <ul>
            {a.confirmation.items.map((item) => (
              <li key={item.stepId}>{item.summary}</li>
            ))}
          </ul>
          <p className="agent-note">Nada deste pedido foi executado ainda.</p>
          <div className="confirm-actions">
            <button type="button" className="primary" onClick={() => respond(true)}>
              Aprovar
            </button>
            <button type="button" onClick={() => respond(false)}>
              Recusar
            </button>
          </div>
        </div>
      )}
      {a.summary && <p className="agent-summary">{a.summary}</p>}
      {suggestion && (
        <button type="button" className="suggestion" onClick={() => void acceptSuggestion(suggestion.output!.framedIds as string[])}>
          {String(suggestion.output!.reason ?? "Ver")} →
        </button>
      )}
    </li>
  );
}
