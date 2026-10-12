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
  dispatch: (request) => ipcRenderer.invoke(CHANNELS.dispatch, request),
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  onRevision: (listener) => subscribe(CHANNELS.revision, listener),
  onPersist: (listener) => subscribe(CHANNELS.persist, listener),
  onEvent: (listener) => subscribe(CHANNELS.event, listener),
};

contextBridge.exposeInMainWorld("openSemantic", api);
