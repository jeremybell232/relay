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

## Claude Code skill

`skill/SKILL.md` adds `/relay` to Claude Code. With it, Claude starts relay in the desktop app's
browser pane, adds a dev-only toolbar tag to your page, takes snapshots for you
(`/relay snap <label>`), and removes everything again with `/relay off`. Install it by symlinking it,
so it stays in sync with this repo:

```
ln -s "$PWD/skill" ~/.claude/skills/relay
```

The skill's file edits are done by `skill/relay.mjs` in a single run (about 60ms), so `/relay` only
has to start the servers. `off` hides the toolbar on open pages immediately. If the current folder
isn't the one relay was added to, it asks the running relay server which project it belongs to and
cleans up there. You can run it yourself too:

```
node ~/.claude/skills/relay/relay.mjs add    # insert the dev-only toolbar + launch configs
node ~/.claude/skills/relay/relay.mjs off    # remove them again; works from any folder
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
| **V** | select and move snapshots and annotations |
| **N** | annotate the element you click; Enter saves, Shift+Enter adds a line (double-click to edit) |
| **A** | arrow; each end attaches to the element it starts or ends on |
| **R** | click to outline an element, or drag to draw a box tied to the element under the drag start |
| **F** | fit everything, or the selected snapshot |
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

With the Annotate, Arrow or Box tool, hovering outlines the element and shows its tag
(`button#clear`, `li.item`). Arrow ends and boxes attach to elements the same way. Anything drawn on
empty canvas stays free. Deleting a snapshot deletes the annotations attached to it.

The canvas background defaults to `#F5F5F5`. Change it with the swatch in the toolbar, and
double-click the swatch to reset it. Annotation cards are white on light backgrounds and switch to a
dark version on dark ones.

Each card shows the whole page at full height, including everything you'd have to scroll to.
Scroll boxes inside the page, such as a long list, keep the scroll position they had. Double-click a
card to scroll them.

New snapshots appear immediately. Snapshots of the same URL go in the same row; a new URL starts a
new row.

## Files

Relay saves into a folder named after the project it runs in, in that project's root, so
`~/code/checklists` gets `~/code/checklists/checklists.relay/`. Older `.relay/` folders are moved
over automatically.

```
<project>.relay/.gitignore        "*": the folder ignores itself, and no tracked file is touched
<project>.relay/canvas.json       background, camera, card positions, annotations (with their element anchors)
<project>.relay/snaps/<id>.html   frozen page
<project>.relay/snaps/<id>.json   url, title, label, viewport, scroll position, time
```

Options: `relay --port 4401 --dir ../other-project`.
