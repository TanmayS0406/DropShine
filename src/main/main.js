'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, globalShortcut, ipcMain, dialog, shell, Notification, powerMonitor } = require('electron');

const { JsonStore } = require('./store');
const { createCore } = require('./core');
const { WindowManager } = require('./window');
const { TrayManager } = require('./tray');

// A small window doesn't need the GPU process; skipping it saves memory and idle wake-ups.
app.disableHardwareAcceleration();
app.setAppUserModelId('com.dropshine.app');

const DEFAULTS = {
  apiBase: 'http://127.0.0.1:47800', // the Windows service
  hotkey: 'Control+Alt+D', // Electron accelerator syntax
  idleDestroyMs: 120_000, // free the window's renderer after this long hidden (0 = keep it)
  autostartInitialized: false,
};

let ctx = null; // live objects, exposed for scripts/capture.js

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => ctx?.windows.show());
  app.on('window-all-closed', () => {}); // tray app: keep running with no windows
  app.whenReady().then(start);
}

function loadSettings(store) {
  const saved = store.read({}) || {};
  const settings = { ...DEFAULTS };
  if (typeof saved.apiBase === 'string') {
    try {
      new URL(saved.apiBase);
      settings.apiBase = saved.apiBase;
    } catch {
      /* keep default */
    }
  }
  if (typeof saved.hotkey === 'string' && saved.hotkey.trim()) settings.hotkey = saved.hotkey.trim();
  if (Number.isFinite(saved.idleDestroyMs) && saved.idleDestroyMs >= 0) settings.idleDestroyMs = saved.idleDestroyMs;
  settings.autostartInitialized = saved.autostartInitialized === true;
  return settings;
}

function throttled(fn, ms) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

const hotkeyLabel = (accelerator) => accelerator.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl');

function start() {
  const userData = app.getPath('userData');
  const settingsFile = path.join(userData, 'settings.json');
  const settingsStore = new JsonStore(settingsFile);
  const settings = loadSettings(settingsStore);

  const openLink = (url) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === 'http:' || protocol === 'https:') shell.openExternal(url);
    } catch {
      /* not a URL */
    }
  };

  const core = createCore({
    apiBase: process.env.DROPSHINE_API || settings.apiBase, // env override is for this run only, never saved
    version: app.getVersion(),
    historyFile: path.join(userData, 'history.json'),
    openExternal: openLink,
  });
  const { backend, auth, jobs } = core;

  // ---- start with Windows (installed builds only: in dev it would register electron.exe) ----
  const autostart = {
    supported: app.isPackaged,
    get: () => app.getLoginItemSettings().openAtLogin,
    set: (on) => app.setLoginItemSettings({ openAtLogin: on }),
  };
  // First run of an installed build: turn it on, since the app is meant to live in the background.
  // (Not flagged during dev runs, so the installed build still gets its first-run default.)
  if (autostart.supported && !settings.autostartInitialized) {
    autostart.set(true);
    settings.autostartInitialized = true;
  }

  // Keep the file on disk complete so users can find and edit every option.
  settingsStore.write(settings);
  settingsStore.flush();

  // ---- popup window ----
  let hotkeyOk = false;
  const snapshot = () => ({
    version: app.getVersion(),
    online: backend.online,
    auth: auth.state,
    jobs: jobs.serialize(),
    counts: jobs.counts(),
    hotkey: hotkeyLabel(settings.hotkey),
    hotkeyOk,
  });

  const windows = new WindowManager({
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    indexHtml: path.join(__dirname, '..', 'renderer', 'index.html'),
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    getSnapshot: snapshot,
    idleDestroyMs: settings.idleDestroyMs,
    onVisibilityChange: () => refreshTray(),
  });

  // ---- tray: status + tooltip while the popup is hidden ----
  const tray = new TrayManager({
    hotkeyLabel: hotkeyLabel(settings.hotkey),
    onToggle: () => windows.toggle(),
    onQuit: () => app.quit(),
    onOpenSettings: () => shell.openPath(settingsFile),
    autostart,
  });

  function trayStatus() {
    const c = jobs.counts();
    const head = jobs.headline();
    if (head) {
      const more = c.active > 1 ? ` (+${c.active - 1} more)` : '';
      if (head.stage === 'uploading') {
        return { state: 'busy', tooltip: `Uploading ${head.name} - ${Math.round(head.progress * 100)}%${more}` };
      }
      if (head.stage === 'ai') return { state: 'busy', tooltip: `AI running - ${head.name}${more}` };
      return { state: 'busy', tooltip: `${c.queued} file(s) waiting for sign-in` };
    }
    if (c.unseenError) return { state: 'error', tooltip: `${c.unseenError} file(s) failed - open DropShine for details` };
    if (!backend.online) return { state: 'offline', tooltip: 'DropShine - service offline, retrying' };
    return { state: 'idle', tooltip: `DropShine - ${hotkeyLabel(settings.hotkey)} to open` };
  }

  // Coalesce bursts (e.g. upload progress) so we wake up a few times a second at most.
  const pushState = throttled(() => windows.push(snapshot()), 100);
  const refreshTray = throttled(() => tray.update(trayStatus()), 400);
  const changed = () => {
    pushState();
    refreshTray();
  };
  jobs.on('change', changed);
  auth.on('change', changed);
  backend.on('online', changed);
  backend.on('offline', changed);

  // ---- native toasts for results that finish while the popup is hidden ----
  const toasts = new Set();
  function toast(title, body) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    toasts.add(n); // hold a reference or it can be garbage-collected before the click fires
    n.on('click', () => windows.show());
    n.on('close', () => toasts.delete(n));
    n.show();
  }
  jobs.on('finished', (job) => {
    if (windows.visible) return;
    if (job.stage === 'done') toast(`${job.name} is ready`, job.summary || 'AI finished processing.');
    else toast(`${job.name} failed`, job.error || 'Something went wrong.');
  });

  // ---- global hotkey ----
  try {
    hotkeyOk = globalShortcut.register(settings.hotkey, () => windows.toggle());
  } catch {
    hotkeyOk = false; // invalid accelerator string
  }
  if (!hotkeyOk) {
    toast('DropShine', `${hotkeyLabel(settings.hotkey)} is unavailable (used by another app?). Use the tray icon, or change "hotkey" in settings.`);
  }

  // ---- renderer IPC (only our own window may call these) ----
  const guard = (fn) => (event, ...args) => (windows.owns(event.sender) ? fn(...args) : undefined);

  ipcMain.handle('state:get', guard(() => snapshot()));
  ipcMain.on('ui:ready', guard(() => windows.ready()));
  ipcMain.on('ui:hide', guard(() => windows.hide()));
  ipcMain.on('ui:hidden', guard(() => windows.hidden()));

  ipcMain.on('files:add', guard((paths) => {
    if (!Array.isArray(paths)) return;
    jobs.add(paths.filter((p) => typeof p === 'string' && p).slice(0, 500));
  }));
  ipcMain.on('files:browse', guard(async () => {
    const options = { properties: ['openFile', 'multiSelections'] };
    const parent = windows.browserWindow;
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (!result.canceled) jobs.add(result.filePaths);
  }));

  ipcMain.on('job:retry', guard((id) => jobs.retry(String(id))));
  ipcMain.on('job:cancel', guard((id) => jobs.cancel(String(id))));
  ipcMain.on('history:clear', guard(() => jobs.clear()));
  ipcMain.on('history:seen', guard(() => jobs.markSeen()));

  ipcMain.on('auth:login', guard((provider) => auth.login(String(provider || 'claude'))));
  ipcMain.on('auth:code', guard((code) => auth.submitCode(String(code || ''))));
  ipcMain.on('auth:refresh', guard(() => auth.refresh()));
  ipcMain.on('auth:configure', guard((provider, clientId, clientSecret) => {
    if (provider !== 'google' && provider !== 'microsoft') return;
    const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
    auth.configureDrive(provider, text(clientId), text(clientSecret));
  }));
  ipcMain.on('auth:logout', guard((provider) => auth.logout(String(provider || 'claude'))));
  ipcMain.on('link:open', guard((url) => openLink(String(url))));
  // The page never supplies a path: it names a job, and we reveal the result recorded for it.
  ipcMain.on('result:open', guard((id) => {
    const target = jobs.resultPath(String(id));
    if (!target) return;
    if (fs.existsSync(target)) shell.showItemInFolder(target);
    else toast('DropShine', 'That file is no longer on this PC.');
  }));

  // ---- lifecycle ----
  // Drop the event stream while the machine sleeps; reconnect on wake.
  powerMonitor.on('suspend', () => backend.stopEvents());
  powerMonitor.on('resume', () => backend.connectEvents());

  app.on('before-quit', () => {
    windows.quitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    backend.stopEvents();
    jobs.store.flush();
  });

  backend.connectEvents();
  refreshTray();

  ctx = { core, windows, tray, settings, snapshot };
}

module.exports = {
  get ctx() {
    return ctx;
  },
};
