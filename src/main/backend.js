'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { pipeline } = require('node:stream');

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED',
]);

function friendlyError(err) {
  const code = err && err.code;
  if (NETWORK_CODES.has(code) || err?.message === 'stalled') return "Can't reach the DropShine service";
  if (code === 'ENOENT') return 'File no longer exists';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'File is locked or not readable';
  return err?.message || 'Unknown error';
}

function isNetworkError(err) {
  return NETWORK_CODES.has(err?.code) || err?.message === 'stalled';
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/**
 * Client for the DropShine Windows service.
 *
 *  - request()        small JSON calls
 *  - upload()         streams a file as the raw request body, reporting progress
 *  - connectEvents()  one long-lived Server-Sent-Events connection (job + auth updates),
 *                     reconnecting with exponential back-off. It is the only thing that
 *                     runs while the app is idle, and the server's keep-alive comment is
 *                     the only traffic on it.
 *
 * Emits: 'online', 'offline', 'event' (parsed JSON object).
 */
class Backend extends EventEmitter {
  constructor({ base, version = '0.0.0' }) {
    super();
    this.base = new URL(base);
    this.lib = this.base.protocol === 'https:' ? https : http;
    this.version = version;
    this.online = false;

    this._sse = null;
    this._retryTimer = null;
    this._attempt = 0;
    this._stopped = true;
    this._lastOpen = 0;
  }

  get _headers() {
    // A custom header forces browsers to send a CORS preflight, so a random web page
    // can't drive the local service with a "simple" cross-site request.
    return { 'User-Agent': `DropShine/${this.version}`, 'X-DropShine-Client': this.version };
  }

  request(method, pathname, json) {
    return new Promise((resolve, reject) => {
      const data = json === undefined ? null : Buffer.from(JSON.stringify(json));
      const headers = { ...this._headers, Accept: 'application/json' };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = data.length;
      }
      const req = this.lib.request(new URL(pathname, this.base), { method, headers, timeout: 8000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: parseBody(Buffer.concat(chunks).toString('utf8')) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end(data);
    });
  }

  /**
   * POST /api/files - the file is the raw body (no multipart overhead, constant memory).
   * Metadata travels in headers: X-File-Name (URL-encoded), X-Job-Id.
   */
  upload(job, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const headers = {
        ...this._headers,
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': job.size,
        'X-File-Name': encodeURIComponent(job.name),
        'X-Job-Id': job.id,
      };
      const req = this.lib.request(new URL('/api/files', this.base), { method: 'POST', headers, signal }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: parseBody(Buffer.concat(chunks).toString('utf8')) }));
        res.on('error', reject);
      });
      req.setTimeout(120_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);

      const file = fs.createReadStream(job.path, { highWaterMark: 256 * 1024 });
      let sent = 0;
      file.on('data', (chunk) => {
        sent += chunk.length;
        onProgress(job.size ? Math.min(1, sent / job.size) : 1);
      });
      pipeline(file, req, (err) => {
        if (err) reject(err);
      });
    });
  }

  // ---- Server-Sent Events ------------------------------------------------

  connectEvents() {
    if (!this._stopped) return;
    this._stopped = false;
    this._attempt = 0;
    this._open();
  }

  /** Stop and tear down (used on system suspend and quit). */
  stopEvents() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._sse?.destroy();
    this._sse = null;
    this._setOnline(false);
  }

  /** Called after a network failure: retry the event stream now instead of waiting out the back-off. */
  nudge() {
    if (this._stopped || this.online || !this._retryTimer) return;
    if (Date.now() - this._lastOpen < 3000) return;
    this._open();
  }

  _setOnline(value) {
    if (this.online === value) return;
    this.online = value;
    this.emit(value ? 'online' : 'offline');
  }

  _open() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._lastOpen = Date.now();

    let dead = false;
    const lost = () => {
      if (dead) return;
      dead = true;
      req.destroy();
      if (this._sse === req) this._sse = null;
      this._setOnline(false);
      if (this._stopped) return;
      const delay = Math.min(60_000, 2000 * 2 ** this._attempt++) * (0.75 + Math.random() * 0.5);
      this._retryTimer = setTimeout(() => this._open(), delay);
    };

    const req = this.lib.get(
      new URL('/api/events', this.base),
      { headers: { ...this._headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return lost();
        }
        this._attempt = 0;
        this._setOnline(true);
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            this._handleBlock(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        });
        res.on('end', lost);
        res.on('error', lost);
      },
    );
    // The server sends a keep-alive comment every ~25s; silence for 75s means a dead socket.
    req.setTimeout(75_000, () => req.destroy(new Error('stalled')));
    req.on('error', lost);
    this._sse = req;
  }

  _handleBlock(block) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) return; // comment / keep-alive
    try {
      const evt = JSON.parse(data);
      if (evt && typeof evt === 'object') this.emit('event', evt);
    } catch {
      /* ignore malformed event */
    }
  }
}

module.exports = { Backend, friendlyError, isNetworkError };
