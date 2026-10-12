import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceInfo } from "../shared/api.js";
import { App } from "./App.js";
import { api } from "./client.js";
import { Welcome } from "./Welcome.js";
import "./styles.css";

/** Sem workspace escolhido, mostra a escolha da pasta; com ele, o canvas. */
function Root() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined);
  useEffect(() => {
    void api().workspaceInfo().then(setWorkspace);
  }, []);
  if (workspace === undefined) return <div className="splash">Abrindo workspace…</div>;
  if (workspace === null) return <Welcome />;
  return <App workspace={workspace} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
