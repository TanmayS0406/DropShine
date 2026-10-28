'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const images = new Map();

function trayImage(state) {
  if (!images.has(state)) {
    // Electron picks tray-<state>@1.5x.png / @2x.png automatically for high-DPI displays.
    images.set(state, nativeImage.createFromPath(path.join(ASSETS, `tray-${state}.png`)));
  }
  return images.get(state);
}

/**
 * Tray icon: the always-present handle for the app. Its colour dot shows
 * busy / error / offline while the popup is hidden, and the tooltip says what is happening.
 */
class TrayManager {
  constructor({ hotkeyLabel, onToggle, onQuit, onOpenSettings, autostart }) {
    this.state = 'idle';
    this.tooltip = '';
    this.hotkeyLabel = hotkeyLabel;
    this.handlers = { onToggle, onQuit, onOpenSettings };
    this.autostart = autostart; // { supported, get(), set(bool) }

    this.tray = new Tray(trayImage('idle'));
    this.tray.setToolTip('DropShine');
    this.tray.on('click', onToggle);
    this._buildMenu();
  }

  _buildMenu() {
    const { onToggle, onQuit, onOpenSettings } = this.handlers;
    const items = [
      { label: `Show / Hide\t${this.hotkeyLabel}`, click: onToggle },
      { type: 'separator' },
    ];
    if (this.autostart.supported) {
      items.push({
        label: 'Start with Windows',
        type: 'checkbox',
        checked: this.autostart.get(),
        click: (item) => {
          this.autostart.set(item.checked);
          this._buildMenu();
        },
      });
    }
    items.push(
      { label: 'Open settings file', click: onOpenSettings },
      { type: 'separator' },
      { label: 'Quit DropShine', click: onQuit },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  update({ state, tooltip }) {
    if (state !== this.state) {
      this.state = state;
      this.tray.setImage(trayImage(state));
    }
    const text = tooltip.length > 120 ? `${tooltip.slice(0, 117)}...` : tooltip; // Windows caps tooltips at 127 chars
    if (text !== this.tooltip) {
      this.tooltip = text;
      this.tray.setToolTip(text);
    }
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { TrayManager };
