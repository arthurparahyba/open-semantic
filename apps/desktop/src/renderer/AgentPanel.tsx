import { useEffect, useState } from "react";

import type { AgentActivity, ScriptInfo } from "../shared/api.js";
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

/**
 * Atividade do agente. No M2 o agente é roteirizado (sem IA): os botões escolhem um roteiro.
 * Cada lote mostra seus passos, o cartão de confirmação quando precisa e a narração do resultado efetivo.
 */
export function AgentPanel({ hasProject, onError }: Props) {
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api().agentScripts().then(setScripts);
    void api().agentActivity().then(setActivity);
    return api().onAgentActivity((next) =>
      setActivity((list) => {
        const i = list.findIndex((a) => a.batchId === next.batchId);
        if (i < 0) return [...list, next];
        const copy = list.slice();
        copy[i] = next;
        return copy;
      }),
    );
  }, []);

  const runScript = async (id: string) => {
    setBusy(true);
    try {
      const result = await api().runAgentScript(id);
      if (!result.ok) onError(result.message);
    } finally {
      setBusy(false);
    }
  };

  const respond = (batchId: string, approve: boolean) => void api().respondToAgent(batchId, approve);

  // O usuário aceita a sugestão de navegação que o agente deixou enquanto ele mexia no canvas.
  const acceptSuggestion = async (framedIds: string[]) => {
    const result = await run("navigation.frame", { targets: { visualIds: framedIds }, intent: "focus" });
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível mostrar.");
  };

  return (
    <aside className="agent-panel" data-testid="agent-panel">
      <header className="agent-head">
        <strong>Agente</strong>
        <span className="agent-sub">roteirizado, sem IA · a conversa com o Claude chega no próximo passo</span>
      </header>
      <div className="agent-scripts">
        {scripts.map((s) => (
          <button key={s.id} type="button" disabled={!hasProject || busy} onClick={() => void runScript(s.id)} title={s.description} data-script={s.id}>
            {s.title}
          </button>
        ))}
        {!hasProject && <p className="agent-note">Abra uma pasta para o agente ter onde trabalhar.</p>}
      </div>
      <ol className="agent-feed">
        {activity
          .slice()
          .reverse()
          .map((a) => {
            const suggestion = a.steps.find((s) => s.output?.deferred === true);
            return (
              <li key={a.batchId} className={`agent-batch is-${a.status}`} data-testid="agent-batch" data-status={a.status}>
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
                      <button type="button" className="primary" onClick={() => respond(a.batchId, true)}>
                        Aprovar
                      </button>
                      <button type="button" onClick={() => respond(a.batchId, false)}>
                        Recusar
                      </button>
                    </div>
                  </div>
                )}
                {a.summary && <p className="agent-summary">{a.summary}</p>}
                {suggestion && (
                  <button
                    type="button"
                    className="suggestion"
                    onClick={() => void acceptSuggestion(suggestion.output!.framedIds as string[])}
                  >
                    {String(suggestion.output!.reason ?? "Ver")} →
                  </button>
                )}
              </li>
            );
          })}
      </ol>
    </aside>
  );
}
