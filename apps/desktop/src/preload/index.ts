import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { CHANNELS, type OpenSemanticApi } from "../shared/api.js";

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: OpenSemanticApi = {
  workspaceInfo: () => ipcRenderer.invoke(CHANNELS.workspaceInfo),
  defaultWorkspacePath: () => ipcRenderer.invoke(CHANNELS.workspaceDefault),
  chooseWorkspace: (where) => ipcRenderer.invoke(CHANNELS.workspaceChoose, where),
  dispatch: (request) => ipcRenderer.invoke(CHANNELS.dispatch, request),
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  onRevision: (listener) => subscribe(CHANNELS.revision, listener),
  onPersist: (listener) => subscribe(CHANNELS.persist, listener),
  onEvent: (listener) => subscribe(CHANNELS.event, listener),
  setViewport: (viewport) => ipcRenderer.send(CHANNELS.viewport, viewport),
  agentScripts: () => ipcRenderer.invoke(CHANNELS.agentScripts),
  runAgentScript: (scriptId) => ipcRenderer.invoke(CHANNELS.agentRun, scriptId),
  respondToAgent: (batchId, approve) => ipcRenderer.invoke(CHANNELS.agentRespond, batchId, approve),
  agentActivity: () => ipcRenderer.invoke(CHANNELS.agentActivityList),
  onAgentActivity: (listener) => subscribe(CHANNELS.agentActivity, listener),
  agentSettings: () => ipcRenderer.invoke(CHANNELS.agentSettings),
  saveAgentSettings: (patch) => ipcRenderer.invoke(CHANNELS.agentSettingsSave, patch),
  setApiKey: (key) => ipcRenderer.invoke(CHANNELS.agentKey, key),
  conversation: () => ipcRenderer.invoke(CHANNELS.chat),
  onConversation: (listener) => subscribe(CHANNELS.chatChanged, listener),
  sendChat: (text) => ipcRenderer.invoke(CHANNELS.chatSend, text),
  stopChat: () => ipcRenderer.invoke(CHANNELS.chatStop),
  chooseInChat: (entryId, ref) => ipcRenderer.invoke(CHANNELS.chatChoose, entryId, ref),
  resetChat: () => ipcRenderer.invoke(CHANNELS.chatReset),
};

contextBridge.exposeInMainWorld("openSemantic", api);
