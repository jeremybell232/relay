# relay

Snapshot states of the page you're building on localhost, then lay them out and annotate them on an
infinite canvas. No dependencies, no build step, nothing committed.

```
npm link                      # once, from this folder: puts `relay` on your PATH
cd ~/my-project && relay      # → http://localhost:4400, saves to ./.relay/
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
there are plenty of states to snapshot. Its snapshots are saved to `example/.relay/`. Use
**Reset demo data** in the app's sidebar to start over.

## Claude Code skill

`skill/SKILL.md` adds `/relay` to Claude Code. With it, Claude starts relay in the desktop app's
browser pane, adds a dev-only toolbar tag to your page, takes snapshots for you
(`/relay snap <label>`), and removes everything again with `/relay off`. Install it by symlinking it,
so it stays in sync with this repo:

```
ln -s "$PWD/skill" ~/.claude/skills/relay
```

## What a snapshot is

A frozen copy of the page's HTML, not a screenshot:

- live form values, checkboxes, selects, `<canvas>` pixels and open shadow roots are kept
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
| **V** | select and move snapshots and annotations |
| **N** | annotate the element you click (double-click an annotation to edit it) |
| **A** | arrow; each end attaches to the element it starts or ends on |
| **R** | click to outline an element, or drag to draw a box tied to the element under the drag start |
| **F** | fit everything, or the selected snapshot |
| double-click a snapshot | scroll inside the frozen page (Esc to leave) |
| ⌫ | delete the selection (deleting a snapshot asks first and can't be undone) |
| ⌘Z / ⇧⌘Z | undo / redo |

Annotations work like Figma's. Each one is a card in a column just outside the snapshot, on the side
nearer its element, joined to the element by a dotted line and a dot.
- Cards in a column sort top to bottom by their element and never overlap. The layout redoes itself
  as you type, move the snapshot, or scroll inside it.
- Drag a card across the snapshot to move it to the other side.
- Drag the dot onto another element to re-attach it.
- Use the ✕ on a card to delete it.

With the Annotate, Arrow or Box tool, hovering outlines the element and shows its tag
(`button#clear`, `li.item`). Arrow ends and boxes attach to elements the same way. Anything drawn on
empty canvas stays free. Deleting a snapshot deletes the annotations attached to it.

New snapshots appear immediately. Snapshots of the same URL go in the same row; a new URL starts a
new row.

## Files

```
.relay/.gitignore        "*": the folder ignores itself, and no tracked file is touched
.relay/canvas.json       camera, card positions, annotations (with their element anchors)
.relay/snaps/<id>.html   frozen page
.relay/snaps/<id>.json   url, title, label, viewport, scroll position, time
```

Options: `relay --port 4401 --dir ../other-project`.
