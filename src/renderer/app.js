(() => {
  'use strict';

  const api = window.dropshine;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const el = {
    card: $('card'), conn: $('conn'),
    btnHistory: $('btn-history'), badge: $('badge'), btnAuth: $('btn-auth'), authDot: $('auth-dot'), btnHide: $('btn-hide'),
    home: $('home'), drop: $('drop'), dropTitle: $('drop-title'),
    status: $('status'), statusIcon: $('status-icon'), statusTitle: $('status-title'), statusSub: $('status-sub'),
    statusAction: $('status-action'), bar: $('bar'), barFill: $('bar-fill'),
    history: $('history'), list: $('list'), empty: $('empty'), btnClear: $('btn-clear'),
    pop: $('auth-pop'), accountsView: $('accounts-view'), accounts: $('accounts'),
    codeForm: $('code-form'), codeInput: $('code-input'), codeError: $('code-error'),
    setup: $('setup'), setupBack: $('setup-back'), setupTitle: $('setup-title'), setupSteps: $('setup-steps'), setupConsole: $('setup-console'),
    setupForm: $('setup-form'), setupId: $('setup-id'), setupSecret: $('setup-secret'), setupError: $('setup-error'), setupApp: $('setup-app'),
  };

  let state = null;
  let view = 'home'; // 'home' | 'history'
  let popOpen = false;
  let setupFor = null; // provider id whose one-time setup form is showing instead of the account list
  let statusAction = null;
  const expanded = new Set(); // history rows the user opened to read the full note

  // ---- helpers -------------------------------------------------------------

  function fmtSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
    return `${n >= 10 || u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
  }

  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  const pct = (p) => `${Math.round((p || 0) * 100)}%`;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // never innerHTML: file names and AI output are untrusted
    return node;
  }

  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'i');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function iconButton(name, title, action) {
    const b = make('button', 'icon-btn sm');
    b.title = title;
    b.dataset.act = action;
    b.append(svgIcon(name));
    return b;
  }

  // ---- header ----------------------------------------------------------------

  function renderHeader(s) {
    el.conn.className = `dot ${s.online ? 'on' : 'off'}`;
    el.conn.title = s.online ? 'Connected to the DropShine service' : 'DropShine service is offline';

    const c = s.counts;
    if (c.active) {
      el.badge.className = 'badge';
      el.badge.textContent = String(c.active);
    } else if (c.unseenError) {
      el.badge.className = 'badge err';
      el.badge.textContent = '';
    } else if (c.unseenDone) {
      el.badge.className = 'badge ok';
      el.badge.textContent = '';
    }
    el.badge.hidden = !(c.active || c.unseenError || c.unseenDone);

    const a = s.auth;
    el.authDot.className = `auth-dot ${a.signedIn ? 'ok' : a.pending ? 'pending' : a.known ? 'warn' : ''}`;
    el.btnAuth.title = a.signedIn
      ? `Signed in${a.user ? ` as ${a.user}` : ''} - accounts`
      : a.needsCode ? 'Paste your sign-in code' : a.pending ? 'Waiting for sign-in in your browser...' : 'Accounts - sign in with AI';
  }

  // ---- accounts popover --------------------------------------------------------

  const ACCOUNT_COLORS = { claude: '#d97757', google: '#4285f4', microsoft: '#0078d4' };

  // The apps DropShine saves through (no sign-in or client id of its own is needed).
  const DRIVE_APP = {
    google: { name: 'Google Drive for desktop', url: 'https://www.google.com/drive/download/' },
    microsoft: { name: 'the OneDrive app', url: 'https://www.microsoft.com/microsoft-365/onedrive/download' },
  };

  function accountSub(a) {
    if (a.error) return a.error;
    if (a.id === 'claude' && a.needsCode) return 'Paste the code from the browser below';
    if (a.pending) return 'Finish signing in in your browser...';
    if (a.signedIn) {
      const who = a.user || 'Connected';
      return a.mode === 'sync' ? `${who} - saved through the app on this PC` : who;
    }
    if (a.id !== 'claude' && a.configured === false) return `Sign in with ${a.id === 'google' ? 'Google' : 'Microsoft'} in your browser (asks for a one-time client ID first)`;
    return a.id === 'claude' ? 'Needed to process files' : 'Optional: saves results to this drive';
  }

  const SETUP_STEPS = {
    google: [
      'In Google Cloud Console create an OAuth client ID of type "Desktop app" and turn on the Drive API.',
      'Set the app to "In production", or sign-in expires after 7 days.',
      'Paste the client ID and secret here; they are kept encrypted on this PC.',
      'Save and sign in: Google opens in your browser.',
    ],
    microsoft: [
      'In Microsoft Entra register an app (any directory + personal accounts).',
      'Add the "Mobile and desktop" platform with redirect http://localhost.',
      'Paste the Application (client) ID here.',
      'Save and sign in: Microsoft opens in your browser.',
    ],
  };

  /** The one-time client-ID form. Shown instead of the account list while `setupFor` is set. */
  function renderSetup(account) {
    el.accountsView.hidden = !!account;
    el.setup.hidden = !account;
    if (!account) return;

    el.setupTitle.textContent = `Connect ${account.name}`;
    el.setupSecret.hidden = !account.setup.needsSecret;
    el.setupId.placeholder = account.id === 'google' ? 'Client ID (ends with .apps.googleusercontent.com)' : 'Application (client) ID';

    el.setupConsole.dataset.url = account.setup.consoleUrl;
    el.setupConsole.textContent = account.id === 'google' ? 'Open Google Cloud Console' : 'Open Microsoft Entra';
    el.setupSteps.replaceChildren(...SETUP_STEPS[account.id].map((text) => make('li', null, text)));

    el.setupError.hidden = !account.error;
    el.setupError.textContent = account.error || '';
  }

  function renderPop(s) {
    el.pop.hidden = !popOpen;
    el.btnAuth.classList.toggle('active', popOpen);
    if (!popOpen) { setupFor = null; return; }

    // Setup view: only while that account still needs it (once the ID is saved the account becomes connectable).
    const target = setupFor ? s.auth.accounts.find((a) => a.id === setupFor) : null;
    if (setupFor && !target?.setup) { setupFor = null; el.setupId.value = ''; el.setupSecret.value = ''; }
    renderSetup(setupFor ? target : null);
    if (setupFor) return;

    const rows = s.auth.accounts.map((a) => {
      const unavailable = !a.signedIn && !a.pending && a.configured === false && a.id !== 'claude';
      const row = make('li', `account${a.error ? ' has-error' : ''}${unavailable ? ' unavailable' : ''}`);
      const badge = make('div', 'account-badge', a.name.charAt(0));
      badge.style.background = ACCOUNT_COLORS[a.id] || '#7c6cff';
      const text = make('div', 'account-text');
      text.append(make('div', 'account-name', a.name), make('div', 'account-sub', accountSub(a)));

      const action = make('button', 'mini-btn');
      action.dataset.provider = a.id;
      if (a.signedIn) { action.textContent = 'Disconnect'; action.dataset.act = 'logout'; }
      else if (a.pending) { action.textContent = 'Waiting...'; action.disabled = true; }
      else if (a.setup && a.id !== 'claude') { action.textContent = 'Connect'; action.dataset.act = 'setup'; } // nothing on this PC yet: one-time setup, then the browser
      else { action.textContent = a.id === 'claude' ? 'Sign in' : 'Connect'; action.dataset.act = 'login'; }

      row.append(badge, text, action);
      return row;
    });
    el.accounts.replaceChildren(...rows);

    const claude = s.auth.accounts.find((a) => a.id === 'claude');
    const needsCode = !!(claude && claude.needsCode && !claude.signedIn);
    const wasHidden = el.codeForm.hidden;
    el.codeForm.hidden = !needsCode;
    el.codeError.hidden = !(needsCode && claude.error);
    el.codeError.textContent = needsCode && claude.error ? claude.error : '';
    if (needsCode && wasHidden) el.codeInput.focus();
  }

  // ---- status strip ----------------------------------------------------------

  const oldest = (jobs, stage) => [...jobs].reverse().find((j) => j.stage === stage); // jobs are newest-first

  function computeStatus(s) {
    const active = s.jobs.filter((j) => j.stage === 'uploading' || j.stage === 'ai' || j.stage === 'queued');
    const more = active.length > 1 ? ` · +${active.length - 1} more` : '';
    const uploading = oldest(active, 'uploading');
    const running = oldest(active, 'ai');
    const waiting = active.filter((j) => j.stage === 'queued');
    const signedOut = s.auth.known && !s.auth.signedIn;

    if (uploading) {
      const size = uploading.size ? ` of ${fmtSize(uploading.size)}` : '';
      return {
        kind: 'upload', icon: 'upload', title: `Uploading ${uploading.name}`,
        sub: `${pct(uploading.progress)}${size}${more}`, progress: uploading.progress,
        action: { label: 'Cancel', run: () => api.cancel(uploading.id) },
      };
    }
    if (running) {
      return {
        kind: 'ai', icon: 'sparkles', title: 'AI running',
        sub: `${running.name}${running.message ? ` · ${running.message}` : ''}${more}`,
        progress: running.aiProgress, // null -> indeterminate
      };
    }
    if (s.auth.needsCode) {
      return {
        kind: 'wait', icon: 'sparkles', title: 'Enter your sign-in code', sub: 'Paste the code the browser page showed',
        action: { label: 'Enter code', run: () => openAccounts() },
      };
    }
    if (s.auth.pending) {
      return { kind: 'wait', icon: 'sparkles', title: 'Waiting for sign-in', sub: 'Finish signing in in your browser' };
    }
    if (signedOut && waiting.length) {
      return {
        kind: 'warn', icon: 'alert', title: 'Sign in to continue',
        sub: `${waiting.length} file${waiting.length > 1 ? 's' : ''} waiting`,
        action: { label: 'Sign in', run: () => api.login('claude') },
      };
    }
    if (s.auth.error && !s.auth.signedIn) {
      return { kind: 'error', icon: 'alert', title: 'Sign-in failed', sub: s.auth.error, action: { label: 'Retry', run: () => api.login('claude') } };
    }
    if (!s.online) {
      return { kind: 'offline', icon: 'alert', title: 'Service offline', sub: 'Retrying in the background' };
    }
    if (signedOut) {
      return {
        kind: 'warn', icon: 'sparkles', title: 'Sign in with AI', sub: 'Needed before files can be processed',
        action: { label: 'Sign in', run: () => api.login('claude') },
      };
    }
    return { kind: 'ready', icon: 'check', title: 'Ready', sub: `${s.hotkey} to hide` };
  }

  function renderStatus(s) {
    const st = computeStatus(s);
    el.status.dataset.kind = st.kind;
    el.statusIcon.firstElementChild.setAttribute('href', `#i-${st.icon}`);
    el.statusTitle.textContent = st.title;
    el.statusSub.textContent = st.sub;

    statusAction = st.action ? st.action.run : null;
    el.statusAction.hidden = !st.action;
    if (st.action) el.statusAction.textContent = st.action.label;

    const showBar = st.kind === 'upload' || st.kind === 'ai';
    el.bar.hidden = !showBar;
    const determinate = typeof st.progress === 'number';
    el.bar.classList.toggle('indeterminate', showBar && !determinate);
    el.barFill.style.width = showBar && determinate ? pct(st.progress) : '';
  }

  // ---- history ---------------------------------------------------------------

  const STAGE_ICON = { queued: 'file', uploading: 'upload', ai: 'sparkles', done: 'check', error: 'alert', cancelled: 'x' };

  function chipText(job) {
    switch (job.stage) {
      case 'queued': return job.message === 'Waiting for sign-in' ? 'Waiting' : 'Queued';
      case 'uploading': return pct(job.progress);
      case 'ai': return 'AI running';
      case 'done': return 'Done';
      case 'error': return 'Failed';
      default: return 'Cancelled';
    }
  }

  function noteText(job) {
    if (job.stage === 'done') return job.summary || job.message;
    if (job.stage === 'error') return job.error;
    if (job.stage === 'ai' || job.stage === 'queued') return job.message;
    return '';
  }

  function renderHistory(s) {
    el.empty.hidden = s.jobs.length > 0;
    el.btnClear.hidden = !s.jobs.some((j) => j.stage === 'done' || j.stage === 'error' || j.stage === 'cancelled');

    const rows = s.jobs.map((job) => {
      const row = make('li', `item${expanded.has(job.id) ? ' expanded' : ''}`);
      row.dataset.id = job.id;
      row.dataset.stage = job.stage;

      const ico = make('div', 'item-ico');
      ico.append(svgIcon(STAGE_ICON[job.stage] || 'file'));

      const main = make('div', 'item-main');
      main.append(make('div', 'item-name', job.name));
      main.append(make('div', 'item-meta', [fmtSize(job.size), ago(job.addedAt)].filter(Boolean).join(' · ')));
      const note = noteText(job);
      if (note) main.append(make('div', 'item-note', note));
      if (job.stage === 'done' && job.files?.length) {
        main.append(make('div', 'item-files', job.files.filter((f) => f.kind !== 'diagram-svg').map((f) => f.name).join('  ·  ')));
      }

      const side = make('div', 'item-side');
      side.append(make('span', 'chip', chipText(job)));
      if (job.retryable) side.append(iconButton('retry', 'Try again', 'retry'));
      if (job.stage === 'done' && job.hasFolder) side.append(iconButton('folder', 'Show the documents on this PC', 'folder'));
      if (job.stage === 'done' && job.url) side.append(iconButton('external', 'Open the cloud copy', 'open'));
      if (job.stage === 'queued' || job.stage === 'uploading') side.append(iconButton('x', 'Cancel', 'cancel'));

      row.append(ico, main, side);
      return row;
    });
    el.list.replaceChildren(...rows);
  }

  // ---- render orchestration ----------------------------------------------------

  function render() {
    if (!state) return;
    renderHeader(state);
    renderStatus(state);
    renderPop(state);

    el.home.hidden = view !== 'home';
    el.history.hidden = view !== 'history';
    el.btnHistory.classList.toggle('active', view === 'history');

    if (view === 'history') {
      renderHistory(state);
      // Looking at the list counts as having seen the results (clears the badge / tray dot).
      if (state.counts.unseenDone || state.counts.unseenError) api.markSeen();
    }
  }

  function resetLayers() {
    view = 'home';
    popOpen = false;
    expanded.clear();
    setDragging(false);
    render();
  }

  // ---- drag feedback (the actual drop is handled in the preload) --------------------

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

  function setDragging(on) {
    if (!on) dragDepth = 0;
    el.card.classList.toggle('dragging', on);
    el.dropTitle.textContent = on ? 'Release to upload' : 'Drop files here';
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    setDragging(true);
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) setDragging(false);
  });
  document.addEventListener('drop', () => setDragging(false));
  document.addEventListener('dragend', () => setDragging(false));

  // ---- interaction -------------------------------------------------------------

  el.drop.addEventListener('click', () => api.browse());
  el.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      api.browse();
    }
  });

  el.btnHistory.addEventListener('click', () => {
    view = view === 'history' ? 'home' : 'history';
    popOpen = false;
    render();
  });

  function openAccounts() {
    view = 'home';
    popOpen = true;
    render();
  }

  el.btnAuth.addEventListener('click', (e) => {
    e.stopPropagation();
    popOpen = !popOpen;
    if (popOpen) api.refreshAccounts(); // re-check the service: a drive app installed a moment ago turns "Get app" into "Connect"
    render();
  });

  // Connect / Disconnect buttons inside the accounts panel.
  el.accounts.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    if (button.dataset.act === 'login') api.login(button.dataset.provider);
    else if (button.dataset.act === 'logout') api.logout(button.dataset.provider);
    else if (button.dataset.act === 'setup') {
      setupFor = button.dataset.provider;
      render();
      el.setupId.focus();
    }
  });

  // One-time setup form (client id), then straight on to the browser sign-in.
  el.setupBack.addEventListener('click', () => { setupFor = null; render(); });
  el.setupApp.addEventListener('click', () => { if (setupFor) api.openLink(DRIVE_APP[setupFor].url); });
  el.setupConsole.addEventListener('click', () => { if (el.setupConsole.dataset.url) api.openLink(el.setupConsole.dataset.url); });
  el.setupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = el.setupId.value.trim();
    if (!setupFor || !id) return;
    api.configureDrive(setupFor, id, el.setupSecret.value.trim());
  });

  el.codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.codeInput.value.trim();
    if (!code) return;
    api.submitCode(code);
    el.codeInput.value = '';
  });

  document.addEventListener('click', (e) => {
    if (popOpen && !el.pop.contains(e.target)) {
      popOpen = false;
      render();
    }
  });

  el.btnHide.addEventListener('click', () => api.hide());
  el.statusAction.addEventListener('click', (e) => {
    e.stopPropagation(); // some actions open the accounts panel; don't let the outside-click handler close it again
    statusAction?.();
  });
  el.btnClear.addEventListener('click', () => api.clearHistory());

  el.list.addEventListener('click', (e) => {
    const row = e.target.closest('.item');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'retry') return api.retry(id);
    if (act === 'cancel') return api.cancel(id);
    if (act === 'folder') return api.openResult(id);
    if (act === 'open') {
      const job = state?.jobs.find((j) => j.id === id);
      if (job?.url) api.openLink(job.url);
      return;
    }
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    row.classList.toggle('expanded');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (setupFor) setupFor = null;
    else if (popOpen) popOpen = false;
    else if (view === 'history') view = 'home';
    else return api.hide();
    render();
  });

  // ---- lifecycle ---------------------------------------------------------------

  api.onState((s) => {
    const wasWaitingForCode = !!state?.auth.needsCode;
    state = s;
    if (s.auth.needsCode && !wasWaitingForCode) popOpen = true; // the sign-in link just opened: ask for the code right away
    render();
  });

  api.onVisibility((v) => {
    document.body.classList.toggle('out', v === 'hide');
  });

  // After the fade-out finishes, tell the main process it can really hide the window.
  el.card.addEventListener('transitionend', (e) => {
    if (e.target !== el.card || e.propertyName !== 'opacity') return;
    if (!document.body.classList.contains('out')) return;
    resetLayers();
    api.hidden();
  });

  api.getState().then((s) => {
    state = s;
    render();
    api.ready();
  });
})();
