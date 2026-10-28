'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Tiny JSON file store. Writes are debounced and atomic (tmp file + rename) so a
 * crash or power cut can't leave a half-written file, and nothing touches the disk
 * unless data actually changed.
 */
class JsonStore {
  constructor(file, { delay = 800 } = {}) {
    this.file = file;
    this.delay = delay;
    this._timer = null;
    this._pending = undefined;
  }

  read(fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  write(data) {
    this._pending = data;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.delay);
    this._timer.unref?.();
  }

  /** Write immediately (also used on quit). */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._pending === undefined) return;
    const data = this._pending;
    this._pending = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] write failed:', err.message);
    }
  }
}

module.exports = { JsonStore };
