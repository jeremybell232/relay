import { screenToWorld, panBy, zoomAt, worldTransform, zoomToBox, normalizeWheel, zoomFactor } from "/camera.js";

// ------------------------------------------------------------------ state
//
// The server writes snapshots; only this page writes canvas.json. A snapshot
// with no saved position gets auto-placed, so nothing posted while the canvas
// is closed (or mid-save) can be lost.

const HEADER = 44;
const GAP_X = 720; // room for annotation gutters on both sides of neighbouring cards
const GAP_Y = 200;
const STROKE = 6;

const $ = (s) => document.querySelector(s);
const viewport = $("#viewport");
const world = $("#world");
const cardsEl = $("#cards");
const notesEl = $("#notes");
const shapesEl = $("#shapes");
const handlesEl = $("#handles");
const draftEl = $("#draft");
const hoverEl = $("#hover");

const snaps = new Map(); // id -> meta from the server
let doc = { version: 1, camera: null, layout: {}, annotations: [] };
let camera = { x: 80, y: 120, z: 0.5 };
let tool = "select";
let selection = null; // { kind: "snap" | "ann", id }
let liveCard = null; // id of the card you can currently scroll inside
let editingNote = null;
let loaded = false;

const uid = () => Math.random().toString(36).slice(2, 10);
const ann = (id) => doc.annotations.find((a) => a.id === id);
const sizeOf = (meta) => ({ w: meta.viewport?.w || 1280, h: (meta.viewport?.h || 800) + HEADER });
const pathOf = (meta) => {
  try {
    const u = new URL(meta.url);
    return u.host + u.pathname;
  } catch {
    return meta.url;
  }
};

// ------------------------------------------------------------------ persistence

let saveTimer;
function save() {
  if (!loaded) return; // never let an empty doc overwrite a real one before load succeeds
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    doc.camera = camera;
    fetch("/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc, null, 1) });
  }, 500);
}

const past = [];
const future = [];
const snapshotState = () => JSON.stringify({ layout: doc.layout, annotations: doc.annotations });

// Call before a change, with the state from before it.
function pushHistory(before = snapshotState()) {
  past.push(before);
  if (past.length > 50) past.shift();
  future.length = 0;
}
function restore(state) {
  const s = JSON.parse(state);
  doc.layout = s.layout;
  doc.annotations = s.annotations;
  selection = null;
  render();
  save();
}
function undo() {
  if (!past.length) return;
  future.push(snapshotState());
  restore(past.pop());
}
function redo() {
  if (!future.length) return;
  past.push(snapshotState());
  restore(future.pop());
}

// ------------------------------------------------------------------ layout

function place(meta) {
  if (doc.layout[meta.id]) return;
  const path = pathOf(meta);
  const placed = [...snaps.values()].filter((m) => m.id !== meta.id && doc.layout[m.id]);
  const row = placed.filter((m) => pathOf(m) === path);
  if (row.length) {
    // Continue the row for this URL, to the right of its rightmost card.
    const last = row.reduce((a, b) => (doc.layout[a.id].x + sizeOf(a).w > doc.layout[b.id].x + sizeOf(b).w ? a : b));
    const at = doc.layout[last.id];
    doc.layout[meta.id] = { x: at.x + sizeOf(last).w + GAP_X, y: at.y };
  } else {
    // New URL, new row underneath everything.
    const b = bounds();
    const bottom = b ? b.y + b.h : -GAP_Y;
    doc.layout[meta.id] = { x: 0, y: bottom + GAP_Y };
  }
}

function bounds() {
  const boxes = [];
  for (const m of snaps.values()) {
    const at = doc.layout[m.id];
    if (at) boxes.push({ x: at.x, y: at.y, ...sizeOf(m) });
  }
  for (const a of doc.annotations) {
    if (a.type === "note") {
      const p = notePos.get(a.id);
      if (p) boxes.push({ x: p.x, y: p.y, w: NOTE_W, h: p.h });
    }
    if (a.type === "box") boxes.push({ ...resolve(a.at), w: a.w, h: a.h });
    if (a.type === "arrow") {
      const p1 = resolve(a.from);
      const p2 = resolve(a.to);
      boxes.push({ x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) });
    }
  }
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x || 1,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y || 1,
  };
}

function fit(box = bounds()) {
  if (!box) return;
  camera = zoomToBox(box, { width: innerWidth, height: innerHeight }, 80);
  applyCamera();
}

// ------------------------------------------------------------------ rendering

function applyCamera() {
  world.style.transform = worldTransform(camera);
  world.style.setProperty("--z", camera.z);
  $("#zoom").textContent = `${Math.round(camera.z * 100)}%`;
  save();
}

const timeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function cardFor(meta) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.kind = "snap";
  el.dataset.id = meta.id;
  const { w } = sizeOf(meta);
  const vh = meta.viewport?.h || 800;
  el.style.width = `${w}px`;
  el.innerHTML = `
    <header>
      <span class="label"></span><span class="path"></span><span class="time"></span>
      <a href="/snaps/${meta.id}.html" target="_blank" title="Open the frozen page in a tab">Open</a>
      <button data-action="delete" title="Delete snapshot">Delete</button>
    </header>
    <div class="frame" style="height:${vh}px">
      <iframe sandbox="allow-same-origin" loading="lazy" scrolling="no" width="${w}" height="${vh}"></iframe>
      <div class="shield"></div>
    </div>`;
  el.querySelector(".label").textContent = meta.label || meta.title || "Untitled";
  el.querySelector(".path").textContent = pathOf(meta);
  el.querySelector(".time").textContent = timeFmt.format(new Date(meta.createdAt));
  const frame = el.querySelector("iframe");
  // allow-same-origin without allow-scripts: nothing in the page runs, but we can
  // still scroll it to where it was when it was captured.
  frame.addEventListener("load", () => {
    try {
      frame.contentWindow.scrollTo({ left: meta.scroll?.x || 0, top: meta.scroll?.y || 0, behavior: "instant" });
      restoreFrameScroll(frame.contentDocument);
    } catch {}
    renderInk(); // anchored annotations can now find their elements
  });
  frame.src = `/snaps/${meta.id}.html`;
  return el;
}

// Same-origin iframes inside a snapshot were frozen too; put them back where they were scrolled.
function restoreFrameScroll(d) {
  for (const f of d.querySelectorAll("iframe[data-relay-scroll]")) {
    const [x, y] = f.dataset.relayScroll.split(",").map(Number);
    const go = () => {
      try {
        f.contentWindow.scrollTo({ left: x, top: y, behavior: "instant" });
        restoreFrameScroll(f.contentDocument);
      } catch {}
      renderInk();
    };
    if (f.contentDocument?.readyState === "complete" && f.contentDocument.URL !== "about:blank") go();
    else f.addEventListener("load", go, { once: true });
  }
}

function renderCards() {
  const seen = new Set();
  for (const meta of snaps.values()) {
    const at = doc.layout[meta.id];
    if (!at) continue;
    seen.add(meta.id);
    let el = cardsEl.querySelector(`[data-id="${meta.id}"]`);
    if (!el) cardsEl.appendChild((el = cardFor(meta)));
    el.style.transform = `translate(${at.x}px, ${at.y}px)`;
    el.classList.toggle("selected", selection?.kind === "snap" && selection.id === meta.id);
    el.classList.toggle("live", liveCard === meta.id);
  }
  for (const el of [...cardsEl.children]) if (!seen.has(el.dataset.id)) el.remove();
  $("#empty").hidden = snaps.size > 0;
}

const svg = (tag, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// ------------------------------------------------------------------ anchors
//
// An annotation point is either free ({x, y} in world space) or anchored to an
// element inside a snapshot, like a Figma comment pinned to a node:
//   { snap, path, dx, dy, label, rel }
// `path` has one child-index list per document, descending through frozen
// iframes. `dx/dy` is the offset from the element's top-left corner. `rel` caches
// the last resolved point relative to the card, for cards whose frame hasn't
// loaded yet. Frozen pages never change, so the path stays valid forever.

const INSET = { x: 1, y: HEADER + 1 }; // card border + header: where the frozen page starts

function frameDoc(frame) {
  try {
    const d = frame?.contentDocument;
    return d && d.readyState === "complete" && d.URL !== "about:blank" ? d : null;
  } catch {
    return null;
  }
}
const cardDoc = (id) => frameDoc(cardsEl.querySelector(`.card[data-id="${id}"] iframe`));
const childPath = (el) => {
  const path = [];
  for (; el.parentElement; el = el.parentElement) path.unshift([...el.parentElement.children].indexOf(el));
  return path;
};
const walk = (d, path) => path.reduce((el, i) => el?.children[i], d.documentElement);
const describe = (el) => el.localName + (el.id ? `#${el.id}` : el.classList?.[0] ? `.${el.classList[0]}` : "");

// The element under a world point, descending into frozen iframes.
function elementAt(w) {
  for (const card of [...cardsEl.children].reverse()) {
    const id = card.dataset.id;
    const at = doc.layout[id];
    const m = snaps.get(id);
    if (!at || !m) continue;
    let x = w.x - at.x - INSET.x;
    let y = w.y - at.y - INSET.y;
    if (x < 0 || y < 0 || x > sizeOf(m).w || y > sizeOf(m).h - HEADER) continue;
    let d = cardDoc(id);
    if (!d) return null;
    const path = [];
    for (;;) {
      const el = d.elementFromPoint(x, y) || d.documentElement;
      path.push(childPath(el));
      const inner = el.localName === "iframe" && frameDoc(el);
      if (!inner) return { snap: id, path, el };
      const r = el.getBoundingClientRect();
      x -= r.left + el.clientLeft;
      y -= r.top + el.clientTop;
      d = inner;
    }
  }
  return null;
}

// World-space box of an anchored element, or null while its card's frame isn't loaded.
function locate(snap, path) {
  const at = doc.layout[snap];
  let d = cardDoc(snap);
  if (!at || !d) return null;
  let ox = at.x + INSET.x;
  let oy = at.y + INSET.y;
  for (let i = 0; i < path.length; i++) {
    const el = walk(d, path[i]);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (i === path.length - 1) return { x: ox + r.left, y: oy + r.top, w: r.width, h: r.height, el };
    ox += r.left + el.clientLeft;
    oy += r.top + el.clientTop;
    d = frameDoc(el);
    if (!d) return null;
  }
  return null;
}

// Anchor a world point to whatever element is under it, or leave it free.
function anchorAt(w) {
  const hit = elementAt(w);
  const b = hit && locate(hit.snap, hit.path);
  if (!b) return { x: w.x, y: w.y };
  const at = doc.layout[hit.snap];
  return { snap: hit.snap, path: hit.path, dx: w.x - b.x, dy: w.y - b.y, label: describe(hit.el), rel: { x: w.x - at.x, y: w.y - at.y } };
}

function resolve(p) {
  if (!p.snap) return { x: p.x, y: p.y };
  const at = doc.layout[p.snap];
  if (!at) return { x: 0, y: 0 };
  const b = locate(p.snap, p.path);
  if (b) p.rel = { x: b.x + p.dx - at.x, y: b.y + p.dy - at.y };
  return p.rel ? { x: at.x + p.rel.x, y: at.y + p.rel.y } : { x: at.x, y: at.y };
}

function movePoint(p, dx, dy) {
  if (!p.snap) {
    p.x += dx;
    p.y += dy;
    return;
  }
  p.dx += dx;
  p.dy += dy;
  if (p.rel) p.rel = { x: p.rel.x + dx, y: p.rel.y + dy };
}

const pointsOf = (a) => (a.type === "arrow" ? [a.from, a.to] : [a.at]);
const snapsOf = (a) => pointsOf(a).map((p) => p.snap).filter(Boolean);

// Older canvases stored plain coordinates; lift them into free points.
function migrate(a) {
  if (a.type === "note" && !a.at) return { id: a.id, type: "note", at: { x: a.x, y: a.y }, text: a.text || "" };
  if (a.type === "arrow" && !a.from) return { id: a.id, type: "arrow", from: { x: a.x1, y: a.y1 }, to: { x: a.x2, y: a.y2 } };
  if (a.type === "box" && !a.at) return { id: a.id, type: "box", at: { x: a.x, y: a.y }, w: a.w, h: a.h };
  return a;
}

// ------------------------------------------------------------------ ink

// Annotation cards, laid out like Figma's: in a gutter just outside the snapshot,
// on the side nearest the element, sorted top to bottom and never overlapping,
// each joined to its element by a dotted line.
const NOTE_W = 280;
const GUTTER = 48; // between the snapshot frame and its annotation column
const NOTE_GAP = 12; // between stacked annotations
const LINE_Y = 28; // where the connector meets the card: the first line of text
let notePos = new Map(); // id -> { x, y, h, side }

function layoutNotes(notes) {
  const pos = new Map();
  const columns = new Map(); // "snap|side" -> [{ a, pin, h }]
  for (const a of notes) {
    const el = notesEl.querySelector(`[data-id="${a.id}"]`);
    const h = el?.offsetHeight || 64;
    const at = a.at.snap && doc.layout[a.at.snap];
    const meta = a.at.snap && snaps.get(a.at.snap);
    if (!at || !meta) {
      // A free annotation stays where it was put.
      pos.set(a.id, { x: a.at.x, y: a.at.y, h, side: null });
      continue;
    }
    // The dot sits on the element's edge facing the annotation, at its vertical centre.
    const b = locate(a.at.snap, a.at.path);
    const anchor = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : resolve(a.at);
    // Whichever side of the frame the element is closer to.
    const side = b
      ? b.x - at.x <= at.x + sizeOf(meta).w - (b.x + b.w) ? "left" : "right"
      : anchor.x < at.x + sizeOf(meta).w / 2 ? "left" : "right";
    const pin = b ? { x: side === "left" ? b.x : b.x + b.w, y: anchor.y } : anchor;
    const key = `${a.at.snap}|${side}`;
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push({ a, pin, h, at, meta, side });
  }
  for (const column of columns.values()) {
    // Every card wants to sit level with its element so its connector is straight.
    // Cards that would overlap merge into a block centred on what its members want,
    // which keeps as many connectors straight as the space allows.
    column.sort((p, q) => p.pin.y - q.pin.y || p.pin.x - q.pin.x);
    const blocks = [];
    for (const item of column) {
      item.want = item.pin.y - LINE_Y;
      blocks.push({ items: [item], top: item.want, height: item.h });
      while (blocks.length > 1) {
        const prev = blocks[blocks.length - 2];
        const cur = blocks[blocks.length - 1];
        if (prev.top + prev.height + NOTE_GAP <= cur.top) break;
        const items = [...prev.items, ...cur.items];
        let offset = 0;
        let sum = 0;
        for (const it of items) {
          sum += it.want - offset;
          offset += it.h + NOTE_GAP;
        }
        blocks.splice(-2, 2, { items, top: sum / items.length, height: offset - NOTE_GAP });
      }
    }
    for (const block of blocks) {
      let y = block.top;
      for (const { a, h, at, meta, side, pin } of block.items) {
        const x = side === "left" ? at.x - GUTTER - NOTE_W : at.x + sizeOf(meta).w + GUTTER;
        pos.set(a.id, { x, y, h, side, pin, frameX: side === "left" ? at.x : at.x + sizeOf(meta).w });
        y += h + NOTE_GAP;
      }
    }
  }
  return pos;
}
let hover = null; // { snap, path } under the cursor while a drawing tool is active
let hoveredNote = null; // annotation card under the pointer: its element gets highlighted

function shapeEls(a, cls = "shape") {
  if (a.type === "arrow") {
    const p1 = resolve(a.from);
    const p2 = resolve(a.to);
    const line = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    const out = [
      svg("line", { ...line, class: cls, "stroke-width": STROKE, "marker-end": "url(#head)" }),
      svg("line", { ...line, class: "hit", "stroke-width": STROKE * 4, "data-kind": "ann", "data-id": a.id }),
    ];
    if (a.from.snap) out.push(svg("circle", { cx: p1.x, cy: p1.y, r: STROKE, class: "tail" }));
    return out;
  }
  const p = resolve(a.at);
  const rect = { x: p.x, y: p.y, width: Math.max(1, a.w), height: Math.max(1, a.h), rx: 6 };
  return [
    svg("rect", { ...rect, class: cls, "stroke-width": STROKE }),
    svg("rect", { ...rect, class: "hit", "stroke-width": STROKE * 4, "data-kind": "ann", "data-id": a.id }),
  ];
}

// Outline an element the way a design tool does, with its tag as a label.
// The thin blue box Figma draws around an annotation's element.
function highlight(target) {
  const b = locate(target.snap, target.path);
  if (!b) return [];
  return [svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h, class: "highlight", "stroke-width": 1.5 / camera.z })];
}

function outline(target, cls) {
  const b = locate(target.snap, target.path);
  if (!b) return [];
  const z = camera.z;
  const label = target.label || describe(b.el);
  const fs = 12 / z;
  const tw = (label.length * 7 + 12) / z;
  return [
    svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h, class: cls, "stroke-width": 1.5 / z }),
    svg("rect", { x: b.x, y: b.y - 20 / z, width: tw, height: 18 / z, rx: 3 / z, class: "tag-bg" }),
    Object.assign(svg("text", { x: b.x + 6 / z, y: b.y - 7 / z, "font-size": fs, class: "tag-text" }), { textContent: label }),
  ];
}

function renderInk() {
  shapesEl.replaceChildren();
  handlesEl.replaceChildren();
  hoverEl.replaceChildren();
  const z = camera.z;
  const r = 7 / z;

  if (hover) hoverEl.append(...outline(hover, "outline"));

  for (const a of doc.annotations) {
    const selected = selection?.kind === "ann" && selection.id === a.id;
    const lit = selected || (a.type === "note" && hoveredNote === a.id);
    if (lit) for (const p of pointsOf(a)) if (p.snap) handlesEl.append(...(a.type === "note" ? highlight(p) : outline(p, "outline anchor")));

    if (a.type === "note") continue; // drawn below, once cards can be measured

    shapesEl.append(...shapeEls(a, selected ? "shape selected-shape" : "shape"));
    if (!selected) continue;
    let points;
    if (a.type === "arrow") {
      const p1 = resolve(a.from);
      const p2 = resolve(a.to);
      points = [["from", p1.x, p1.y], ["to", p2.x, p2.y]];
    } else {
      const p = resolve(a.at);
      points = [["corner", p.x + a.w, p.y + a.h]];
    }
    for (const [handle, cx, cy] of points)
      handlesEl.append(svg("circle", { cx, cy, r, class: "handle", "stroke-width": 2 / z, "data-handle": handle, "data-id": a.id }));
  }

  // Annotation cards: fill them in, measure, lay out, then connect them to their elements.
  const notes = doc.annotations.filter((a) => a.type === "note");
  const seen = new Set();
  for (const a of notes) {
    seen.add(a.id);
    let el = notesEl.querySelector(`[data-id="${a.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "note";
      el.dataset.kind = "ann";
      el.dataset.id = a.id;
      el.innerHTML = `<div class="note-text"></div>`;
      notesEl.appendChild(el);
    }
    const text = el.querySelector(".note-text");
    if (editingNote !== a.id && text.textContent !== a.text) text.textContent = a.text;
    el.classList.toggle("selected", selection?.kind === "ann" && selection.id === a.id);
  }
  for (const el of [...notesEl.children]) if (!seen.has(el.dataset.id)) el.remove();

  notePos = layoutNotes(notes);
  for (const a of notes) {
    const p = notePos.get(a.id);
    const el = notesEl.querySelector(`[data-id="${a.id}"]`);
    const { x, y } = p;
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (!a.at.snap) continue;
    const pin = p.pin || resolve(a.at);
    const edge = pin.x > x + NOTE_W / 2 ? x + NOTE_W : x;
    const selected = selection?.kind === "ann" && selection.id === a.id;
    // Quiet by design: a thin dashed grey line and a small dot. They scale with the canvas
    // but never drop below a hairline on screen.
    const lw = Math.max(1.25, 1 / z);
    // Straight when the card is level with its element; otherwise an elbow whose
    // vertical run sits in the gap between the card and the snapshot.
    const mid = p.frameX == null ? null : (edge + p.frameX) / 2;
    shapesEl.append(
      svg("path", {
        d: connector(edge, y + LINE_Y, mid, pin.x, pin.y, 12),
        class: "leader",
        "stroke-width": lw,
        "stroke-dasharray": `${lw * 4} ${lw * 3}`,
      }),
    );
    handlesEl.append(
      svg("circle", { cx: pin.x, cy: pin.y, r: Math.max(3, 2.5 / z), class: "pin" }),
      // The dot is tiny; this invisible ring is what you grab to re-attach it.
      svg("circle", { cx: pin.x, cy: pin.y, r: 10 / z, class: "pin-hit", "data-handle": "pin", "data-id": a.id }),
    );
  }
}

// A connector from (x1, y1) to (x2, y2): straight if they're level (or there's no
// gutter to turn in), otherwise horizontal → vertical at xm → horizontal, with
// rounded corners.
function connector(x1, y1, xm, x2, y2, radius) {
  const dy = y2 - y1;
  if (xm == null || Math.abs(dy) < 0.5) return `M${x1},${y1} L${x2},${y2}`;
  const sx1 = Math.sign(xm - x1) || 1;
  const sx2 = Math.sign(x2 - xm) || 1;
  const sy = Math.sign(dy);
  const r = Math.min(radius, Math.abs(dy) / 2, Math.abs(xm - x1), Math.abs(x2 - xm));
  return (
    `M${x1},${y1} H${xm - sx1 * r} Q${xm},${y1} ${xm},${y1 + sy * r} ` +
    `V${y2 - sy * r} Q${xm},${y2} ${xm + sx2 * r},${y2} H${x2}`
  );
}

function setHover(target) {
  const same = hover && target && hover.snap === target.snap && JSON.stringify(hover.path) === JSON.stringify(target.path);
  if (same || (!hover && !target)) return;
  hover = target;
  renderInk();
}

function render() {
  renderCards();
  renderInk();
}

function setTool(t) {
  tool = t;
  if (t === "select") setHover(null);
  viewport.dataset.tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
}

function select(sel) {
  selection = sel;
  render();
}

function setLive(id) {
  liveCard = id;
  renderCards();
}

// ------------------------------------------------------------------ notes

function editNote(id) {
  const el = notesEl.querySelector(`[data-id="${id}"] .note-text`);
  if (!el) return;
  const before = snapshotState();
  editingNote = id;
  el.contentEditable = "true";
  el.oninput = () => renderInk(); // the card grows as you type; keep the column tidy
  el.focus();
  getSelection().selectAllChildren(el);
  getSelection().collapseToEnd();
  el.addEventListener(
    "blur",
    () => {
      el.contentEditable = "false";
      editingNote = null;
      const a = ann(id);
      if (!a) return;
      const text = el.innerText.replace(/\n$/, "");
      if (text !== a.text) {
        pushHistory(before);
        a.text = text;
        save();
      }
      if (!a.text.trim()) {
        // An empty annotation is a misclick; drop it without leaving an undo step behind.
        doc.annotations = doc.annotations.filter((x) => x !== a);
        if (selection?.id === id) selection = null;
      }
      render();
    },
    { once: true },
  );
}

// ------------------------------------------------------------------ pointer input

const local = (e) => {
  const r = viewport.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const toWorld = (e) => {
  const p = local(e);
  return screenToWorld(camera, p.x, p.y);
};

let spaceDown = false;
let gesture = null;

viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest("[contenteditable=true]")) return;
  if (e.button === 2) return; // right-click is handled by contextmenu
  if (e.target.closest("header a, header button")) return;
  if (editingNote) document.activeElement.blur();

  const card = e.target.closest(".card");
  if (liveCard && (!card || card.dataset.id !== liveCard)) setLive(null);

  const start = toWorld(e);
  const screen = local(e);
  try {
    viewport.setPointerCapture(e.pointerId);
  } catch {} // synthetic or already-released pointers can't be captured

  // Pan: space-drag, middle button, or dragging empty canvas with the select tool.
  const hit = e.target.closest("[data-id]");
  if (spaceDown || e.button === 1 || (tool === "select" && !hit)) {
    if (tool === "select" && !hit && !spaceDown) select(null);
    gesture = { type: "pan", last: screen };
    viewport.classList.add("panning");
    return;
  }

  if (tool === "note") {
    pushHistory();
    const at = anchorAt(start);
    const a = { id: uid(), type: "note", at, text: "" };
    doc.annotations.push(a);
    setTool("select");
    select({ kind: "ann", id: a.id });
    editNote(a.id);
    e.preventDefault();
    return;
  }

  if (tool === "arrow" || tool === "box") {
    gesture = { type: "draw", shape: tool, start, end: start };
    return;
  }

  // Select tool on something: a resize handle, an annotation, or a card.
  const handle = e.target.closest("[data-handle]");
  if (handle) {
    if (selection?.id !== handle.dataset.id) select({ kind: "ann", id: handle.dataset.id });
    gesture = { type: "handle", id: handle.dataset.id, handle: handle.dataset.handle, before: snapshotState(), moved: false };
    return;
  }
  const kind = hit.dataset.kind;
  const id = hit.dataset.id;
  select({ kind, id });
  // Attached annotation cards are placed by the layout, so they select but don't drag.
  const a = kind === "ann" && ann(id);
  if (a && a.type === "note" && a.at.snap) return;
  gesture = { type: "move", kind, id, last: start, before: snapshotState(), moved: false };
});

viewport.addEventListener("pointermove", (e) => {
  if (!gesture || gesture.type === "draw") {
    // Drawing tools highlight the element an annotation would attach to.
    if (tool !== "select" && !spaceDown) {
      const hit = elementAt(toWorld(e));
      setHover(hit && { snap: hit.snap, path: hit.path, label: describe(hit.el) });
    }
  }
  if (!gesture) return;
  if (gesture.type === "pan") {
    const p = local(e);
    camera = panBy(camera, p.x - gesture.last.x, p.y - gesture.last.y);
    gesture.last = p;
    applyCamera();
    return;
  }
  const p = toWorld(e);
  if (gesture.type === "draw") {
    gesture.end = p;
    const { start } = gesture;
    const a =
      gesture.shape === "arrow"
        ? { type: "arrow", from: start, to: p }
        : { type: "box", at: { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y) }, w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    draftEl.replaceChildren(shapeEls(a)[0]);
    return;
  }
  if (gesture.type === "handle") {
    const a = ann(gesture.id);
    // Dragging an arrow end or a note's pin re-attaches it to whatever is underneath.
    if (gesture.handle === "from" || gesture.handle === "to") a[gesture.handle] = anchorAt(p);
    if (gesture.handle === "pin") {
      // Drop the dot on another element to re-attach; off any element it stays put.
      const next = anchorAt(p);
      if (next.snap) a.at = next;
    }
    if (gesture.handle === "corner") {
      const tl = resolve(a.at);
      Object.assign(a, { w: Math.max(8, p.x - tl.x), h: Math.max(8, p.y - tl.y) });
    }
    gesture.moved = true;
    renderInk();
    return;
  }
  if (gesture.type === "move") {
    const dx = p.x - gesture.last.x;
    const dy = p.y - gesture.last.y;
    gesture.last = p;
    if (!dx && !dy) return;
    gesture.moved = true;
    if (gesture.kind === "snap") {
      const at = doc.layout[gesture.id];
      at.x += dx;
      at.y += dy;
      renderCards();
      renderInk(); // anchored annotations ride along with their card
    } else {
      const a = ann(gesture.id);
      for (const pt of pointsOf(a)) movePoint(pt, dx, dy);
      renderInk();
    }
  }
});

function endGesture() {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  viewport.classList.remove("panning");
  draftEl.replaceChildren();
  if (g.type === "draw") {
    const { start, end } = g;
    const big = Math.hypot(end.x - start.x, end.y - start.y) > 8 / camera.z;
    let a = null;
    if (big && g.shape === "arrow") {
      a = { id: uid(), type: "arrow", from: anchorAt(start), to: anchorAt(end) };
    } else if (big) {
      // A dragged box belongs to the element where the drag started.
      const tl = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) };
      const at = anchorAt(start);
      movePoint(at, tl.x - start.x, tl.y - start.y);
      a = { id: uid(), type: "box", at, w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    } else if (g.shape === "box") {
      // A click outlines the element under it, the way selecting a layer does.
      const hit = elementAt(start);
      const b = hit && locate(hit.snap, hit.path);
      const PAD = 4;
      if (b) {
        const at = { snap: hit.snap, path: hit.path, dx: -PAD, dy: -PAD, label: describe(hit.el) };
        a = { id: uid(), type: "box", at, w: b.w + PAD * 2, h: b.h + PAD * 2 };
      }
    }
    if (a) {
      pushHistory();
      doc.annotations.push(a);
      setTool("select");
      select({ kind: "ann", id: a.id });
      save();
    }
  } else if ((g.type === "move" || g.type === "handle") && g.moved) {
    pushHistory(g.before);
    save();
  }
}
viewport.addEventListener("pointerup", endGesture);
viewport.addEventListener("pointerleave", () => setHover(null));
notesEl.addEventListener("pointerover", (e) => {
  const id = e.target.closest(".note")?.dataset.id || null;
  if (id !== hoveredNote) {
    hoveredNote = id;
    renderInk();
  }
});
notesEl.addEventListener("pointerleave", () => {
  hoveredNote = null;
  renderInk();
});
viewport.addEventListener("pointercancel", endGesture);

viewport.addEventListener("dblclick", (e) => {
  // Pointer capture retargets click events to the viewport, so look up what's actually under the cursor.
  const target = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  const note = target.closest(".note");
  if (note) return editNote(note.dataset.id);
  const card = target.closest(".card");
  if (card && !target.closest("header")) setLive(card.dataset.id);
});

viewport.addEventListener("click", async (e) => {
  const del = e.target.closest('[data-action="delete"]');
  if (!del) return;
  const id = del.closest(".card").dataset.id;
  const n = doc.annotations.filter((a) => snapsOf(a).includes(id)).length;
  const also = n ? ` and the ${n} annotation${n > 1 ? "s" : ""} attached to it` : "";
  if (!confirm(`Delete this snapshot${also}? This can't be undone.`)) return;
  await fetch(`/api/snapshots/${id}`, { method: "DELETE" });
  removeSnap(id);
});

// Right-click an annotation for a small menu with Delete.
const menu = $("#menu");
function openMenu(x, y, id) {
  menu.dataset.id = id;
  menu.hidden = false;
  // Keep the menu on screen near the edges.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
  menu.querySelector("button").focus();
}
function closeMenu() {
  menu.hidden = true;
}
function deleteAnnotation(id) {
  pushHistory();
  doc.annotations = doc.annotations.filter((a) => a.id !== id);
  if (selection?.id === id) selection = null;
  if (hoveredNote === id) hoveredNote = null;
  render();
  save();
}
viewport.addEventListener("contextmenu", (e) => {
  const hit = e.target.closest('[data-kind="ann"], [data-handle="pin"]');
  if (!hit || hit.closest("[contenteditable=true]")) return;
  e.preventDefault();
  select({ kind: "ann", id: hit.dataset.id });
  openMenu(e.clientX, e.clientY, hit.dataset.id);
});
menu.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="delete-annotation"]')) deleteAnnotation(menu.dataset.id);
  closeMenu();
});
addEventListener("pointerdown", (e) => {
  if (!menu.hidden && !menu.contains(e.target)) closeMenu();
}, true);
addEventListener("wheel", () => closeMenu(), { capture: true, passive: true });
addEventListener("blur", closeMenu);

viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const w = normalizeWheel(e, viewport.clientHeight);
    // Inside the live card, the wheel scrolls the frozen page instead of the canvas.
    const live = liveCard && e.target.closest(".card.live");
    if (live && !w.isZoom) {
      scrollInside(live, e, w.dx / camera.z, w.dy / camera.z);
      return;
    }
    if (w.isZoom) {
      const p = local(e);
      camera = zoomAt(camera, p.x, p.y, zoomFactor(w.dy));
    } else camera = panBy(camera, -w.dx, -w.dy);
    applyCamera();
    renderInk(); // handle radii track zoom
  },
  { passive: false },
);

// Scroll the frozen page under the cursor, descending into frozen iframes so a page whose
// content lives in an iframe still scrolls.
function scrollInside(card, e, dx, dy) {
  const at = doc.layout[card.dataset.id];
  const p = toWorld(e);
  let win = card.querySelector("iframe").contentWindow;
  let x = p.x - at.x - 1;
  let y = p.y - at.y - HEADER - 1;
  try {
    for (let el = win.document.elementFromPoint(x, y); el?.localName === "iframe" && el.contentWindow; ) {
      const r = el.getBoundingClientRect();
      win = el.contentWindow;
      x -= r.left;
      y -= r.top;
      el = win.document.elementFromPoint(x, y);
    }
    win.scrollBy({ left: dx, top: dy, behavior: "instant" });
  } catch {}
  renderInk(); // anchored annotations follow their elements as the page scrolls
}

// Stop the browser zooming the whole page on pinch outside the viewport.
document.addEventListener("gesturestart", (e) => e.preventDefault());

// ------------------------------------------------------------------ keyboard

addEventListener("keydown", (e) => {
  if (e.target.closest?.("[contenteditable=true], input, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && e.key.toLowerCase() === "y") return redo();
  if (mod) return;
  if (e.key === " ") {
    spaceDown = true;
    viewport.classList.add("space");
    e.preventDefault();
    return;
  }
  if (e.key === "Escape" && !menu.hidden) return closeMenu();
  if (e.key === "Escape") {
    setLive(null);
    select(null);
    setTool("select");
    return;
  }
  const tools = { v: "select", n: "note", a: "arrow", r: "box" };
  if (tools[e.key.toLowerCase()]) return setTool(tools[e.key.toLowerCase()]);
  if (e.key.toLowerCase() === "f") return fit(selectionBox() || bounds());
  if ((e.key === "Backspace" || e.key === "Delete") && selection) {
    e.preventDefault();
    if (selection.kind === "ann") {
      pushHistory();
      doc.annotations = doc.annotations.filter((a) => a.id !== selection.id);
      select(null);
      save();
    } else {
      cardsEl.querySelector(`[data-id="${selection.id}"] [data-action="delete"]`)?.click();
    }
  }
});
addEventListener("keyup", (e) => {
  if (e.key === " ") {
    spaceDown = false;
    viewport.classList.remove("space");
  }
});

function selectionBox() {
  if (selection?.kind !== "snap") return null;
  const m = snaps.get(selection.id);
  const at = doc.layout[selection.id];
  if (!m || !at) return null;
  // Include the snapshot's annotation columns so fitting shows them too.
  const box = { ...at, ...sizeOf(m) };
  for (const a of doc.annotations) {
    const p = a.type === "note" && a.at.snap === selection.id && notePos.get(a.id);
    if (!p) continue;
    const x = Math.min(box.x, p.x);
    const y = Math.min(box.y, p.y);
    box.w = Math.max(box.x + box.w, p.x + NOTE_W) - x;
    box.h = Math.max(box.y + box.h, p.y + p.h) - y;
    box.x = x;
    box.y = y;
  }
  return box;
}

document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("#fit").addEventListener("click", () => fit());

// ------------------------------------------------------------------ background

const DEFAULT_BG = "#f5f5f5";
const bgInput = $("#bg");

// Relative luminance decides whether annotations render in their light or dark version.
function toneOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.4 ? "dark" : "light";
}

function applyBackground() {
  const bg = /^#[0-9a-f]{6}$/i.test(doc.background || "") ? doc.background : DEFAULT_BG;
  document.documentElement.style.setProperty("--canvas-bg", bg);
  viewport.dataset.tone = toneOf(bg);
  bgInput.value = bg;
}

bgInput.addEventListener("input", () => {
  doc.background = bgInput.value;
  applyBackground();
  save();
});
bgInput.closest("label").addEventListener("dblclick", (e) => {
  e.preventDefault();
  delete doc.background;
  applyBackground();
  save();
});

// ------------------------------------------------------------------ snapshots in and out

function addSnap(meta, focus = false) {
  snaps.set(meta.id, meta);
  const wasPlaced = !!doc.layout[meta.id];
  place(meta);
  if (!wasPlaced) save();
  render();
  if (focus) {
    select({ kind: "snap", id: meta.id });
    fit(selectionBox());
  }
}

function removeSnap(id) {
  snaps.delete(id);
  delete doc.layout[id];
  doc.annotations = doc.annotations.filter((a) => !snapsOf(a).includes(id));
  if (selection?.id === id) selection = null;
  if (liveCard === id) liveCard = null;
  render();
  save();
}

async function load() {
  const [saved, list] = await Promise.all([
    fetch("/api/canvas").then((r) => r.json()),
    fetch("/api/snapshots").then((r) => r.json()),
  ]);
  doc = { version: 1, camera: null, layout: {}, annotations: [], ...saved };
  // Forgiving load: drop anything malformed instead of refusing the whole file.
  doc.annotations = (doc.annotations || [])
    .filter((a) => a && a.id && ["note", "arrow", "box"].includes(a.type))
    .map(migrate)
    .map(({ side, ...a }) => a) // card sides are always chosen by the layout now
    .filter((a) => a.type !== "note" || a.text.trim()); // an empty note is an abandoned edit
  loaded = true;
  for (const meta of list) {
    snaps.set(meta.id, meta);
    place(meta);
  }
  applyBackground();
  if (doc.camera) {
    camera = doc.camera;
    applyCamera();
  } else fit();
  render();
  save();
}

$("#snippet").textContent = `<script src="${location.origin}/relay.js" defer></script>`;
setTool("select");
applyBackground();
applyCamera();
load().catch((err) => console.error("[relay] failed to load canvas", err));

const events = new EventSource("/api/events");
events.addEventListener("snapshot", (e) => addSnap(JSON.parse(e.data), true));
events.addEventListener("deleted", (e) => {
  const { id } = JSON.parse(e.data);
  if (snaps.has(id)) removeSnap(id);
});
