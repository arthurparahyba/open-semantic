import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";

import { Conversation, ConversationBusyError, SCRIPTS, ScriptError, createCore, scriptedPlan, type Core } from "@open-semantic/core";
import { withoutBefore } from "@open-semantic/workspace-store";

import { AgentSettings } from "./agentSettings.js";
import { WorkspaceChoice } from "./workspaceChoice.js";

import { CHANNELS, type UiOperationRequest } from "../shared/api.js";

// Variáveis usadas pelos testes de ponta a ponta para isolar dados e pular os diálogos de pasta.
const dataDir = process.env.OPEN_SEMANTIC_DATA_DIR ?? app.getPath("userData");
const testFolder = process.env.OPEN_SEMANTIC_TEST_FOLDER;
/** Pasta do workspace já definida (testes); sem ela, vale a última escolhida pelo usuário. */
const forcedWorkspace = process.env.OPEN_SEMANTIC_WORKSPACE;
const defaultWorkspace = process.env.OPEN_SEMANTIC_DEFAULT_WORKSPACE ?? join(app.getPath("home"), "Open Semantic");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
/** Só nos testes: respostas prontas no lugar do Claude (sem rede e sem custo). */
const scriptedLlm = process.env.OPEN_SEMANTIC_SCRIPTED_LLM;

/** Tudo que chega pela interface é ação do usuário local. A interface não pode se passar pelo agente. */
const LOCAL_USER = { kind: "user" as const, id: "local" };

let core: Core | undefined;
let conversation: Conversation | undefined;
let window: BrowserWindow | undefined;
let quitting = false;

function send(channel: string, value: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: "Open Semantic",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links externos abrem no navegador, nunca dentro do app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  const settings = await AgentSettings.load(dataDir, scriptedLlm);
  const choice = new WorkspaceChoice(dataDir);
  const failure = (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) });
  const noWorkspace = { ok: false as const, message: "Escolha a pasta do workspace primeiro." };

  /** Abre o workspace da pasta (fechando o anterior) e liga a conversa a ele. */
  const openWorkspace = async (path: string) => {
    conversation?.stop();
    await core?.close();
    core = undefined;
    conversation = undefined;
    await mkdir(path, { recursive: true });
    const opened = await createCore({
      workspaceDir: path,
      // Só o valor novo de cada mudança vai para a interface: ela não precisa do anterior.
      onCommit: (commit) => send(CHANNELS.commit, withoutBefore(commit)),
      onPersist: (status) => send(CHANNELS.persist, status),
      onEvent: (event) => send(CHANNELS.event, event),
      onActivity: (activity) => send(CHANNELS.agentActivity, activity),
    });
    core = opened;
    conversation = new Conversation({
      provider: () => settings.activeProvider(),
      settings: () => settings.current(),
      dispatcher: opened.dispatcher,
      agent: opened.agent,
      snapshot: () => opened.store.snapshot(),
      onChange: (view) => send(CHANNELS.chatChanged, view),
    });
  };

  const initial = forcedWorkspace ?? (await choice.recent());
  if (initial) await openWorkspace(initial);

  ipcMain.handle(CHANNELS.workspaceInfo, () => (core ? { path: core.workspaceDir, name: core.store.read().workspace.name } : null));
  ipcMain.handle(CHANNELS.workspaceDefault, () => defaultWorkspace);
  ipcMain.handle(CHANNELS.workspaceChoose, async (_event, where: unknown) => {
    let path = where === "default" ? defaultWorkspace : undefined;
    if (!path) {
      const result = await dialog.showOpenDialog(window!, {
        title: "Pasta do workspace",
        buttonLabel: "Usar esta pasta",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      path = result.filePaths[0];
    }
    try {
      await openWorkspace(path);
      await choice.remember(path);
    } catch (err) {
      return failure(err);
    }
    window?.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.agentSettings, () => settings.view());
  ipcMain.handle(CHANNELS.agentSettingsSave, (_event, patch: { model?: unknown; maxCostPerRequestUsd?: unknown }) =>
    settings.update({
      ...(typeof patch?.model === "string" ? { model: patch.model } : {}),
      ...(typeof patch?.maxCostPerRequestUsd === "number" ? { maxCostPerRequestUsd: patch.maxCostPerRequestUsd } : {}),
    }),
  );
  ipcMain.handle(CHANNELS.agentKey, (_event, key: unknown) => settings.setKey(typeof key === "string" ? key : null));
  ipcMain.handle(CHANNELS.chat, () => conversation?.view() ?? null);
  ipcMain.handle(CHANNELS.chatSend, (_event, text: unknown) => {
    if (!conversation) return noWorkspace;
    if (typeof text !== "string" || !text.trim()) return { ok: false, message: "Escreva um pedido." };
    if (conversation.view().status !== "idle") return failure(new ConversationBusyError("O agente ainda está trabalhando no pedido anterior."));
    // Não espera o pedido terminar: o progresso chega pelo canal de mudanças da conversa.
    void conversation.send(text).catch(() => {});
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.chatStop, () => conversation?.stop());
  ipcMain.handle(CHANNELS.chatChoose, (_event, entryId: unknown, ref: unknown) => {
    if (!conversation) return noWorkspace;
    try {
      conversation.choose(String(entryId), String(ref));
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });
  ipcMain.handle(CHANNELS.chatReset, () => {
    try {
      conversation?.reset();
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle(CHANNELS.dispatch, (_event, request: UiOperationRequest) => {
    if (!core) throw new Error(noWorkspace.message);
    return core.dispatcher.dispatch({ ...request, authorization: { actor: LOCAL_USER } });
  });
  ipcMain.handle(CHANNELS.snapshot, () => core?.store.snapshot() ?? null);
  ipcMain.handle(CHANNELS.workspaceState, () => (core ? { snapshot: core.store.snapshot(), sequence: core.store.sequence } : null));
  ipcMain.handle(CHANNELS.pickFolder, async () => {
    let path = testFolder;
    if (!path) {
      const result = await dialog.showOpenDialog(window!, { title: "Abrir pasta do projeto", properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0]) return null;
      path = result.filePaths[0];
    }
    return { path, name: basename(path) };
  });

  ipcMain.on(CHANNELS.viewport, (_event, viewport: { width: number; height: number }) => {
    if (typeof viewport?.width === "number" && typeof viewport?.height === "number") core?.setViewport(viewport);
  });
  ipcMain.handle(CHANNELS.agentScripts, () => SCRIPTS);
  ipcMain.handle(CHANNELS.agentActivityList, () => core?.agent.list() ?? []);
  ipcMain.handle(CHANNELS.agentRun, async (_event, scriptId: string) => {
    if (!core) return noWorkspace;
    try {
      // O plano é montado aqui, no processo principal: a interface só escolhe o roteiro.
      await core!.agent.run(scriptedPlan(String(scriptId), core!.store.snapshot()));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof ScriptError || err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(CHANNELS.agentRespond, async (_event, batchId: string, approve: boolean) => {
    await core?.agent.respond(String(batchId), approve === true);
  });

  createWindow();
});

// Antes de sair, grava o que estiver pendente.
app.on("before-quit", (event) => {
  if (quitting || !core) return;
  event.preventDefault();
  quitting = true;
  void core.close().finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());
