'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// File drops are handled here, not in the page: this is the only place that can turn a
// dropped File into a real path (webUtils.getPathForFile), and it means a broken page
// can never navigate to a dropped file.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean);
  if (paths.length) ipcRenderer.send('files:add', paths);
});

const subscribe = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('dropshine', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => subscribe('state', cb),
  onVisibility: (cb) => subscribe('ui:visibility', cb),

  ready: () => ipcRenderer.send('ui:ready'),
  hide: () => ipcRenderer.send('ui:hide'),
  hidden: () => ipcRenderer.send('ui:hidden'),

  browse: () => ipcRenderer.send('files:browse'),
  retry: (id) => ipcRenderer.send('job:retry', id),
  cancel: (id) => ipcRenderer.send('job:cancel', id),
  clearHistory: () => ipcRenderer.send('history:clear'),
  markSeen: () => ipcRenderer.send('history:seen'),

  login: (provider = 'claude') => ipcRenderer.send('auth:login', provider),
  submitCode: (code) => ipcRenderer.send('auth:code', code),
  refreshAccounts: () => ipcRenderer.send('auth:refresh'),
  configureDrive: (provider, clientId, clientSecret) => ipcRenderer.send('auth:configure', provider, clientId, clientSecret),
  logout: (provider = 'claude') => ipcRenderer.send('auth:logout', provider),
  openLink: (url) => ipcRenderer.send('link:open', url),
  openResult: (id) => ipcRenderer.send('result:open', id),
});
