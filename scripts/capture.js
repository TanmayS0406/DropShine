'use strict';

/**
 * Dev tool: runs the real app against an in-process mock backend, walks through the main
 * scenarios (including a genuine drag-and-drop via the DevTools protocol) and saves a
 * screenshot of each step.
 *
 *   npx electron scripts/capture.js            (SHOTS_DIR=... to choose where PNGs go)
 *
 * Uses a throwaway user-data folder, so it never touches real settings or history.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, globalShortcut } = require('electron');
const { createMock } = require('../mock-backend/server');

const OUT = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'dropshine-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 10_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dropshine-ud-'));
app.setPath('userData', userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ idleDestroyMs: 1500 }));
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const mock = createMock({ signedIn: false, speed: 1, uploadDelayMs: 40, needsCode: true, driveSetup: true });
  const port = await mock.listen(0);
  process.env.DROPSHINE_API = `http://127.0.0.1:${port}`;

  const main = require('../src/main/main');
  await app.whenReady();
  await waitFor(() => main.ctx, 'app start');
  const { windows, core } = main.ctx;
  const { jobs, auth, backend } = core;
  const log = (...a) => console.log('[capture]', ...a);

  const win = () => windows.browserWindow;
  const js = (code) => win().webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(250);
    const img = await win().webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    log('saved', name);
  };
  const drag = async (type, files = []) => {
    const wc = win().webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Input.dispatchDragEvent', {
      type, x: 180, y: 110, data: { items: [], files, dragOperationsMask: 1 },
    });
  };

  await waitFor(() => backend.online && auth.state.known, 'service connection');
  log('hotkey registered:', globalShortcut.isRegistered('Control+Alt+D'));

  // 1. open signed out
  windows.show();
  await waitFor(() => windows.visible, 'window visible');
  await shot('01-home-signed-out');

  // 2. a real drop (through the preload's drop handler + webUtils.getPathForFile)
  const file = path.join(userData, 'quarterly-report.pdf');
  fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 7));
  await drag('dragEnter', [file]);
  await shot('02-dragging');
  await drag('dragOver', [file]);
  await drag('drop', [file]);
  await waitFor(() => jobs.jobs.some((j) => j.name === 'quarterly-report.pdf'), 'dropped file to reach the job queue');
  log('drop reached main as job:', jobs.jobs[0].name, jobs.jobs[0].stage, jobs.jobs[0].message);
  await shot('03-waiting-for-signin');

  // 3. sign in the way the real service does: a link to open, then a code to paste back
  const opened = [];
  auth.openExternal = (url) => opened.push(url); // don't launch a real browser
  await auth.login();
  await waitFor(() => auth.state.needsCode, 'the sign-in code prompt');
  await sleep(300);
  await shot('03b-code-prompt');
  log('sign-in link opened:', opened[0]);
  await auth.submitCode('AbCd1234#state99');
  await waitFor(() => auth.state.signedIn, 'sign-in');
  await js(`document.body.click()`); // close the accounts panel
  await waitFor(() => jobs.jobs[0].stage === 'uploading', 'upload to start');
  await sleep(900);
  await shot('04-uploading');
  await waitFor(() => jobs.jobs[0].stage === 'ai', 'AI stage');
  await sleep(300);
  await shot('05-ai-running');

  // 4. a failing file, then history
  const bad = path.join(userData, 'fail-me.txt');
  fs.writeFileSync(bad, 'x');
  await jobs.add([bad]);
  await waitFor(() => jobs.jobs.every((j) => j.stage === 'done' || j.stage === 'error'), 'all jobs to finish', 20_000);
  await js(`document.getElementById('btn-history').click()`);
  await shot('06-history');
  await js(`document.querySelector('.item[data-stage="done"]')?.click()`);
  await shot('07-history-expanded');

  // 5. accounts panel: a drive that isn't available must offer a way forward, not a dead button
  await js(`document.getElementById('btn-history').click()`);
  await js(`document.getElementById('btn-auth').click()`);
  await sleep(300);
  await shot('08-signed-in-popover');
  const rows = await js(`Array.from(document.querySelectorAll('#accounts .account')).map(r => ({
    name: r.querySelector('.account-name').textContent, sub: r.querySelector('.account-sub').textContent,
    button: r.querySelector('button').textContent, disabled: r.querySelector('button').disabled }))`);
  for (const r of rows) log(`account row: ${r.name} | "${r.button}"${r.disabled ? ' (disabled)' : ''} | ${r.sub}`);
  const stub = []; // never launch a real browser from this script
  require('electron').shell.openExternal = async (url) => { stub.push(url); };

  // Google Drive has no drive app here, so Connect asks for a client id once...
  await js(`document.querySelector('#accounts button[data-act="setup"][data-provider="google"]').click()`);
  await sleep(300);
  await shot('08b-drive-setup');
  await js(`document.querySelector('#setup-app').click()`);          // "Use the drive app instead"
  await js(`document.querySelector('#setup-console').click()`);       // "Open Google Cloud Console"
  await sleep(200);
  log('setup links open:', stub.join(' | '));

  // ...a bad paste is explained and nothing opens...
  const form = (id, secret) => js(`(() => { const i = document.getElementById('setup-id'), s = document.getElementById('setup-secret'); i.value = ${JSON.stringify(id)}; s.value = ${JSON.stringify(secret)}; document.getElementById('setup-form').requestSubmit(); })()`);
  await form('nope', 'x');
  await waitFor(async () => (await js(`document.getElementById('setup-error').hidden === false`)), 'the paste error');
  await shot('08c-bad-paste');
  log('bad paste -> browser opened:', opened.some((u) => u.includes('drive-login')));

  // ...and a good one saves, then opens Google in the browser.
  await form('123-abc.apps.googleusercontent.com', 'GOCSPX-secret');
  await waitFor(() => opened.some((u) => u.includes('/mock/drive-login/google')), 'the Google sign-in to open');
  log('good paste -> browser opens:', opened.find((u) => u.includes('drive-login')));
  await sleep(400);
  await shot('08d-waiting-for-google');
  await fetch(opened.find((u) => u.includes('drive-login')));         // the user finishes signing in over there
  await waitFor(async () => (await js(`document.body.innerText.includes('google.user@example.com')`)), 'Google connected');
  await shot('08e-google-connected');
  await js(`document.body.click()`);

  // 6. hide, then confirm the renderer is released after the idle timeout
  windows.hide();
  await waitFor(() => !windows._visible, 'window hidden');
  log('hidden; renderer alive:', !!win());
  await waitFor(() => !win(), 'idle teardown of the window', 6000);
  log('after idle: renderer destroyed:', !win());
  await sleep(1000);
  const metrics = app.getAppMetrics().map((m) => `${m.type}: ${(m.memory.workingSetSize / 1024).toFixed(0)} MB, cpu ${m.cpu.percentCPUUsage.toFixed(2)}%`);
  log('idle processes ->', metrics.join(' | '));

  // 7. bring it back: history must persist across window re-creation
  windows.show();
  await waitFor(() => windows.visible, 'window re-opened');
  await shot('09-reopened');

  await mock.close();
  app.exit(0);
})().catch((err) => {
  console.error('[capture] FAILED:', err);
  app.exit(1);
});
