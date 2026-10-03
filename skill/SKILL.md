---
name: relay
description: "Add the relay snapshot toolbar to the current project's local page and open the relay canvas in the browser pane. Use when the user types /relay or /relay off, or asks to add or remove relay, snapshot or 'snap' the current page state, or open the relay canvas."
---

# relay

Relay is a zero-dependency local server. It serves a toolbar script that
freezes the page's HTML into `./.relay/snaps/`, and hosts an annotatable canvas at
`http://localhost:4400`. `.relay/` ignores itself with its own `.gitignore`, so don't edit the
project's `.gitignore`.

The argument decides the mode: none or `on` → **Add**, `off` → **Remove**, `snap [label]` → **Snap**.

## Add

1. **Find relay.** This skill is installed as a symlink into the relay repo, so the repo is one level
   above the skill folder:
   ```bash
   cd "$(dirname "$(readlink -f ~/.claude/skills/relay/SKILL.md)")/.." && pwd
   ```
   Call that absolute path `<RELAY>`. If `<RELAY>/bin/relay.js` is missing, stop and tell the user.

2. **Add a launch config.** Merge this into the project's `.claude/launch.json`, creating the file if
   needed. Never overwrite other configurations. If 4400 is already used by another config, use 4401
   in both places, and in the tag in step 3.
   ```json
   {
     "name": "relay",
     "runtimeExecutable": "node",
     "runtimeArgs": ["<RELAY>/bin/relay.js", "--port", "4400"],
     "port": 4400
   }
   ```
   Relay writes `.relay/` into the directory it starts in. That is the project root, which is correct.

3. **Add the toolbar so it only loads in development.** Find the page's entry point. If there are
   several and it's unclear which one the user means, ask. Always wrap the addition in `relay`
   markers so Remove can find it, and never add a tag that would load in production. Use the first
   pattern that fits:

   - **Next.js App Router** (`app/layout.tsx`): import `Script` from `next/script` and put this
     inside `<body>`:
     ```tsx
     {/* relay:start */}
     {process.env.NODE_ENV === "development" && (
       <Script src="http://localhost:4400/relay.js" strategy="afterInteractive" />
     )}
     {/* relay:end */}
     ```
   - **Next.js Pages Router:** the same block in `pages/_app.tsx` (or `_document.tsx`).
   - **Everything else** (plain HTML, Vite `index.html`, static sites, Babel-in-browser shells):
     put this just before `</body>`. Because of the hostname check it does nothing once deployed.
     ```html
     <!-- relay:start -->
     <script>
       if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
         var s = document.createElement("script");
         s.src = "http://localhost:4400/relay.js";
         document.body.appendChild(s);
       }
     </script>
     <!-- relay:end -->
     ```
   If a `relay:start` marker is already there, skip this step.

4. **Start the servers.** Run `preview_start` with `{name: "relay"}`, which opens the canvas tab.
   Then make sure the app itself is running:
   - if `launch.json` has the app's own dev-server config, `preview_start` it;
   - otherwise ask which URL the page is served on and open it with `preview_start {url}`.

5. **Verify.** On the app tab, run
   `javascript_tool: !!document.getElementById("__relay-toolbar")`.
   If it returns `false`, reload once and check again.
   - If it is still `false`, read the console. A `localhost:4400` connection error means relay isn't
     running.
   - A CSP error means the app's Content-Security-Policy needs `http://localhost:4400` in
     `script-src` and `connect-src` for development.

6. **Tell the user** in two or three lines: click **Snap** or press **⌥⇧S** on the page (adding a
   label is optional), snapshots appear in the relay canvas tab, and they can ask you to "snap" for
   them.

## Snap (Claude takes the snapshot)

On the app tab, set the state the user describes (click, type, scroll) using the browser tools, then
run:
```js
document.querySelector("#__relay-toolbar").shadowRoot.querySelector("input").value = "<label>";
await window.relay.snap();
```
Confirm a new file appeared in `.relay/snaps/`, or check the canvas tab. If relay isn't on the page,
run **Add** first.

## Remove (`/relay off`)

1. Delete the block between `relay:start` and `relay:end`, including the markers, and the
   `next/script` import if relay was its only user.
2. Remove the `relay` entry from `.claude/launch.json`. If that leaves the file with an empty
   `configurations` list, delete the file.
3. `preview_stop` the relay server if it's running.
4. Leave `.relay/` alone, since that's the user's canvas, and tell the user it's still there.

## Notes

- Never delete snapshots or edit `canvas.json` unless the user asks. Snapshots you took for testing
  are the only exception, and you identify them by ID from your own `snap` results, never by
  clearing a folder or deleting every snapshot. Deleting is permanent.

- Snapshots are frozen HTML with styles and same-origin assets inlined and scripts removed. Hover
  states, iframe contents and stylesheets that can't be read cross-origin aren't captured.
- The data files are `.relay/canvas.json` (layout and annotations) and `.relay/snaps/<id>.{html,json}`.
  Read them if the user asks what's on the canvas. An annotation point attached to an element looks
  like `{snap, path, dx, dy, label}`:
  - `label` is a readable tag such as `button#clear`.
  - `path` has one list of child indices per document. Start at `documentElement` of
    `.relay/snaps/<snap>.html` and walk down `children`; each extra list continues inside a frozen
    iframe's `srcdoc`.
  Use this to tell which element in the user's source code a note is about.
