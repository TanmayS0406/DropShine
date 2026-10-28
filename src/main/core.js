'use strict';

const { Backend } = require('./backend');
const { Auth } = require('./auth');
const { JobManager } = require('./jobs');
const { JsonStore } = require('./store');

/**
 * Wires the service client, auth and job queue together. Pure Node (no Electron
 * imports) so the same wiring is used by the app and by the tests.
 */
function createCore({ apiBase, version, historyFile, openExternal }) {
  const backend = new Backend({ base: apiBase, version });
  const auth = new Auth({ backend, openExternal });
  const store = new JsonStore(historyFile);
  const jobs = new JobManager({ backend, auth, store });

  backend.on('event', (evt) => {
    if (evt.type === 'auth') auth.apply(evt);
    else if (evt.type === 'job') jobs.applyEvent(evt);
  });

  backend.on('online', () => {
    auth.refresh();
    jobs.reconcile();
  });

  // Signing in releases files that were held back; signing out re-labels them.
  auth.on('change', () => jobs.pump());

  return { backend, auth, jobs, store };
}

module.exports = { createCore };
