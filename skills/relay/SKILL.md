---
name: relay
description: "Add the relay snapshot toolbar to the current project's local page and open the relay canvas in the browser pane. Use when the user types /relay or /relay off, or asks to add or remove relay, snapshot or 'snap' the current page state, or open the relay canvas."
---

# relay

Relay is a zero-dependency local server. Its toolbar freezes the page's HTML into
`<project>.relay/snaps/`, and it hosts an annotatable canvas at `http://localhost:4400`. The folder
ignores itself, so don't edit the project's `.gitignore`.

The argument decides the mode: none or `on` → **Add**, `snap [label]` → **Snap**. `off` → do what
`/relay-off` does (its own skill; prefer pointing the user to `/relay-off`).

**Be fast.** Add should take three tool calls: the script, both servers at once, and one check. Don't
read project files, explore, or ask questions unless the script's output tells you something is
missing.

## Add

1. **Run the script** from the project root. It does all the file work in one go: it finds the entry
   file, inserts the dev-only toolbar snippet between `relay:start`/`relay:end` markers (skipping it
   if already there), and merges a `relay` config and, if missing, an app dev-server config into
   `.claude/launch.json`.
   ```bash
   node ~/.claude/skills/relay/relay.mjs add
   ```
   It prints JSON: `entry`, `inserted`, `relayPort`, `appConfig`, `appPort`, `notes`. Read `notes`
   and act on them only if they say something needs doing.

2. **Start both servers in one message**, as two parallel `preview_start` calls:
   `{name: "relay"}` and `{name: <appConfig>}`. The app tab is the one to check.

3. **Check once** on the app tab:
   `javascript_tool: !!document.getElementById("__relay-toolbar")`.
   - `true`: done.
   - `false`: reload that tab once and check again. If it's still false, read the console. A
     `localhost:<relayPort>` connection error means relay isn't running. A CSP error means the
     app's Content-Security-Policy needs `http://localhost:<relayPort>` in `script-src` and
     `connect-src` for development.
   - If the app didn't start (wrong guessed config), fix that entry in `.claude/launch.json` and
     retry.

4. **Reply in one line**: the toolbar is on the page (**Snap** or **⌥⇧S**), the canvas is in the
   relay tab at `localhost:<relayPort>` (or open it any time from `<project>.relay/canvas.html`), and you can snap for them.

Never start relay from the home folder, Desktop, Documents or Downloads. It refuses anyway; ask
which project folder to use instead.

## Snap (Claude takes the snapshot)

On the app tab, set the state the user describes (click, type, scroll) with the browser tools, then:
```js
document.querySelector("#__relay-toolbar").shadowRoot.querySelector("input").value = "<label>";
await window.relay.snap();
```
If relay isn't on the page, run **Add** first.

## Remove

Use the `relay-off` skill (`/relay-off`): `node ~/.claude/skills/relay/relay.mjs off`, then
`preview_stop` the relay server, then reply in one line.

## Notes

- Never delete snapshots or edit `canvas.json` unless the user asks. Snapshots you took for testing
  are the only exception, and you identify them by ID from your own `snap` results, never by
  clearing a folder or deleting every snapshot. Deleting is permanent.
- Snapshots are frozen HTML of the full page, with styles and same-origin assets inlined and scripts
  removed. Hover states and stylesheets that can't be read cross-origin aren't captured.
- The data files are `<project>.relay/canvas.json` (layout and annotations) and
  `<project>.relay/snaps/<id>.{html,json}`. Read them if the user asks what's on the canvas. An
  annotation point attached to an element looks like `{snap, path, dx, dy, label}`:
  - `label` is a readable tag such as `button#clear`.
  - `path` has one list of child indices per document. Start at `documentElement` of
    `<project>.relay/snaps/<snap>.html` and walk down `children`; each extra list continues inside a
    frozen iframe's `srcdoc`.
  Use this to tell which element in the user's source code a note is about.
