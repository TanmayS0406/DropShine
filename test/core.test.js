'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMock } = require('../mock-backend/server');
const { createCore } = require('../src/main/core');

let dir;
let mock;
let core;

async function setup({ signedIn, needsCode = false, driveSetup = false }) {
  mock = createMock({ signedIn, needsCode, driveSetup, speed: 0.02 });
  const port = await mock.listen(0);
  core = createCore({
    apiBase: `http://127.0.0.1:${port}`,
    version: 'test',
    historyFile: path.join(dir, 'history.json'),
    // Stand-in for the user's browser completing the login page.
    openExternal: (url) => fetch(url).catch(() => {}),
  });
  core.backend.connectEvents();
  await until(() => core.backend.online && core.auth.state.known);
}

function until(fn, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for: ${fn}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function tmpFile(name, content = 'hello world') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropshine-'));
});

afterEach(async () => {
  core?.backend.stopEvents();
  core?.store.flush();
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  core = mock = undefined;
});

test('a dropped file uploads, runs through the AI and finishes with a summary', async () => {
  await setup({ signedIn: true });
  const stages = new Set();
  core.jobs.on('change', () => core.jobs.jobs.forEach((j) => stages.add(j.stage)));

  await core.jobs.add([tmpFile('report.txt')]);
  await until(() => core.jobs.jobs[0].stage === 'done');

  const job = core.jobs.jobs[0];
  assert.equal(job.name, 'report.txt');
  assert.match(job.summary, /report\.txt/);
  assert.ok(stages.has('uploading') && stages.has('ai'), `saw stages: ${[...stages]}`);
});

test('an AI failure surfaces as an error and can be retried', async () => {
  await setup({ signedIn: true });
  await core.jobs.add([tmpFile('please-fail.txt')]);
  await until(() => core.jobs.jobs[0].stage === 'error');
  assert.equal(core.jobs.jobs[0].error, 'The AI could not process this file');

  core.jobs.retry(core.jobs.jobs[0].id);
  assert.equal(core.jobs.jobs[0].stage, 'uploading'); // retry re-queues and starts right away
  assert.equal(core.jobs.jobs[0].error, null);
  await until(() => core.jobs.jobs[0].stage === 'error'); // the mock fails this name every time
});

test('files wait for sign-in, then upload automatically once logged in', async () => {
  await setup({ signedIn: false });
  assert.equal(core.auth.state.signedIn, false);

  await core.jobs.add([tmpFile('notes.txt')]);
  assert.equal(core.jobs.jobs[0].stage, 'queued');
  assert.equal(core.jobs.jobs[0].message, 'Waiting for sign-in');

  await core.auth.login(); // opens the mock login page -> service pushes an auth event
  await until(() => core.auth.state.signedIn);
  await until(() => core.jobs.jobs[0].stage === 'done');
});

test('uploading while the service is down fails with a readable message', async () => {
  await setup({ signedIn: true });
  await mock.close();
  await core.jobs.add([tmpFile('a.txt')]);
  await until(() => core.jobs.jobs[0].stage === 'error');
  assert.equal(core.jobs.jobs[0].error, "Can't reach the DropShine service");
  mock = undefined; // already closed
});

test('folders and missing files are rejected without being uploaded', async () => {
  await setup({ signedIn: true });
  await core.jobs.add([dir, path.join(dir, 'nope.txt')]);
  const byName = Object.fromEntries(core.jobs.serialize().map((j) => [j.name, j]));
  assert.equal(byName[path.basename(dir)].error, "Folders aren't supported yet");
  assert.equal(byName[path.basename(dir)].retryable, false);
  assert.equal(byName['nope.txt'].error, 'File not found');
});

test('history survives a restart and in-flight uploads are marked interrupted', async () => {
  await setup({ signedIn: true });
  await core.jobs.add([tmpFile('keep.txt')]);
  await until(() => core.jobs.jobs[0].stage === 'done');
  core.jobs.jobs.unshift({ id: 'x', name: 'half.bin', path: 'x', stage: 'uploading', progress: 0.4, addedAt: Date.now() });
  core.jobs._persist();
  core.store.flush();

  const again = createCore({
    apiBase: 'http://127.0.0.1:1', version: 'test', historyFile: path.join(dir, 'history.json'), openExternal() {},
  });
  const byName = Object.fromEntries(again.jobs.serialize().map((j) => [j.name, j]));
  assert.equal(byName['keep.txt'].stage, 'done');
  assert.equal(byName['half.bin'].stage, 'error');
  assert.match(byName['half.bin'].error, /Interrupted/);
});

test('Claude sign-in asks for the code the browser shows, rejects bad ones, and completes with a good one', async () => {
  await setup({ signedIn: false, needsCode: true });
  const opened = [];
  core.auth.openExternal = (url) => opened.push(url);

  await core.auth.login();
  assert.equal(opened.length, 1);                         // the link is opened for the user
  await until(() => core.auth.state.needsCode);
  assert.equal(core.auth.state.pending, true);

  await core.auth.submitCode('nope');                      // refused by the service; the app keeps waiting for a code
  assert.match(core.auth.state.error, /doesn't look like a sign-in code/);
  assert.equal(core.auth.state.needsCode, true);

  await core.auth.submitCode('AbCd1234#state99');
  await until(() => core.auth.state.signedIn);
  assert.equal(core.auth.state.needsCode, false);
  assert.equal(core.auth.state.pending, false);
  assert.equal(core.auth.state.user, 'demo@dropshine.local');
});

test('drives are listed as accounts and can be connected and disconnected; an unconfigured one explains itself', async () => {
  await setup({ signedIn: true });
  const byId = () => Object.fromEntries(core.auth.state.accounts.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(byId()).sort(), ['claude', 'google', 'microsoft']);
  assert.equal(byId().google.signedIn, false);

  const opened = [];
  core.auth.openExternal = (url) => opened.push(url);
  await core.auth.login('google');                         // connects on the spot through the drive app: no browser involved
  await until(() => byId().google.signedIn);
  assert.equal(opened.length, 0);
  assert.equal(byId().google.mode, 'sync');
  assert.equal(byId().google.user, 'demo@gmail.example');
  assert.equal(core.auth.state.signedIn, true);            // Claude is unaffected

  await core.auth.logout('google');
  await until(() => !byId().google.signedIn);
  assert.equal(core.auth.state.signedIn, true);

  await core.auth.login('microsoft');
  assert.match(byId().microsoft.error, /isn't available on this PC.*OneDrive app/i);   // says what to do, not "configure a client id"
});

test('a drive with no app on this PC asks for a client id once, explains a bad paste, then opens the browser to sign in', async () => {
  await setup({ signedIn: true, driveSetup: true });
  const byId = () => Object.fromEntries(core.auth.state.accounts.map((a) => [a.id, a]));
  const opened = [];
  core.auth.openExternal = (url) => opened.push(url);

  assert.equal(byId().google.configured, false);
  assert.equal(byId().google.setup.needsSecret, true);     // the panel is told what to ask for
  assert.match(byId().google.setup.consoleUrl, /console\.cloud\.google\.com/);

  assert.equal(await core.auth.configureDrive('google', 'nope', 'x'), false);   // pasted wrongly: explained, nothing opens
  assert.match(byId().google.error, /apps\.googleusercontent\.com/);
  assert.equal(opened.length, 0);

  assert.equal(await core.auth.configureDrive('google', '123-abc.apps.googleusercontent.com', 'a-secret'), true);
  assert.equal(opened.length, 1);                           // Save and sign in: Google's page opens in the browser
  assert.match(opened[0], /\/mock\/drive-login\/google$/);
  assert.equal(byId().google.pending, true);
  assert.equal(byId().google.setup, undefined);             // never asked again

  await fetch(opened[0]);                                   // the user signs in over there
  await until(() => byId().google.signedIn);
  assert.equal(byId().google.mode, 'oauth');
  assert.equal(byId().google.user, 'google.user@example.com');

  assert.equal(await core.auth.configureDrive('dropbox', 'x', 'y'), false);     // unknown accounts are ignored
});

test('finished jobs keep their result files; the page gets names but never paths, and a result can be located', async () => {
  await setup({ signedIn: true });
  await core.jobs.add([tmpFile('report.txt')]);
  await until(() => core.jobs.jobs[0].stage === 'done');

  const job = core.jobs.jobs[0];
  assert.equal(job.files[0].kind, 'documentation');
  const pub = core.jobs.serialize()[0];
  assert.deepEqual(Object.keys(pub.files[0]).sort(), ['kind', 'name', 'size']);
  assert.equal(pub.hasFolder, true);
  assert.equal('folder' in pub, false);

  const target = core.jobs.resultPath(job.id);
  assert.ok(fs.existsSync(target), `result should exist: ${target}`);
  assert.equal(core.jobs.resultPath('no-such-job'), null);

  core.jobs.retry(job.id);                                 // done jobs can't be retried...
  assert.equal(core.jobs.get(job.id).stage, 'done');
});

test('a service that sends no account list still works (Claude only)', async () => {
  await setup({ signedIn: false });
  core.auth.apply({ type: 'auth', signedIn: true, user: 'x@y.z' });
  assert.deepEqual(core.auth.state.accounts.map((a) => a.id), ['claude']);
  assert.equal(core.auth.state.accounts[0].user, 'x@y.z');
});
