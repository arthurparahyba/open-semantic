import { basename, join } from "node:path";

import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";

import { createCore, type Core } from "@open-semantic/core";

import { CHANNELS, type UiOperationRequest } from "../shared/api.js";

// Variáveis usadas pelos testes de ponta a ponta para isolar dados e pular o diálogo de pasta.
const dataDir = process.env.OPEN_SEMANTIC_DATA_DIR ?? app.getPath("userData");
const testFolder = process.env.OPEN_SEMANTIC_TEST_FOLDER;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

/** Tudo que chega pela interface é ação do usuário local. A interface não pode se passar pelo agente. */
const LOCAL_USER = { kind: "user" as const, id: "local" };

let core: Core | undefined;
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
  core = await createCore({
    dataDir,
    onRevision: (revision) => send(CHANNELS.revision, revision),
    onPersist: (status) => send(CHANNELS.persist, status),
    onEvent: (event) => send(CHANNELS.event, event),
  });

  ipcMain.handle(CHANNELS.dispatch, (_event, request: UiOperationRequest) =>
    core!.dispatcher.dispatch({ ...request, authorization: { actor: LOCAL_USER } }),
  );
  ipcMain.handle(CHANNELS.snapshot, () => core!.store.snapshot());
  ipcMain.handle(CHANNELS.pickFolder, async () => {
    let path = testFolder;
    if (!path) {
      const result = await dialog.showOpenDialog(window!, { title: "Abrir pasta do projeto", properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0]) return null;
      path = result.filePaths[0];
    }
    return { path, name: basename(path) };
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
