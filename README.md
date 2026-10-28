# DropShine

A tiny always-on-top drop target that lives in the system tray. Press **Ctrl+Alt+D**, drop files on it, and they are sent to the DropShine Windows service (.NET), which uses Claude to turn them into professional English documentation. The app shows upload and AI progress, keeps a short history, and has an accounts panel to sign in with AI and connect Google Drive or OneDrive.

```
npm install
npm run mock      # fake backend on http://127.0.0.1:47800 (starts signed out)
npm start         # the app  -> press Ctrl+Alt+D
```

## Using it

| | |
|---|---|
| **Ctrl+Alt+D** | Show / hide the popup (bottom-right of the screen your cursor is on). Esc and the chevron also hide it. |
| **Drop files** | Anywhere on the card, or click the drop area to browse. Several files at once are fine (2 upload in parallel). |
| **Status strip** | Under the drop area: *Uploading name - 42%*, then *AI running*, plus Cancel / Sign in when relevant. |
| **History icon** | Recent files (last 30) with Done / Failed / progress, the AI summary, retry, a folder button that shows the documents in Explorer, and a button for the cloud copy. A badge counts active jobs, or shows a green/red dot for unseen results. |
| **Sparkle icon** | Accounts: sign in with AI (open the link, paste the code the page shows) and optionally connect Google Drive or OneDrive. Amber dot = signed out, green = signed in. |
| **Tray icon** | Click toggles the popup. The dot shows busy (amber), failed (red) or service offline (grey); the tooltip says what is happening. Right-click: Start with Windows, Open settings file, Quit. |

While the popup is hidden you still get a Windows notification when a file finishes or fails. Files dropped while signed out wait and upload automatically after sign-in.

## Settings

`%APPDATA%\DropShine\settings.json` (tray menu -> *Open settings file*; restart to apply):

```json
{
  "apiBase": "http://127.0.0.1:47800",
  "hotkey": "Control+Alt+D",
  "idleDestroyMs": 120000
}
```

`hotkey` uses [Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator). `idleDestroyMs` is how long the popup may stay hidden before its renderer is freed (`0` = never). The `DROPSHINE_API` environment variable overrides `apiBase` for one run.

## Built to run forever, cheaply

- **No window while idle.** The popup is created on first use and destroyed after 2 minutes hidden, so the Chromium renderer process isn't running. Reopening costs ~250 ms cold, ~15 ms if it was still warm.
- **Nothing polls.** Updates arrive on one Server-Sent-Events connection (the server's keep-alive is the only traffic). If the service is down, reconnects back off 2 s -> 60 s. The stream is closed on sleep and reopened on wake.
- **Nothing is pushed to a hidden window**; progress updates are coalesced to <=10/s; history is written only when a job changes stage.
- GPU compositing is disabled (a 360x250 card doesn't need it); no frameworks, no bundler, no runtime dependencies.

Measured on the dev machine: ~54 MB private memory in 3 processes and 0% CPU with no window open; ~90 MB with the popup open.

## Backend (the .NET Windows service)

The real service lives in `..\DropShineBackend` (see its README): a multi-agent pipeline on Microsoft Agent Framework that runs on **your own Claude sign-in**, turns any file into professional English documentation with an AI-designed flow diagram, organises Excel and PowerPoint files, and saves results on the PC and to Google Drive or OneDrive.

This app talks to it over plain HTTP plus Server-Sent Events on `127.0.0.1:47800`. The full contract is in the backend README; in short:

* every `/api` request carries `X-DropShine-Client`
* `POST /api/files` (raw body, `X-File-Name`, `X-Job-Id`), then `ai` / `done` / `error` events arrive on `GET /api/events`
* accounts: `GET /api/auth/status`, `POST /api/auth/login {provider}`, `POST /api/auth/code {code}`, `POST /api/auth/logout {provider}`
* a `done` event carries `files`, `folder` and, if a drive is connected, the cloud copy's `url`

**Google Drive and OneDrive need no client id and no sign-in screen**: *Connect* saves results into the folder that the OneDrive app / Google Drive for desktop on this PC already syncs (the vendor app holds the sign-in). If a PC has neither app, *Connect* asks **once** for a Google (or Microsoft) client ID, then opens the sign-in page in your browser; see the backend README for how to get one in a few minutes.

**Signing in to Claude** is a two-step flow because the service is headless: the app opens the link, the browser page shows a code, and you paste it into the account panel (it opens by itself). Google Drive and OneDrive need no code: their browser flow returns straight to the service.

`mock-backend/server.js` implements the same contract so you can try the app without the service:

```
npm run mock                      # Claude signs in with a link only
MOCK_NEEDS_CODE=1 npm run mock    # ... or with a pasted code, like the real service
```


## Project layout

```
src/main/       main process: main.js (wiring), window.js, tray.js, core.js, backend.js (HTTP/SSE client),
                jobs.js (queue + history), auth.js, store.js
src/preload/    the only bridge between the page and the main process (also handles file drops)
src/renderer/   the UI: plain HTML/CSS/JS
mock-backend/   stand-in for the Windows service
scripts/        make-icons.js (generates assets/), capture.js (runs the app and saves screenshots)
test/           npm test — job queue, auth gating, offline handling, history, against the mock
```

`npm run dist` builds a Windows installer into `dist/`. Installed builds enable *Start with Windows* on first run (toggle it from the tray menu).

## Troubleshooting

- **"Ctrl+Alt+D is unavailable"** — another app owns the shortcut. Change `hotkey` in settings, or use the tray icon.
- **`npm start` fails with `Cannot read properties of undefined (reading 'disableHardwareAcceleration')`** — the shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code extension hosts do this), which makes Electron behave like plain Node. Clear it for that shell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- **Red dot / "Service offline"** — the app can't reach `apiBase`; it keeps retrying in the background.