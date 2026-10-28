'use strict';

const { BrowserWindow, screen, app } = require('electron');

// Includes a 10px transparent gutter around the card for its drop shadow.
const SIZE = { width: 360, height: 250 };
const MARGIN = 6; // gap between the gutter and the edge of the work area
const HIDE_ANIMATION_MS = 250; // fallback if the renderer never reports "hidden"

/**
 * Owns the single popup window.
 *
 * Low-power design: the window is created lazily on first show and destroyed again
 * after `idleDestroyMs` hidden, which frees the whole renderer process. Nothing is
 * pushed to it while hidden; it fetches a fresh snapshot when it next opens.
 *
 *   _want     the user asked for it to be visible
 *   _visible  the OS window is shown
 *   _hiding   the exit animation is running
 */
class WindowManager {
  constructor({ preload, indexHtml, icon, getSnapshot, idleDestroyMs, onVisibilityChange }) {
    this.opts = { preload, indexHtml, icon, getSnapshot, idleDestroyMs, onVisibilityChange };
    this.win = null;
    this.quitting = false;
    this._ready = false;
    this._want = false;
    this._visible = false;
    this._hiding = false;
    this._hideTimer = null;
    this._idleTimer = null;
  }

  /** True while the popup is on screen and receiving state. */
  get visible() {
    return this._visible && !this._hiding;
  }

  toggle() {
    if (this._want) this.hide();
    else this.show();
  }

  show() {
    clearTimeout(this._hideTimer);
    clearTimeout(this._idleTimer);
    this._hiding = false;
    this._want = true;
    if (!this.win) this._create();
    else if (this._ready) this._reveal();
  }

  hide() {
    this._want = false;
    if (!this._visible || this._hiding) return;
    this._hiding = true;
    this._send('ui:visibility', 'hide');
    this._hideTimer = setTimeout(() => this.hidden(), HIDE_ANIMATION_MS);
  }

  /** Renderer finished its exit animation (or the fallback timer fired). */
  hidden() {
    if (!this._hiding) return;
    clearTimeout(this._hideTimer);
    this._hiding = false;
    this._visible = false;
    this.win?.hide();
    this.opts.onVisibilityChange?.(false);
    if (this.opts.idleDestroyMs > 0) {
      this._idleTimer = setTimeout(() => this.destroy(), this.opts.idleDestroyMs);
    }
  }

  /** Renderer has loaded and rendered its first state. */
  ready() {
    this._ready = true;
    if (this._want) this._reveal();
  }

  /** Push a state snapshot, only if someone is looking. */
  push(snapshot) {
    if (this.visible) this._send('state', snapshot);
  }

  destroy() {
    clearTimeout(this._hideTimer);
    clearTimeout(this._idleTimer);
    const w = this.win;
    this.win = null;
    this._ready = this._visible = this._hiding = false;
    if (w && !w.isDestroyed()) w.destroy();
  }

  owns(webContents) {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === webContents;
  }

  get browserWindow() {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  // ---- internals ---------------------------------------------------------

  _create() {
    const { preload, indexHtml, icon } = this.opts;
    const win = new BrowserWindow({
      ...SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      icon,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
        backgroundThrottling: true,
      },
    });
    this.win = win;
    win.setAlwaysOnTop(true, 'screen-saver'); // stay above full-screen apps too
    win.removeMenu();

    // Lock the page down: it only ever shows our own local UI.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // Alt+F4 hides instead of destroying the window.
    win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.hide();
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this._ready = this._visible = this._hiding = false;
    });
    win.webContents.on('render-process-gone', () => this.destroy());

    win.loadFile(this.opts.indexHtml);
  }

  _reveal() {
    const win = this.browserWindow;
    if (!win) return;
    if (!this._visible) {
      this._place(win);
      win.show();
    }
    this._visible = true;
    win.focus();
    this._send('state', this.opts.getSnapshot());
    this._send('ui:visibility', 'show');
    this.opts.onVisibilityChange?.(true);
  }

  /** Bottom-right corner of the work area of whichever display the cursor is on. */
  _place(win) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    win.setBounds({
      x: wa.x + wa.width - SIZE.width - MARGIN,
      y: wa.y + wa.height - SIZE.height - MARGIN,
      ...SIZE,
    });
  }

  _send(channel, payload) {
    const win = this.browserWindow;
    if (win) win.webContents.send(channel, payload);
  }
}

module.exports = { WindowManager };
