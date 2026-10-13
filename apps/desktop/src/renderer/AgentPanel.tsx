import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DiagramModel } from "@open-semantic/protocol";

import type { AgentActivity, AgentSettingsView, ConversationView, ScriptInfo } from "../shared/api.js";
import { AgentSettingsDialog } from "./AgentSettingsDialog.js";
import { api, run } from "./client.js";

interface Props {
  hasProject: boolean;
  /** Diagramas do workspace, para a resposta mostrar e abrir o que desenhou. */
  diagrams: Pick<DiagramModel, "id" | "title">[];
  onShowDiagram(diagramId: string): void;
  onError(message: string): void;
  /** O histórico completo fica num painel sob demanda, fechado por padrão. */
  historyOpen: boolean;
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
export function AgentPanel({ hasProject, diagrams, onShowDiagram, onError, historyOpen }: Props) {
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
  // A pergunta rápida não trava o envio: uma mensagem nova descarta as opções e segue.
  const asking = conversation?.entries.some((e) => e.kind === "choice" && e.mode === "question" && !e.chosen && !e.dismissed) ?? false;
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (input.current) grow(input.current);
  }, [draft]);
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

  const sendText = async (text: string, fromDraft: boolean, mode?: string) => {
    if (!text || (busy && !asking)) return;
    const result = await api().sendChat(text, mode);
    if (result.ok) {
      if (fromDraft) setDraft("");
    } else onError(result.message);
  };
  const sendChat = () => sendText(draft.trim(), true);

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

  const entries = conversation?.entries ?? [];
  const pendingQuestion = [...entries].reverse().find((e): e is ChoiceEntry => e.kind === "choice" && e.mode === "question" && !e.chosen && !e.dismissed);
  const pendingConfirm = activity.find((a) => a.confirmation && a.status === "awaiting_confirmation");
  const last = entries[entries.length - 1];
  const lastAnswer = !busy && last?.kind === "assistant" && (last.mode || last.next?.length) ? last : undefined;
  const lastNotice = !busy && last?.kind === "notice" && last.tone !== "info" ? last : undefined;
  const status = useThrottled(busy ? liveStatus(conversation!, activity, asking) : "", 2500);

  const dock = (
    <div className="chat-dock" data-testid="chat-dock" hidden={!status && !pendingQuestion && !pendingConfirm && !lastAnswer && !lastNotice}>
      {pendingConfirm && (
        <div className={`dock-confirm risk-${pendingConfirm.confirmation!.risk}`} role="alertdialog" data-testid="dock-confirm">
          <strong>Posso seguir? Nada foi executado ainda.</strong>
          <ul>
            {pendingConfirm.confirmation!.items.map((item) => (
              <li key={item.stepId}>{item.summary}</li>
            ))}
          </ul>
          <div className="confirm-actions">
            <button type="button" className="primary" onClick={() => void api().respondToAgent(pendingConfirm.batchId, true)}>
              Aprovar
            </button>
            <button type="button" onClick={() => void api().respondToAgent(pendingConfirm.batchId, false)}>
              Recusar
            </button>
          </div>
        </div>
      )}
      {pendingQuestion && !pendingConfirm && (
        <div className="dock-question" data-testid="dock-question">
          <span>{pendingQuestion.text}</span>
          <span className="chat-choice-options">
            {pendingQuestion.options.map((o) => (
              <button
                type="button"
                key={o.ref}
                onClick={() => void api().chooseInChat(pendingQuestion.id, o.ref).then((r) => (r.ok ? undefined : onError(r.message)))}
                data-testid="dock-option"
              >
                {o.label}
              </button>
            ))}
          </span>
          <span className="dock-hint">ou responda com suas palavras abaixo</span>
        </div>
      )}
      {lastAnswer && <NextSteps entry={lastAnswer} modes={conversation?.modes ?? []} disabled={false} send={(text, mode) => void sendText(text, false, mode)} />}
      {lastNotice && <span className={`dock-notice tone-${lastNotice.tone}`}>{lastNotice.text}</span>}
      {status && !pendingConfirm && !pendingQuestion && (
        <span className="dock-status" data-testid="dock-status" aria-live="polite">
          {status}
        </span>
      )}
    </div>
  );

  const composer = (
    <div className="chat-bottom">
      {dock}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void sendChat();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            grow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          placeholder={keyMissing ? "Configure a chave para conversar" : hasProject ? "Peça algo ao agente…" : "Cole o caminho de uma pasta ou o link de um repositório…"}
          disabled={keyMissing}
          rows={1}
          ref={input}
          data-testid="chat-input"
        />
        {keyMissing && (
          <button type="button" onClick={() => setSettingsOpen(true)}>
            Configurar chave
          </button>
        )}
        {busy && !asking ? (
          <button type="button" onClick={() => void api().stopChat()} data-testid="chat-stop">
            Parar
          </button>
        ) : (
          <button type="submit" className="primary" disabled={keyMissing || !draft.trim()} data-testid="chat-send" title={asking ? "A mensagem nova descarta as opções e segue no lugar delas" : undefined}>
            Enviar
          </button>
        )}
      </form>
    </div>
  );

  return (
    <>
      {createPortal(composer, document.body)}
      {settingsOpen && settings && <AgentSettingsDialog settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
      {historyOpen && (
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
                <li key={entry.id} className={`chat-msg chat-assistant${entry.diagramIds?.length ? " is-visual" : ""}`} data-testid="chat-assistant">
                  {entry.diagramIds
                    ?.map((id) => diagrams.find((d) => d.id === id))
                    .filter((d) => d !== undefined)
                    .map((d) => (
                      <button key={d.id} type="button" className="chat-diagram" data-testid="chat-diagram" onClick={() => onShowDiagram(d.id)} title="Mostrar no canvas">
                        <span aria-hidden>◇</span> {d.title}
                      </button>
                    ))}
                  {entry.text && <span className="chat-caption">{entry.text}</span>}
                  <NextSteps entry={entry} modes={conversation?.modes ?? []} disabled={busy && !asking} send={(text, mode) => void sendText(text, false, mode)} />
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
            case "choice":
              return <ChoiceCard key={entry.id} entry={entry} onError={onError} />;
          }
        })}
        {busy && (
          <li className="chat-progress" data-testid="chat-progress">
            {asking ? "esperando sua resposta" : CONVERSATION_STATUS[conversation!.status]}
          </li>
        )}
        <li ref={feedEnd} aria-hidden className="feed-end" />
      </ol>


      <details className="agent-scripts">
        <summary>Roteiros de teste (sem IA, sem custo)</summary>
        {scripts.map((s) => (
          <button key={s.id} type="button" disabled={!hasProject || busyScript || busy} onClick={() => void runScript(s.id)} title={s.description} data-script={s.id}>
            {s.title}
          </button>
        ))}
        {!hasProject && <p className="agent-note">Abra uma pasta para o agente ter onde trabalhar.</p>}
      </details>

    </aside>
      )}
    </>
  );
}

/** Uma linha só sobre o que está acontecendo agora: o passo do lote em curso, a última ferramenta ou o estado da conversa. */
function liveStatus(conversation: ConversationView, activity: AgentActivity[], asking: boolean): string {
  if (asking) return "esperando sua resposta";
  if (conversation.status === "waiting_user") return CONVERSATION_STATUS.waiting_user;
  const running = activity.find((a) => a.status === "running");
  const step = running?.steps.find((s) => s.status === "pending");
  if (step) return `${step.label}…`;
  const last = conversation.entries[conversation.entries.length - 1];
  if (last?.kind === "tool") return last.text;
  return CONVERSATION_STATUS[conversation.status];
}

/** Segura o texto por alguns segundos para a linha de status não virar uma enxurrada; mudanças para vazio passam na hora. */
function useThrottled(value: string, ms: number): string {
  const [shown, setShown] = useState(value);
  const since = useRef(0);
  useEffect(() => {
    if (value === shown) return;
    const wait = !value || !shown ? 0 : Math.max(0, since.current + ms - Date.now());
    const t = setTimeout(() => {
      since.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, shown, ms]);
  return shown;
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

/** A caixa começa com uma linha e cresce até 10; dali em diante, rolagem. */
function grow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

type ChoiceEntry = Extract<ConversationView["entries"][number], { kind: "choice" }>;

/**
 * Pergunta rápida do motor de contexto (o pedido espera a escolha) ou suposição feita por ele.
 * Na suposição, as outras opções ficam a um clique ("Trocar") e valem para os próximos pedidos.
 */
function ChoiceCard({ entry, onError }: { entry: ChoiceEntry; onError(message: string): void }) {
  const [open, setOpen] = useState(entry.mode === "question" && !entry.chosen);
  const choose = async (ref: string) => {
    const result = await api().chooseInChat(entry.id, ref);
    if (!result.ok) onError(result.message);
    else setOpen(false);
  };
  const pending = entry.mode === "question" && !entry.chosen && !entry.dismissed;
  return (
    <li className={`chat-choice mode-${entry.mode}`} data-testid="chat-choice">
      <span>
        {entry.text}
        {entry.mode === "question" && entry.chosen ? ` Resposta: ${entry.options.find((o) => o.ref === entry.chosen)?.label ?? ""}.` : ""}
      </span>
      {entry.mode === "assumption" && !open && (
        <button type="button" className="link" onClick={() => setOpen(true)} data-testid="chat-choice-change">
          Trocar
        </button>
      )}
      {open && (
        <span className="chat-choice-options">
          {entry.options.map((o) => (
            <button
              type="button"
              key={o.ref}
              className={o.ref === entry.chosen ? "primary" : ""}
              disabled={entry.mode === "question" && !pending}
              onClick={() => void choose(o.ref)}
              data-testid="chat-choice-option"
            >
              {o.label}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}

/** O modo que conduziu a resposta; um clique abre os outros modos para refazer o mesmo pedido. */
function ModeChip({ mode, modes, disabled, onRedo }: { mode: { id: string; name: string }; modes: { id: string; name: string }[]; disabled: boolean; onRedo: (modeId: string) => void }) {
  const [open, setOpen] = useState(false);
  const others = modes.filter((m) => m.id !== mode.id);
  return (
    <span className="chat-mode-wrap">
      <button type="button" className="chat-mode" data-testid="chat-mode" disabled={disabled || !others.length} onClick={() => setOpen(!open)} title="Refazer este pedido em outro modo">
        {mode.name} ▾
      </button>
      {open &&
        others.map((m) => (
          <button
            key={m.id}
            type="button"
            className="chat-next-step"
            data-testid="chat-mode-option"
            onClick={() => {
              setOpen(false);
              onRedo(m.id);
            }}
          >
            Refazer como {m.name.toLowerCase()}
          </button>
        ))}
    </span>
  );
}

/** O chip do modo e os botões de próximo passo, embaixo da resposta: avançar sem digitar. */
function NextSteps({ entry, modes, disabled, send }: { entry: Extract<ConversationView["entries"][number], { kind: "assistant" }>; modes: { id: string; name: string }[]; disabled: boolean; send: (text: string, mode?: string) => void }) {
  const { mode, next = [] } = entry;
  if (!mode && !next.length) return null;
  return (
    <div className="chat-next" data-testid="chat-next">
      {mode && <ModeChip mode={mode} modes={modes} disabled={disabled} onRedo={(modeId) => send(mode.request, modeId)} />}
      {next.map((step) => (
        <button key={step} type="button" className="chat-next-step" disabled={disabled} onClick={() => send(step)}>
          {step}
        </button>
      ))}
    </div>
  );
}
