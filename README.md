# relay

Snapshot states of the page you're building on localhost, then lay them out and annotate them on an
infinite canvas. No dependencies, no build step, nothing committed.

```
npm link                      # once, from this folder: puts `relay` on your PATH
cd ~/my-project && relay      # → http://localhost:4400, saves to ./<project>.relay/
```

Add this to the page while developing:

```html
<script src="http://localhost:4400/relay.js" defer></script>
```

A small toolbar appears in the bottom-right corner. Type an optional label, click **Snap** (or press
**⌥⇧S**), then open **Canvas ↗**. If relay isn't running, the script tag fails quietly.

## Try it on the demo app

```
npm run demo                  # checklist app → http://localhost:5180, relay → http://localhost:4400
```

`example/` is a small checklist app with several lists, filters, a detail drawer and empty states, so
there are plenty of states to snapshot. Its snapshots are saved to `example/example.relay/`. Use
**Reset demo data** in the app's sidebar to start over.

## Claude Code

relay comes as a Claude Code plugin with two commands, **`/relay:relay-on`** and **`/relay:relay-off`**. You need Node
18 or newer.

1. **Add relay's marketplace.** In Claude Code, run `/plugin marketplace add jeremybell232/relay`. In the
   Claude app, go to **Settings → Plugins** and add `jeremybell232/relay` as a source.
2. **Install it.** Run `/plugin install relay@relay`, or click **Install** on Relay in the app.
3. **Turn on automatic updates.** Every push to this repo is a new version, and this step means you
   get them without doing anything. It's off by default for plugins from outside Anthropic, and only
   you or your organization admin can turn it on.
   - **Claude app:** open relay's source settings and turn on **Sync automatically**. For an
     organization, this is in **Organization settings → Plugins & skills**.
   - **Claude Code:** `/plugin` → **Marketplaces** → **relay** → **Enable auto-update**. When it says
     the plugin was updated, run `/reload-plugins` or start a new session.

If you skip step 3, `/relay:relay-on` tells you when a newer version is out (it checks GitHub at most once a
day). Update with **Settings → Plugins → Relay → Update**, or `/plugin` → **Installed** → **relay** →
**Update now**.

- `/relay:relay-on` puts the toolbar on your project's pages, starts relay, and replies in a line.
- Ask Claude to "snap" a state and it takes the snapshot for you.
- `/relay:relay-off` removes everything again.

**Working on relay itself?** Link the skills instead, so edits apply straight away. You also get the
shorter `/relay` and `/relay-off`:

```
ln -s "$PWD/skills/relay-on" ~/.claude/skills/relay
ln -s "$PWD/skills/relay-off" ~/.claude/skills/relay-off
```

`/relay:relay-on` puts the toolbar on every page of the project with as few edits as possible:

| Project | Where the toolbar goes |
|---|---|
| Next.js | `app/layout` (app router) or `pages/_document` (pages router) |
| Astro | every layout/page in `src/` that renders `<body>` |
| SvelteKit | `src/app.html` |
| Remix / React Router | `app/root` |
| Vite, CRA and other single-page apps | `index.html` |
| Plain HTML sites | every page with a `</body>`, in all folders |

Pages are found with git's file list, so ignored folders are skipped, as are `node_modules`,
build output and HTML fragments. Every insertion is dev-only and wrapped in `relay:start`/`relay:end`
markers. Running `/relay:relay-on` again picks up new pages, and `/relay:relay-off` removes every insertion,
leaving the files exactly as they were. Nuxt has no shared HTML file, so it needs the script added to
`nuxt.config` by hand.

All of this is done by `skills/relay-on/relay.mjs` in one run of about 0.25 seconds, including starting
relay in the background, so `/relay:relay-on` is a single command and a one-line reply. `/relay:relay-off` stops
that background relay again. `off` hides the toolbar on open pages immediately and only touches the
relay that belongs to the current session, so other projects' relays and the demo keep running. You can run it yourself too:

```
node skills/relay-on/relay.mjs add    # insert the dev-only toolbar, start relay
node skills/relay-on/relay.mjs off    # remove it again (just this session's relay)
```

## What a snapshot is

A frozen copy of the page's HTML, not a screenshot:

- live form values, checkboxes, selects, `<canvas>` pixels, open shadow roots and the scroll position
  of scroll boxes inside the page are kept
- window-height units (`vh`, `dvh`, `vmin`, …) are frozen to the pixel sizes they had, so a
  "full-screen" section keeps its height on the full-length card
- every stylesheet is read from the CSSOM (so CSS-in-JS rules are included), and `@import` and
  relative `url()`s are resolved
- same-origin images, background images and fonts are stored inline as data URIs, so a snapshot still
  renders after the dev server stops
- scripts and `on*` handlers are removed, and the server also serves snapshots with `script-src 'none'`

Not captured: `:hover`/`:focus` states, iframe contents (shown as a placeholder), and stylesheets
that can't be read cross-origin (these stay linked, which is how Google Fonts keeps working).

## Canvas

| | |
|---|---|
| Scroll / drag empty space / hold space | pan |
| ⌘-scroll / pinch | zoom |
| **V** | move snapshots and annotations |
| **Y** | annotate the element you click (only elements inside a snapshot); Enter saves, Shift+Enter adds a line (double-click to edit) |
| double-click a snapshot | scroll inside the frozen page (Esc to leave) |
| ⌫, or right-click → Delete | delete an annotation; ⌫ on a snapshot asks first and can't be undone |
| ⌘Z / ⇧⌘Z | undo / redo |

Annotations work like Figma's. Each one is a card in a column just outside the snapshot, on the side
of the frame its element is closer to, joined to it by a thin dashed grey line. The line ends in a small dot on the
element's edge facing the card. Lines are straight whenever the card can sit level with its element.
When there isn't room, the line turns 90° in the gap beside the snapshot, with rounded corners.
Hovering a card outlines its element in thin blue. Cards scale with the canvas up to 80% zoom, then
hold their size on screen so they never get oversized.
- Cards are placed automatically; they aren't dragged. In each column they sort top to bottom by
  their element and never overlap. The layout redoes itself as you type, move the snapshot, or
  scroll inside it.
- Drag the dot onto another element to re-attach it.
- Right-click an annotation (card, arrow or box) and choose **Delete**, or select it and press ⌫. ⌘Z brings it back.

With the Annotate tool, hovering outlines the element and shows its tag (`button#clear`, `li.item`). Deleting a snapshot deletes the annotations attached to it.

The canvas has a light mode (`#F5F5F5`) and a dark mode (`#313131`). Switch with the sun/moon button
in the toolbar. The choice is saved with the canvas, and until you pick one it follows your system
setting. Annotation cards and the canvas controls switch with it.

Each card shows the whole page at full height, including everything you'd have to scroll to.
Scroll boxes inside the page, such as a long list, keep the scroll position they had. Double-click a
card to scroll them.

New snapshots appear immediately. Snapshots of the same URL go in the same row; a new URL starts a
new row.

## Files

Relay saves into a folder named after the project it runs in, in that project's root, so
`~/code/checklists` gets `~/code/checklists/checklists.relay/`. Older `.relay/` folders are moved
over automatically.
- **Opening the canvas:** open **`canvas.html`** in that folder.
  - If relay is running for the project, it switches to the live, editable canvas.
  - If it isn't, the file still shows every snapshot and annotation, view only, with the command to
    start relay.
  - Relay rewrites the file whenever the canvas changes, and it's self-contained, so you can send it
    to someone.
- **Not outside a project:** relay won't run from your home folder, Desktop, Documents or Downloads,
  so it never leaves a canvas folder there.
- **Port:** each project keeps its own. `relay` uses the port in the project's toolbar snippet, and
  `/relay:relay-on` picks the first free one.

```
<project>.relay/canvas.html       open this: live canvas if relay is running, otherwise view only
<project>.relay/.gitignore        "*": the folder ignores itself, and no tracked file is touched
<project>.relay/canvas.json       theme, camera, card positions, annotations (with their element anchors)
<project>.relay/snaps/<id>.html   frozen page
<project>.relay/snaps/<id>.json   url, title, label, viewport, scroll position, time
```

Options: `relay --port 4401 --dir ../other-project --open`.
