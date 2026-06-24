# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm i

# Run in dev (nodemon auto-restarts Electron on changes to *.js/*.html/*.css)
npm run start

# Rebuild the sqlite3 native module against the current Electron version
# (run this if you see NODE_MODULE_VERSION / native binding errors after npm install)
npm run rebuild-native

# Package for Windows (NSIS x64). Runs rebuild-native first.
npm run dist
```

Notes:
- `npm run start` passes `--dev` to Electron; `main.js` uses this switch to auto-open DevTools.
- There is no test runner or linter configured in this repo.
- Node 20.12.1 is the version the author developed against.

## Architecture

Three-process Electron app following the standard main / preload / renderer split, plus a SQLite3 layer in the main process.

### Process layout

- `main.js` (main process): window lifecycle, tray, global shortcuts, SQLite3 connection, and ALL `ipcMain.handle(...)` handlers (the `study:*` and `app:notify` channels).
- `preload.js`: exposes a single `window.studyRecord` object via `contextBridge`, mapping each renderer method to its IPC channel. **All renderer ↔ DB communication must go through this bridge** — no direct `require` in the renderer.
- `renderer.js` + `index.html` + `styles.css`: UI only. Uses `window.studyRecord.*` for everything that touches disk or system features.

When adding a feature that needs persistence or OS access:
1. Add an `ipcMain.handle('study:foo', ...)` in `main.js`.
2. Add a corresponding method to the `contextBridge.exposeInMainWorld('studyRecord', {...})` block in `preload.js`.
3. Call `window.studyRecord.foo(...)` from `renderer.js`.

### Window behavior (intentional, easy to break)

The main window is `frame: false`, `titleBarStyle: 'hidden'`, `alwaysOnTop: true`, `resizable: false`, with the menu bar fully removed. The `.titlebar` element in `index.html` is the drag region — preserve it when editing the DOM. The window also intercepts `close` and hides to a tray icon (`createTray`) instead of quitting; only `safeQuit` (called from the tray menu or `Ctrl+Alt+Q`) actually exits, and it first sends `global-shortcut: 'end'` to the renderer so any in-progress session is closed in the DB before `app.quit()` fires ~500ms later.

### Global shortcuts

Registered in `registerGlobalShortcuts(win)`:

| Shortcut    | Action                                            |
| ----------- | ------------------------------------------------- |
| Ctrl+Alt+S  | Start session (sends `global-shortcut: 'start'`)  |
| Ctrl+Alt+E  | End session (sends `global-shortcut: 'end'`)      |
| Ctrl+Alt+1  | Show window                                       |
| Ctrl+Alt+2  | Close window (hides to tray, per close handler)   |
| Ctrl+Alt+Q  | `safeQuit` — flush end-session then quit          |
| Ctrl+Alt+M  | Toggle mini mode (sends `global-shortcut: 'toggleMiniMode'`) |
| Ctrl+Alt+T  | Toggle theme (sends `global-shortcut: 'toggleTheme'`)         |

Start/end shortcuts are handled by the renderer (`window.studyRecord.onGlobalShortcut`) which programmatically clicks the corresponding button so UI state stays consistent.

### Database

- SQLite3 via the `sqlite3` native module. Two tables created in `initDatabase()`:
  - `study_sessions(id, start_time, end_time, duration, created_at)` — one row per study session; `duration` (seconds) is computed in `study:end-session`.
  - `user_config(key, value)` — KV store. Used keys: `stat_time_range` (JSON `{start,end}`), `notified_over_2h_state` (JSON `{date,count}` for daily-resetting 2h notification).
- `getDatabasePath()` returns `outer/study_time.db` in dev and `resources/app.asar.unpacked/outer/study_time.db` when packaged. The `outer/` folder is listed under `build.asarUnpack` in `package.json` precisely so the DB remains writable from the installed app — **do not move `study_time.db` out of `outer/`** without updating both that config and `getDatabasePath()`.
- `sql/*.sql` files are reference schemas only; they are not executed at runtime (the `CREATE TABLE IF NOT EXISTS` calls in `main.js` are authoritative).

### Time handling (subtle)

Timestamps stored in `study_sessions.start_time` / `end_time` are written by the renderer using `toChinaTimeString()` — `"YYYY-MM-DD HH:mm:ss"` strings representing **China time (UTC+8) with no timezone suffix**. `parseChinaTime()` (renderer) and `parseDbTime()` (main) handle this format plus legacy shapes (`T` separator with `+08:00` / `Z` / no suffix, pre-v5 data). When adding code that reads or writes these columns, use these helpers rather than `new Date(...)` — bare `new Date()` interprets `"YYYY-MM-DD HH:mm:ss"` as UTC and will shift timestamps by 8 hours.

The "today" window is configurable: `stat_time_range` defaults to `05:00-05:00` (a full day starting at 5am, which spans midnight). `inStatRange()` in `renderer.js` is the canonical implementation of "does this timestamp belong to the current statistical day?" — reuse it instead of doing date math inline.

### Daily quote

Quotes live in the `study_quotes` table (added by a later migration). `loadWordsFromDB()` reads enabled rows at startup into the in-memory `words` array; `study:get-word` returns a random entry. The legacy `outer/word.txt` file has been removed — quote CRUD goes through the `quote:*` IPC handlers and reflects on next app start (or call `loadWordsFromDB()` again to refresh).
