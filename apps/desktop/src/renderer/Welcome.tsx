import { useEffect, useState } from "react";

import { api } from "./client.js";

/** Primeira abertura: o usuário escolhe a pasta do workspace. Os arquivos do workspace ficam nela. */
export function Welcome() {
  const [defaultPath, setDefaultPath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api().defaultWorkspacePath().then(setDefaultPath);
  }, []);

  const choose = async (where: "default" | "pick") => {
    setBusy(true);
    setError(null);
    const outcome = await api().chooseWorkspace(where);
    // Com sucesso a janela recarrega já no workspace; aqui só sobra o erro ou a desistência.
    if (outcome && !outcome.ok) setError(outcome.message);
    setBusy(false);
  };

  return (
    <div className="welcome" data-testid="welcome">
      <div className="welcome-card">
        <h1>Onde fica seu workspace?</h1>
        <p>
          O workspace é uma pasta. Nela ficam o canvas e os repositórios que você baixar pela conversa. Diagramas e o que o agente aprende sobre cada
          repositório ficam dentro do próprio repositório, em <code>.open-semantic/</code>.
        </p>
        <button type="button" className="primary" disabled={busy || !defaultPath} onClick={() => void choose("default")} data-testid="welcome-default">
          Usar {defaultPath || "a pasta sugerida"}
        </button>
        <button type="button" disabled={busy} onClick={() => void choose("pick")}>
          Escolher outra pasta…
        </button>
        {error && <p className="welcome-error">{error}</p>}
      </div>
    </div>
  );
}
