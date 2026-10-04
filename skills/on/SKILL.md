---
description: "Add the relay snapshot toolbar to the current project's local page and open the relay canvas in the browser pane. Use when the user types /relay:on (or /relay), or asks to add relay, snapshot or 'snap' the current page state, or open the relay canvas. To turn relay off, use the off skill (/relay:off or /relay-off)."
---

# relay: on

Relay is a zero-dependency local server. Its toolbar freezes the page's HTML into
`<project>.relay/snaps/`, and it hosts an annotatable canvas at `http://localhost:4400`. The folder
ignores itself, so don't edit the project's `.gitignore`.

The argument decides the mode: none or `on` → **Add**, `snap [label]` → **Snap**. `off` → do what
the off skill does.

## Add (default)

**One tool call, then a one-line reply.** Don't read files, explore, verify, open tabs or ask
questions unless the output's `notes` call for it.

```bash
node "<base directory>/relay.mjs" add
```
`<base directory>` is this skill's folder, shown as "Base directory for this skill" when it loads. That
path works however relay is installed: as a plugin or linked into `~/.claude/skills`.
(Add `--dir <project>` if this session isn't opened in the project.) In about a tenth of a second it:
- adds the dev-only toolbar to every page, through the framework's shared layout where there is one
  (Next.js, Astro, SvelteKit, Remix/React Router) and every real HTML page otherwise. It skips
  pages that already have it, so re-running picks up new pages;
- starts relay in the background (or reuses the one already running) and waits until it answers;
- writes the `relay` launch config and reports whether the app's dev server is up.

It prints JSON: `files`, `inserted`, `relay`, `canvas`, `appConfig`, `appRunning`, `update`, `notes`.

- If `appRunning` is false and there's an `appConfig`, `preview_start {name: appConfig}`. That's the
  only other call.
- Reply in one line, for example: "Relay is on for 3 pages: reload the page to see the toolbar
  (**Snap** or **⌥⇧S**). Canvas: localhost:4401, or `<project>.relay/canvas.html`."
- Pass on `notes` only if they ask for something.
- If `update.available` is true, add one more line: "A relay update is available:" followed by
  `update.how`.

## Snap (Claude takes the snapshot)

On the app tab, set the state the user describes (click, type, scroll) with the browser tools, then:
```js
document.querySelector("#__relay-toolbar").shadowRoot.querySelector("input").value = "<label>";
await window.relay.snap();
```
If relay isn't on the page, run **Add** first.

## Remove

That's the off skill (`/relay:off`, or `/relay-off`): `node "<base directory>/relay.mjs" off`, then a one-line reply.

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
