'use strict';

const { EventEmitter } = require('node:events');
const { friendlyError } = require('./backend');

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PROVIDERS = new Set(['claude', 'google', 'microsoft']);

/**
 * Accounts. The service owns every credential; this app only starts a flow and shows the result.
 *
 *   Claude ("Sign in with AI") gates processing. The service runs `claude auth login` and returns its link; the
 *   browser page then shows a code that the user pastes back here (POST /api/auth/code).
 *   Google Drive / OneDrive are optional: results are copied there when connected. Their OAuth redirect lands on the
 *   service itself, so no code is needed.
 *
 * The top-level state describes Claude; `accounts` lists all of them.
 */
class Auth extends EventEmitter {
  constructor({ backend, openExternal }) {
    super();
    this.backend = backend;
    this.openExternal = openExternal;
    this.state = {
      known: false, signedIn: false, user: null, provider: null,
      pending: false, needsCode: false, error: null,
      accounts: [{ id: 'claude', name: 'Claude', configured: true, signedIn: false, user: null, pending: false, needsCode: false, error: null }],
    };
    this._pendingTimer = null;
  }

  _set(patch) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    const wasSignedIn = this.state.signedIn;
    this.state = next;
    this.emit('change', this.state, wasSignedIn);
  }

  _clearTimer() {
    clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
  }

  _watchPending() {
    this._clearTimer();
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      this._set({ pending: false, needsCode: false });
      this.refresh();
    }, LOGIN_TIMEOUT_MS);
    this._pendingTimer.unref?.();
  }

  async refresh() {
    try {
      const res = await this.backend.request('GET', '/api/auth/status');
      if (res.status === 200 && res.body) this.apply(res.body);
    } catch {
      /* offline: keep whatever we knew */
    }
  }

  /** Apply a status object from GET /api/auth/status or an SSE {type:"auth"} event. */
  apply(s) {
    const signedIn = !!s.signedIn;
    const claudeEntry = {
      id: 'claude', name: 'Claude', configured: true, signedIn, user: signedIn ? s.user ?? null : null,
      pending: !signedIn && !!s.pending, needsCode: !signedIn && !!s.needsCode, error: s.error ?? null,
    };

    // A service that only knows one account (the mock, an older build) sends no list: synthesise Claude's entry.
    const accounts = Array.isArray(s.accounts) && s.accounts.length
      ? s.accounts.map((a) => (a.id === 'claude' ? { ...a, ...claudeEntry, configured: a.configured !== false } : { ...a }))
      : [claudeEntry];
    if (!accounts.some((a) => a.id === 'claude')) accounts.unshift(claudeEntry);

    if (signedIn || !claudeEntry.pending) this._clearTimer();
    this._set({
      known: true, signedIn, user: claudeEntry.user, provider: s.provider ?? this.state.provider,
      pending: claudeEntry.pending, needsCode: claudeEntry.needsCode, error: claudeEntry.error, accounts,
    });
  }

  markSignedOut() {
    this._set({ known: true, signedIn: false, user: null, accounts: this.state.accounts.map((a) => (a.id === 'claude' ? { ...a, signedIn: false, user: null } : a)) });
  }

  _accountError(provider, message) {
    if (provider === 'claude') return this._set({ pending: false, needsCode: false, error: message });
    this._set({ accounts: this.state.accounts.map((a) => (a.id === provider ? { ...a, pending: false, error: message } : a)) });
  }

  /** Start signing in to an account ('claude' by default). The link opens in the user's browser. */
  async login(provider = 'claude') {
    if (!PROVIDERS.has(provider)) return;
    if (provider === 'claude' && this.state.pending && !this.state.needsCode) return;
    try {
      const res = await this.backend.request('POST', '/api/auth/login', { provider });
      if (res.status === 200 && res.body?.signedIn) return this.apply(res.body);
      // A drive can connect on the spot through the OneDrive / Google Drive app already on this PC: no link, no sign-in.
      if (res.status === 200 && res.body?.connected) return await this.refresh();
      if (res.status !== 200 || !res.body?.url) throw new Error(res.body?.error || `Sign-in failed (${res.status})`);

      if (provider === 'claude') {
        this._set({ pending: true, needsCode: !!res.body.needsCode, error: null });
      } else {
        this._set({ accounts: this.state.accounts.map((a) => (a.id === provider ? { ...a, pending: true, error: null } : a)) });
      }
      this.openExternal(res.body.url);
      this._watchPending();
    } catch (err) {
      this._clearTimer();
      this._accountError(provider, friendlyError(err));
    }
  }

  /**
   * One-time setup of direct sign-in for a drive that has no drive app on this PC: the client id (and Google's secret)
   * is saved by the service, then the sign-in page opens in the browser, so one press of "Save and sign in" does both.
   */
  async configureDrive(provider, clientId, clientSecret) {
    if (provider !== 'google' && provider !== 'microsoft') return false;
    try {
      const res = await this.backend.request('PUT', '/api/auth/config', { provider, clientId, clientSecret });
      if (res.status !== 204 && res.status !== 200) {
        this._accountError(provider, res.body?.error || `Could not save the client ID (${res.status})`);
        return false;
      }
    } catch (err) {
      this._accountError(provider, friendlyError(err));
      return false;
    }
    await this.refresh(); // the account is configured now...
    await this.login(provider); // ...so Connect opens the browser
    return true;
  }

  /** The code the browser page showed after Claude's sign-in. */
  async submitCode(code) {
    code = String(code || '').trim();
    if (!code) return;
    try {
      const res = await this.backend.request('POST', '/api/auth/code', { code });
      if (res.status === 204 || res.status === 200) return this._set({ error: null });
      this._set({ error: res.body?.error || `The code was not accepted (${res.status})` }); // stays in "waiting for code"
    } catch (err) {
      this._set({ error: friendlyError(err) });
    }
  }

  async logout(provider = 'claude') {
    if (!PROVIDERS.has(provider)) return;
    try {
      await this.backend.request('POST', '/api/auth/logout', { provider });
    } catch {
      /* the next status refresh will correct us */
    }
    if (provider === 'claude') {
      this._clearTimer();
      this._set({ known: true, signedIn: false, user: null, pending: false, needsCode: false });
    }
    await this.refresh();
  }
}

module.exports = { Auth };
