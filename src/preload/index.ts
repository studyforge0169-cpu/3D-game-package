/**
 * Preload bridge: exposes a minimal, typed invoke/on surface via
 * contextBridge. No Node APIs leak into the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(method, ...args);

contextBridge.exposeInMainWorld('hubBridge', {
  invoke: (method: string, ...args: unknown[]) => invoke(method, ...args),
  on: (channel: string, cb: (ev: unknown) => void) => {
    const allowed = ['download-progress', 'download-completed', 'export-conflicts', 'import-file', 'config-changed'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
