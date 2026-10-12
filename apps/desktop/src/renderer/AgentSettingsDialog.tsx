import { useState } from "react";

import type { AgentSettingsView } from "../shared/api.js";
import { api } from "./client.js";

interface Props {
  settings: AgentSettingsView;
  onChange(settings: AgentSettingsView): void;
  onClose(): void;
}

const KEY_SOURCE: Record<AgentSettingsView["key"]["source"], string> = {
  saved: "guardada cifrada neste computador",
  memory: "guardada só até fechar o app (o sistema não ofereceu um cofre para cifrar)",
  env: "lida da variável ANTHROPIC_API_KEY",
  test: "provedor de teste (sem rede)",
  none: "nenhuma",
};

/** Modelo, teto de custo e chave da API. A chave vai direto ao processo principal e nunca volta para cá. */
export function AgentSettingsDialog({ settings, onChange, onClose }: Props) {
  const [key, setKey] = useState("");
  const [cost, setCost] = useState(String(settings.maxCostPerRequestUsd).replace(".", ","));
  const [message, setMessage] = useState<string | null>(null);

  const saveKey = async () => {
    const result = await api().setApiKey(key);
    if (result.ok) {
      setKey("");
      setMessage("Chave salva.");
      onChange(result.view);
    } else setMessage(result.message);
  };

  const removeKey = async () => {
    const result = await api().setApiKey(null);
    if (result.ok) onChange(result.view);
  };

  const saveModel = async (model: string) => onChange(await api().saveAgentSettings({ model }));

  const saveCost = async () => {
    const value = Number(cost.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      setMessage("O teto precisa ser um valor em dólares maior que zero, como 0,10.");
      return;
    }
    onChange(await api().saveAgentSettings({ maxCostPerRequestUsd: value }));
    setMessage("Teto salvo.");
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Configurações do agente" data-testid="agent-settings">
        <header className="dialog-head">
          <strong>Agente de IA</strong>
          <button type="button" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </header>

        <section>
          <h4>Chave da API da Anthropic</h4>
          <p className="agent-note">
            Atual: {KEY_SOURCE[settings.key.source]}
            {settings.key.hint ? ` (${settings.key.hint})` : ""}. Crie uma em console.anthropic.com. O uso é cobrado na conta da API, separado da
            assinatura do Claude.
          </p>
          <div className="dialog-row">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
              spellCheck={false}
              data-testid="api-key-input"
            />
            <button type="button" className="primary" disabled={!key.trim()} onClick={() => void saveKey()}>
              Salvar
            </button>
            {(settings.key.source === "saved" || settings.key.source === "memory") && (
              <button type="button" onClick={() => void removeKey()}>
                Remover
              </button>
            )}
          </div>
        </section>

        <section>
          <h4>Modelo</h4>
          <div className="model-list">
            {settings.models.map((m) => (
              <label key={m.id} className="model-option">
                <input type="radio" name="model" checked={settings.model === m.id} onChange={() => void saveModel(m.id)} />
                <span>
                  <strong>{m.label}</strong> · US$ {fmt(m.inputPerMTok)} entrada / US$ {fmt(m.outputPerMTok)} saída por milhão de tokens
                  <br />
                  <span className="agent-note">{m.note}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h4>Teto de custo por pedido</h4>
          <p className="agent-note">O agente para antes da chamada que passaria deste valor e avisa. Você pode pedir para continuar.</p>
          <div className="dialog-row">
            <span>US$</span>
            <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" data-testid="max-cost-input" />
            <button type="button" onClick={() => void saveCost()}>
              Salvar
            </button>
          </div>
        </section>

        {message && <p className="dialog-message">{message}</p>}
      </div>
    </div>
  );
}

const fmt = (n: number) => n.toFixed(2).replace(".", ",");
