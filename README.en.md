# dsh-synced-tabs

> Session tabs for the DeepSeek Harness (DSH) Web GUI: every conversation you have opened becomes an explicit
> set of tabs that is **shared across all devices attached to the same host**.

[中文](README.md) · MIT · Requires DSH `>= 0.2.1`

[![CI](https://github.com/mujiannan/dsh-synced-tabs/actions/workflows/ci.yml/badge.svg)](https://github.com/mujiannan/dsh-synced-tabs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-synced-tabs)](https://www.npmjs.com/package/dsh-synced-tabs)
[![license](https://img.shields.io/npm/l/dsh-synced-tabs)](LICENSE)

## What it solves

- **Too many sessions.** DSH opens conversations from the left sidebar; once you switch away there is no
  view of "which ones do I have open". This gives you a tab strip.
- **Multiple devices.** A tab closed on your desktop should not stay open on your phone, and a session opened
  on your phone should show up on the desktop within seconds. The tab set is shared state, not a local view.
- **Phones.** Touch has no hover, and squeezing a tab strip into the top edge makes titles unreadable and
  targets unmissable. On narrow viewports the bar collapses to "current session + drawer" and moves to the
  bottom of the screen.
- **Status at a glance.** Running, waiting for your answer, finished-unread: each tab carries a status dot,
  and the drawer trigger carries an aggregate one.

## What makes it different

- **Cross-device sharing is the design, not an add-on.** The host half serves an exact
  `GET/POST /api/dsh-tabs/state` route backed by `$DSH_HOME/dsh-tabs/state.json`. The client keeps an
  optimistic view, a resend queue and a 3-second poll, falls back to local-only mode when the host is
  unreachable, and flushes on recovery.
- **Phones are first-class.** Bottom-anchored bar, drawer opened from the bottom-left, a drawer that does not
  cover the bar, and a soft keyboard that compresses the layout viewport (`interactive-widget=resizes-content`)
  instead of panning the page out from under you. Every one of these is backed by on-device measurements — see
  [COMPATIBILITY.md](COMPATIBILITY.md).
- **Zero intrusion.** It only mounts into the official `shell.overlay` slot, only uses its own data attributes,
  one CSS variable and one exact route. No host files are touched, and uninstalling leaves nothing behind.
  Single-file client, no build step, no runtime dependencies (peers are DSH packages and `react`).
- **Verifiable.** 75 offline tests execute the real `client.js` bytes in a `node:vm` harness — no browser, no
  running DSH instance. Per-version measurements live in the compatibility table.

## Install

```bash
dsh plugin --profile web add dsh-synced-tabs
```

Reload the page (or let the host reload plugins) and the tab strip appears at the top of the Web GUI. To remove:

```bash
dsh plugin --profile web remove dsh-synced-tabs
```

## Usage

| Action | Desktop | Phone |
|---|---|---|
| Switch session | Click a tab, or `←`/`→` while the tab strip has focus (`Alt+Shift+←/→` reorders) | Tap a tab, or tap `≡ N` at the bottom-left of the bar to open the drawer |
| Close a tab | `×` on the tab, middle-click the tab, or focus it and press `Delete`/`Backspace` | `×` on the right of a drawer row |
| See status | Status dot on each tab (running / waiting / finished-unread); hover shows the wording | The second line of each drawer row spells out status and workspace |
| See ownership | Workspace colour bar on the inner-left edge, plus a workspace badge; tabs of one workspace join seamlessly | Colour bar on the row, workspace name on the second line |

Closing a tab **never** deletes, archives or stops the session — it only leaves the shared set.

## Cross-device sync: scope and degradation

- Scope is **one DSH host instance** (`$DSH_HOME`) and all browsers/devices attached to it. It is not sync
  between two separately deployed hosts.
- Client and host talk over an exact route plus polling, not a WebSocket or event stream. Tab changes are
  low-frequency; a 3-second poll is enough and survives host restarts and network blips.
- If the host endpoint is unavailable (older host, host half not loaded), the client drops to local-only mode
  and replays its queue once the endpoint is back.
- Conflict rules, `seq` semantics and the state file format are documented in [docs/DESIGN.md](docs/DESIGN.md) §4.8.

## Compatibility

The DSH client API is still moving fast, so every host version is re-validated. Per-version results (bar
height, drawer geometry, on-device readings, test count) are in [COMPATIBILITY.md](COMPATIBILITY.md);
untested versions are marked "unverified" rather than guessed.

## Development

```bash
npm test        # 75 offline tests: run the real client.js in node:vm with a minimal React stand-in and fake DOM
```

Layout:

```
client.js             client half (single file, no build)
index.js              host half entry
lib/host.js           host half: state file + the exact /api/dsh-tabs/state route
lib/client.d.ts       host contract types (which APIs, from which DSH version)
cordis.patch.yml      inserts exactly one plugin mount
docs/DESIGN.md        design record: rationale, pitfalls, budget and maintenance rules
COMPATIBILITY.md      per-DSH-version measurement table
test/                 offline tests (the harness executes the real source)
```

**Why internal identifiers still say `dsh-tabs`**: this plugin was deployed before the rename, so
`data-dsh-tabs`, `--dsh-tabs-h`, `/api/dsh-tabs/state` and `$DSH_HOME/dsh-tabs/state.json` are the existing
mount and data contract; renaming them would drop the shared tab set. Only the package name, plugin id and
docs use `dsh-synced-tabs`.

## Explicitly out of scope

- Creating sessions (use the host's own entry points).
- Hooking the session lifecycle; closing a tab does not touch the session.
- Drag reordering, pinning, archiving, split views — this version optimises for one tab set that stays aligned
  across devices.
- Syncing between two separately deployed DSH hosts.

## License

MIT — see [LICENSE](LICENSE).
