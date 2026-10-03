import { screenToWorld, panBy, zoomAt, worldTransform, zoomToBox, normalizeWheel, zoomFactor } from "/camera.js";

// ------------------------------------------------------------------ state
//
// The server writes snapshots; only this page writes canvas.json. A snapshot
// with no saved position gets auto-placed, so nothing posted while the canvas
// is closed (or mid-save) can be lost.

const HEADER = 44;
const GAP_X = 120;
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
    if (a.type === "note") boxes.push({ x: a.x, y: a.y, w: 240, h: 120 });
    if (a.type === "box") boxes.push(a);
    if (a.type === "arrow")
      boxes.push({ x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) });
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
  const g = 24 * camera.z;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
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
    } catch {}
  });
  frame.src = `/snaps/${meta.id}.html`;
  return el;
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

function shapeEls(a, cls = "shape") {
  if (a.type === "arrow") {
    const line = { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
    return [
      svg("line", { ...line, class: cls, "stroke-width": STROKE, "marker-end": "url(#head)" }),
      svg("line", { ...line, class: "hit", "stroke-width": STROKE * 4, "data-kind": "ann", "data-id": a.id }),
    ];
  }
  const rect = { x: a.x, y: a.y, width: Math.max(1, a.w), height: Math.max(1, a.h), rx: 6 };
  return [
    svg("rect", { ...rect, class: cls, "stroke-width": STROKE }),
    svg("rect", { ...rect, class: "hit", "stroke-width": STROKE * 4, "data-kind": "ann", "data-id": a.id }),
  ];
}

function renderInk() {
  shapesEl.replaceChildren();
  handlesEl.replaceChildren();
  const r = 8 / camera.z;
  for (const a of doc.annotations) {
    if (a.type === "note") continue;
    const selected = selection?.kind === "ann" && selection.id === a.id;
    shapesEl.append(...shapeEls(a, selected ? "shape selected-shape" : "shape"));
    if (!selected) continue;
    const points = a.type === "arrow" ? [["p1", a.x1, a.y1], ["p2", a.x2, a.y2]] : [["corner", a.x + a.w, a.y + a.h]];
    for (const [handle, cx, cy] of points)
      handlesEl.append(svg("circle", { cx, cy, r, class: "handle", "stroke-width": 2 / camera.z, "data-handle": handle, "data-id": a.id }));
  }

  const seen = new Set();
  for (const a of doc.annotations) {
    if (a.type !== "note") continue;
    seen.add(a.id);
    let el = notesEl.querySelector(`[data-id="${a.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "note";
      el.dataset.kind = "ann";
      el.dataset.id = a.id;
      notesEl.appendChild(el);
    }
    if (editingNote !== a.id && el.textContent !== a.text) el.textContent = a.text;
    el.style.transform = `translate(${a.x}px, ${a.y}px)`;
    el.classList.toggle("selected", selection?.kind === "ann" && selection.id === a.id);
  }
  for (const el of [...notesEl.children]) if (!seen.has(el.dataset.id)) el.remove();
}

function render() {
  renderCards();
  renderInk();
}

function setTool(t) {
  tool = t;
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
  const el = notesEl.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  const before = snapshotState();
  editingNote = id;
  el.contentEditable = "true";
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
        // An empty note is a misclick; drop it without leaving an undo step behind.
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
  if (e.target.closest("header a, header button")) return;
  if (editingNote) document.activeElement.blur();

  const card = e.target.closest(".card");
  if (liveCard && (!card || card.dataset.id !== liveCard)) setLive(null);

  const start = toWorld(e);
  const screen = local(e);
  viewport.setPointerCapture(e.pointerId);

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
    const a = { id: uid(), type: "note", x: start.x, y: start.y, text: "" };
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
    gesture = { type: "handle", id: handle.dataset.id, handle: handle.dataset.handle, before: snapshotState(), moved: false };
    return;
  }
  const kind = hit.dataset.kind;
  const id = hit.dataset.id;
  select({ kind, id });
  gesture = { type: "move", kind, id, last: start, before: snapshotState(), moved: false };
});

viewport.addEventListener("pointermove", (e) => {
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
        ? { type: "arrow", x1: start.x, y1: start.y, x2: p.x, y2: p.y }
        : { type: "box", x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    draftEl.replaceChildren(shapeEls(a)[0]);
    return;
  }
  if (gesture.type === "handle") {
    const a = ann(gesture.id);
    if (gesture.handle === "p1") Object.assign(a, { x1: p.x, y1: p.y });
    if (gesture.handle === "p2") Object.assign(a, { x2: p.x, y2: p.y });
    if (gesture.handle === "corner") Object.assign(a, { w: Math.max(8, p.x - a.x), h: Math.max(8, p.y - a.y) });
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
    } else {
      const a = ann(gesture.id);
      if (a.type === "arrow") Object.assign(a, { x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy });
      else Object.assign(a, { x: a.x + dx, y: a.y + dy });
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
    if (big) {
      pushHistory();
      const a =
        g.shape === "arrow"
          ? { id: uid(), type: "arrow", x1: start.x, y1: start.y, x2: end.x, y2: end.y }
          : { id: uid(), type: "box", x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
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
  if (!confirm("Delete this snapshot? This can't be undone.")) return;
  await fetch(`/api/snapshots/${id}`, { method: "DELETE" });
  removeSnap(id);
});

viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const w = normalizeWheel(e, viewport.clientHeight);
    // Inside the live card, the wheel scrolls the frozen page instead of the canvas.
    const live = liveCard && e.target.closest(".card.live");
    if (live && !w.isZoom) {
      live.querySelector("iframe").contentWindow?.scrollBy({ left: w.dx / camera.z, top: w.dy / camera.z, behavior: "instant" });
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
  return m && at ? { ...at, ...sizeOf(m) } : null;
}

document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("#fit").addEventListener("click", () => fit());

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
  doc.annotations = (doc.annotations || []).filter((a) => a && a.id && ["note", "arrow", "box"].includes(a.type));
  loaded = true;
  for (const meta of list) {
    snaps.set(meta.id, meta);
    place(meta);
  }
  if (doc.camera) {
    camera = doc.camera;
    applyCamera();
  } else fit();
  render();
  save();
}

$("#snippet").textContent = `<script src="${location.origin}/relay.js" defer></script>`;
setTool("select");
applyCamera();
load().catch((err) => console.error("[relay] failed to load canvas", err));

const events = new EventSource("/api/events");
events.addEventListener("snapshot", (e) => addSnap(JSON.parse(e.data), true));
events.addEventListener("deleted", (e) => {
  const { id } = JSON.parse(e.data);
  if (snaps.has(id)) removeSnap(id);
});
