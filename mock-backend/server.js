'use strict';

/**
 * Stand-in for the DropShine Windows service (see DropShineBackend), implementing the same HTTP/SSE contract.
 * Run with `npm run mock` to try the app without the real backend.
 *
 *   MOCK_SIGNED_IN=1   start with Claude already signed in
 *   MOCK_NEEDS_CODE=1  Claude sign-in asks for a pasted code (like the real service); any code of 8+ characters works
 *   MOCK_DRIVE_SETUP=1 Google Drive has no drive app: Connect asks for a client id once, then "opens the browser"
 *   MOCK_SPEED=0.5     scale the simulated AI delays (lower = faster)
 *   MOCK_UPLOAD_MS=50  delay per received chunk, to watch the upload progress bar
 *   PORT=47800
 *
 * Files whose name contains "fail" make the simulated AI step error out.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function createMock({ signedIn = false, speed = 1, uploadDelayMs = 0, needsCode = false, driveSetup = false } = {}) {
  const sse = new Set();
  const jobs = new Map();
  const claude = { signedIn, user: signedIn ? 'demo@dropshine.local' : null, pending: false, needsCode: false };
  // viaApp: the drive's own app is "installed" (connects on the spot). Otherwise direct sign-in, which first needs a client id.
  const drives = {
    google: { signedIn: false, user: null, mode: null, pending: false, configured: !driveSetup, viaApp: !driveSetup },
    microsoft: { signedIn: false, user: null, mode: null, pending: false, configured: false, viaApp: false },
  };
  const setupInfo = {
    google: { redirectUri: 'http://127.0.0.1:47800/oauth/google/callback', consoleUrl: 'https://console.cloud.google.com/apis/credentials', needsSecret: true },
    microsoft: { redirectUri: 'http://localhost:47800/oauth/microsoft/callback', consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', needsSecret: false },
  };
  const driveName = { google: 'Google Drive', microsoft: 'OneDrive' };
  const driveAccount = (id) => {
    const d = drives[id];
    return {
      id, name: driveName[id], configured: d.configured, signedIn: d.signedIn, user: d.user, pending: d.pending, needsCode: false, mode: d.mode,
      setup: !d.configured && !d.signedIn ? setupInfo[id] : undefined,
    };
  };
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dropshine-mock-'));
  let port = 0;

  const broadcast = (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sse) res.write(line);
  };
  const authEvent = () => ({
    type: 'auth', signedIn: claude.signedIn, user: claude.user, provider: 'Claude', pending: claude.pending, needsCode: claude.needsCode,
    accounts: [
      { id: 'claude', name: 'Claude', configured: true, signedIn: claude.signedIn, user: claude.user, pending: claude.pending, needsCode: claude.needsCode },
      driveAccount('google'),
      driveAccount('microsoft'),
    ],
  });
  const after = (ms, fn) => setTimeout(fn, ms * speed).unref();

  async function readJson(req) {
    let text = '';
    for await (const chunk of req) text += chunk;
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  function runAi(id, name) {
    const job = jobs.get(id);
    const step = (patch) => {
      Object.assign(job, patch);
      broadcast({ type: 'job', id, ...patch });
    };
    after(500, () => step({ stage: 'ai', message: 'Triage agent: analysing language and tone' }));
    after(1400, () => step({ stage: 'ai', message: 'Writer agent: drafting the documentation', progress: 0.5 }));
    after(2600, () => step({ stage: 'ai', message: 'Diagrammer agent: designing the flow diagram', progress: 0.8 }));
    after(3400, () => {
      if (/fail/i.test(name)) return step({ stage: 'error', error: 'The AI could not process this file' });
      const folder = path.join(outRoot, id);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${path.parse(name).name}.documentation.md`);
      fs.writeFileSync(file, `# ${name}\n\nMock documentation.\n`);
      step({
        stage: 'done', message: 'Done', summary: `Mock summary of ${name}: three key points were found.`,
        folder, files: [{ name: path.basename(file), kind: 'documentation', path: file, size: fs.statSync(file).size }],
      });
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    // Browser-facing pages that finish a fake sign-in (no client header needed, like the real OAuth redirect).
    if (req.method === 'GET' && url.pathname === '/mock/login') {
      Object.assign(claude, { signedIn: true, user: 'demo@dropshine.local', pending: false, needsCode: false });
      broadcast(authEvent());
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<h3 style="font-family:sans-serif">Signed in to the mock AI. You can close this tab.</h3>');
    }
    // The page the browser lands on after the (fake) Google / Microsoft login.
    const driveLogin = url.pathname.match(/^\/mock\/drive-login\/(google|microsoft)$/);
    if (req.method === 'GET' && driveLogin) {
      const id = driveLogin[1];
      Object.assign(drives[id], { signedIn: true, user: `${id}.user@example.com`, mode: 'oauth', pending: false });
      broadcast(authEvent());
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<h3 style="font-family:sans-serif">Signed in to ${driveName[id]} (mock). You can close this tab.</h3>`);
    }

    if (!req.headers['x-dropshine-client']) return json(403, { error: 'Missing X-DropShine-Client header' });

    if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, version: 'mock' });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(authEvent())}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      sse.add(res);
      req.on('close', () => {
        clearInterval(ping);
        sse.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/status') return json(200, authEvent());

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { provider = 'claude' } = await readJson(req);
      if (drives[provider]) {
        const d = drives[provider];
        if (!d.configured) {
          return json(400, { error: `${driveName[provider]} isn't available on this PC. Install and sign in to the ${driveName[provider]} app (no setup needed), or enter a client ID to sign in directly.` });
        }
        if (d.viaApp) {
          // Like the real service with the drive's own app installed: connected on the spot, nothing to sign in to.
          Object.assign(d, { signedIn: true, user: provider === 'google' ? 'demo@gmail.example' : 'demo@onedrive.example', mode: 'sync', pending: false });
          broadcast(authEvent());
          return json(200, { provider, connected: true });
        }
        d.pending = true; // direct sign-in: the browser shows the provider's login page
        broadcast(authEvent());
        return json(200, { provider, url: `http://127.0.0.1:${port}/mock/drive-login/${provider}`, needsCode: false });
      }
      if (needsCode) {
        Object.assign(claude, { pending: true, needsCode: true });
        broadcast(authEvent());
        return json(200, { provider, url: 'https://claude.example/oauth/authorize?mock=1', needsCode: true });
      }
      return json(200, { provider, url: `http://127.0.0.1:${port}/mock/login`, needsCode: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/code') {
      const { code = '' } = await readJson(req);
      if (!claude.needsCode) return json(400, { error: 'No sign-in is waiting for a code. Start the sign-in again.' });
      if (!/^[\w.~#=+/-]{8,}$/.test(code)) return json(400, { error: "That doesn't look like a sign-in code." });
      Object.assign(claude, { signedIn: true, user: 'demo@dropshine.local', pending: false, needsCode: false });
      broadcast(authEvent());
      return json(204);
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const { provider = 'claude' } = await readJson(req);
      if (provider === 'claude') Object.assign(claude, { signedIn: false, user: null, pending: false, needsCode: false });
      else if (drives[provider]) Object.assign(drives[provider], { signedIn: false, user: null, mode: null, pending: false });
      broadcast(authEvent());
      return json(204);
    }

    // The one-time client id for direct sign-in, validated like the real service does.
    if (req.method === 'PUT' && url.pathname === '/api/auth/config') {
      const { provider, clientId = '', clientSecret = '' } = await readJson(req);
      if (!drives[provider]) return json(400, { error: `Unknown account '${provider}'.` });
      if (provider === 'google') {
        if (!clientId || /\s/.test(clientId)) return json(400, { error: 'Paste the client ID exactly as shown, with no spaces.' });
        if (!clientId.endsWith('.apps.googleusercontent.com')) return json(400, { error: 'A Google client ID ends with .apps.googleusercontent.com.' });
        if (!clientSecret) return json(400, { error: 'Google also needs the client secret shown next to the client ID.' });
      } else if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientId)) {
        return json(400, { error: 'A Microsoft application (client) ID looks like 00000000-0000-0000-0000-000000000000.' });
      }
      drives[provider].configured = true;
      broadcast(authEvent());
      return json(204);
    }

    if (req.method === 'POST' && url.pathname === '/api/files') {
      if (!claude.signedIn) return json(401, { error: 'Sign in with AI to continue.' });
      const id = req.headers['x-job-id'];
      const name = decodeURIComponent(req.headers['x-file-name'] || 'unnamed');
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (uploadDelayMs) await new Promise((r) => setTimeout(r, uploadDelayMs)); // simulate a slow link
      }
      jobs.set(id, { id, name, bytes, stage: 'ai', message: 'Queued for AI' });
      runAi(id, name);
      return json(202, { id, message: 'Queued for AI' });
    }

    const m = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(decodeURIComponent(m[1]));
      return job ? json(200, job) : json(404, { error: 'Unknown job' });
    }

    return json(404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  return {
    claude,
    drives,
    broadcast,
    outRoot,
    listen: (p = 0) =>
      new Promise((resolve) =>
        server.listen(p, '127.0.0.1', () => {
          port = server.address().port;
          resolve(port);
        }),
      ),
    close: () =>
      new Promise((resolve) => {
        for (const res of sse) res.destroy();
        server.close(() => {
          fs.rmSync(outRoot, { recursive: true, force: true });
          resolve();
        });
        // close() alone waits for keep-alive connections that were mid-request; force them shut so it can never hang.
        server.closeAllConnections?.();
      }),
  };
}

module.exports = { createMock };

if (require.main === module) {
  const mock = createMock({
    signedIn: process.env.MOCK_SIGNED_IN === '1',
    needsCode: process.env.MOCK_NEEDS_CODE === '1',
    driveSetup: process.env.MOCK_DRIVE_SETUP === '1',
    speed: Number(process.env.MOCK_SPEED) || 1,
    uploadDelayMs: Number(process.env.MOCK_UPLOAD_MS) || 0,
  });
  mock.listen(Number(process.env.PORT) || 47800).then((port) => {
    console.log(`DropShine mock backend on http://127.0.0.1:${port} (Claude ${mock.claude.signedIn ? 'signed in' : 'signed out'}${process.env.MOCK_NEEDS_CODE === '1' ? ', paste-code sign-in' : ''})`);
  });
}
