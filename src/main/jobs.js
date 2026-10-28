'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { friendlyError, isNetworkError } = require('./backend');

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/**
 * Every dropped file is a job that moves through:
 *
 *   queued -> uploading -> ai -> done | error        (or cancelled)
 *
 * "uploading" is driven by us (bytes sent to the service); "ai" and the final state
 * are pushed by the service over the event stream. The list doubles as the history.
 *
 * Emits: 'change' (any mutation), 'finished' (job reached done/error).
 */
class JobManager extends EventEmitter {
  constructor({ backend, auth, store, maxHistory = 30, concurrency = 2 }) {
    super();
    this.backend = backend;
    this.auth = auth;
    this.store = store;
    this.maxHistory = maxHistory;
    this.concurrency = concurrency;
    this.running = new Map(); // id -> AbortController (uploads in flight)

    this.jobs = (store.read([]) || []).map((j) => this._restore(j)); // newest first
  }

  _restore(j) {
    const job = { ...j, seen: true };
    // The app was closed mid-upload: the bytes never finished arriving.
    if (job.stage === 'queued' || job.stage === 'uploading') {
      job.stage = 'error';
      job.error = 'Interrupted - the app was closed during upload';
      job.progress = 0;
    }
    return job;
  }

  // ---- queries -----------------------------------------------------------

  get(id) {
    return this.jobs.find((j) => j.id === id);
  }

  counts() {
    const c = { uploading: 0, ai: 0, queued: 0, unseenDone: 0, unseenError: 0 };
    for (const j of this.jobs) {
      if (j.stage === 'uploading') c.uploading++;
      else if (j.stage === 'ai') c.ai++;
      else if (j.stage === 'queued') c.queued++;
      else if (!j.seen && j.stage === 'done') c.unseenDone++;
      else if (!j.seen && j.stage === 'error') c.unseenError++;
    }
    c.active = c.uploading + c.ai + c.queued;
    return c;
  }

  /** The job the UI/tray should headline: uploads first, then AI work, then waiting files. */
  headline() {
    const pick = (stage) => [...this.jobs].reverse().find((j) => j.stage === stage); // oldest first
    return pick('uploading') || pick('ai') || pick('queued') || null;
  }

  /** What the page gets: no local paths (the page can only ask us to reveal a job's result by id). */
  serialize() {
    return this.jobs.map(({ path: _path, files, folder, ...pub }) => ({
      ...pub,
      files: (files || []).map(({ name, kind, size }) => ({ name, kind, size })),
      hasFolder: !!(folder || files?.length),
      retryable: (pub.stage === 'error' || pub.stage === 'cancelled') && !pub.notAFile,
    }));
  }

  /** Local file to reveal in Explorer for a finished job: the documentation if there is one, else any result, else its folder. */
  resultPath(id) {
    const job = this.get(id);
    if (!job || job.stage !== 'done') return null;
    const file = job.files?.find((f) => f.kind === 'documentation') || job.files?.[0];
    return file?.path || job.folder || null;
  }

  // ---- mutations ---------------------------------------------------------

  async add(paths) {
    for (const p of paths) {
      let st = null;
      try {
        st = await fs.promises.stat(p);
      } catch {
        /* reported below */
      }
      const job = {
        id: crypto.randomUUID(),
        path: p,
        name: path.basename(p) || p,
        size: st?.isFile() ? st.size : 0,
        addedAt: Date.now(),
        stage: 'queued',
        progress: 0,
        aiProgress: null,
        message: '',
        summary: null,
        url: null,
        error: null,
        seen: true,
      };
      if (!st) this._fail(job, 'File not found');
      else if (!st.isFile()) {
        job.notAFile = true;
        this._fail(job, "Folders aren't supported yet");
      }
      this.jobs.unshift(job);
    }
    this._trim();
    this._persist();
    this.emit('change');
    this.pump();
  }

  retry(id) {
    const job = this.get(id);
    if (!job || !TERMINAL.has(job.stage) || job.stage === 'done' || job.notAFile) return;
    Object.assign(job, {
      stage: 'queued', progress: 0, aiProgress: null, message: '', error: null, summary: null, url: null,
      files: [], folder: null, cloud: [], addedAt: Date.now(), seen: true,
    });
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.jobs.unshift(job);
    this._persist();
    this.emit('change');
    this.pump();
  }

  cancel(id) {
    const job = this.get(id);
    if (!job || (job.stage !== 'queued' && job.stage !== 'uploading')) return;
    this.running.get(id)?.abort();
    this._patch(job, { stage: 'cancelled', message: '', error: null });
    this.pump();
  }

  clear() {
    // Keep anything still in flight; drop the rest.
    this.jobs = this.jobs.filter((j) => !TERMINAL.has(j.stage));
    this._persist();
    this.emit('change');
  }

  markSeen() {
    let changed = false;
    for (const j of this.jobs) {
      if (!j.seen && TERMINAL.has(j.stage)) {
        j.seen = true;
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  // ---- upload queue ------------------------------------------------------

  pump() {
    const signedOut = this.auth.state.known && !this.auth.state.signedIn;
    for (const job of [...this.jobs].reverse()) {
      // oldest first
      if (job.stage !== 'queued') continue;
      if (signedOut) {
        // Hold files until the user signs in; they start automatically afterwards.
        if (job.message !== 'Waiting for sign-in') this._patch(job, { message: 'Waiting for sign-in' }, false);
        continue;
      }
      if (this.running.size >= this.concurrency) break;
      this._upload(job);
    }
  }

  async _upload(job) {
    const ac = new AbortController();
    this.running.set(job.id, ac);
    this._patch(job, { stage: 'uploading', progress: 0, message: '' });
    try {
      const res = await this.backend.upload(job, (p) => this._progress(job, p), ac.signal);
      if (res.status === 401 || res.status === 403) {
        this.auth.markSignedOut();
        this._fail(job, 'Sign in with AI to continue');
      } else if (res.status >= 200 && res.status < 300) {
        // The event stream may already have advanced the job (the AI can start before our
        // response arrives); only move forward from "uploading".
        if (job.stage === 'uploading') {
          this._patch(job, { stage: 'ai', progress: 1, message: res.body?.message || 'Queued for AI' });
        }
        if (res.body?.stage) this.applyEvent({ ...res.body, type: 'job', id: job.id });
      } else {
        this._fail(job, res.body?.error || `Service returned ${res.status}`);
      }
    } catch (err) {
      if (ac.signal.aborted) {
        if (job.stage === 'uploading') this._patch(job, { stage: 'cancelled' });
      } else {
        if (isNetworkError(err)) this.backend.nudge();
        this._fail(job, friendlyError(err));
      }
    } finally {
      this.running.delete(job.id);
      this.pump();
    }
  }

  _progress(job, p) {
    if (job.stage !== 'uploading') return;
    job.progress = p;
    this.emit('change');
  }

  // ---- events from the service -------------------------------------------

  /** {type:"job", id, stage:"ai"|"done"|"error", message?, progress?, summary?, url?, error?} */
  applyEvent(evt) {
    if (evt?.type !== 'job') return;
    const job = this.get(evt.id);
    if (!job || TERMINAL.has(job.stage)) return;

    if (evt.stage === 'ai') {
      this._patch(job, {
        stage: 'ai',
        message: evt.message ?? job.message,
        aiProgress: typeof evt.progress === 'number' ? evt.progress : null,
      });
    } else if (evt.stage === 'done') {
      this._patch(job, {
        stage: 'done', progress: 1, aiProgress: null, seen: false,
        message: evt.message ?? '', summary: evt.summary ?? null, url: evt.url ?? null, error: null,
        files: Array.isArray(evt.files) ? evt.files : [], folder: evt.folder ?? null, cloud: Array.isArray(evt.cloud) ? evt.cloud : [],
      });
      this.emit('finished', job);
    } else if (evt.stage === 'error') {
      this._fail(job, evt.error || evt.message || 'AI processing failed');
    }
  }

  /** After (re)connecting, ask the service where jobs we thought were running actually are. */
  async reconcile() {
    for (const job of this.jobs.filter((j) => j.stage === 'ai')) {
      try {
        const res = await this.backend.request('GET', `/api/jobs/${encodeURIComponent(job.id)}`);
        if (res.status === 200 && res.body) this.applyEvent({ ...res.body, type: 'job', id: job.id });
        else if (res.status === 404) this._fail(job, 'The service no longer knows this job');
      } catch {
        return; // went offline again; the next reconnect retries
      }
    }
  }

  // ---- internals ---------------------------------------------------------

  _fail(job, error) {
    Object.assign(job, { stage: 'error', error, message: '', aiProgress: null, seen: false });
    if (this.jobs.includes(job)) {
      this._persist();
      this.emit('change');
      this.emit('finished', job);
    }
  }

  _patch(job, patch, persist = true) {
    const stageChanged = patch.stage && patch.stage !== job.stage;
    Object.assign(job, patch);
    if (persist && stageChanged) this._persist();
    this.emit('change');
  }

  _trim() {
    if (this.jobs.length <= this.maxHistory) return;
    for (let i = this.jobs.length - 1; i >= 0 && this.jobs.length > this.maxHistory; i--) {
      if (TERMINAL.has(this.jobs[i].stage)) this.jobs.splice(i, 1);
    }
  }

  _persist() {
    this.store.write(this.jobs.map(({ seen: _seen, ...j }) => j));
  }
}

module.exports = { JobManager };
