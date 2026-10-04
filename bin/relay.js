#!/usr/bin/env node
// relay — a tiny local server: serves the toolbar script, stores frozen page
// snapshots under ./<project>.relay, and hosts the canvas they get annotated on.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`relay [--port 4400] [--dir .]

Saves to <dir>/<dir name>.relay/, e.g. checklists/checklists.relay/

Add to the page you're developing:
  <script src="http://localhost:4400/relay.js" defer></script>`);
  process.exit(0);
}

const PORT = Number(flag("port", process.env.RELAY_PORT || 4400));
const ROOT_DIR = path.resolve(flag("dir", process.cwd()));
// Named after the project it belongs to, so it's obvious where it came from: checklists/checklists.relay/
const DIR = path.join(ROOT_DIR, `${path.basename(ROOT_DIR)}.relay`);
const SNAPS = path.join(DIR, "snaps");
const CANVAS = path.join(DIR, "canvas.json");
const MAX_BODY = 50 * 1024 * 1024;
const ID_RE = /^[a-z0-9-]+$/;

const STATIC = {
  "/relay.js": ["client/relay.js", "text/javascript"],
  "/": ["canvas/index.html", "text/html"],
  "/canvas.css": ["canvas/canvas.css", "text/css"],
  "/canvas.js": ["canvas/canvas.js", "text/javascript"],
  "/camera.js": ["canvas/camera.js", "text/javascript"],
};

const exists = (p) => fs.stat(p).then(() => true, () => false);

const isCanvas = async (dir) => (await exists(path.join(dir, "snaps"))) || (await exists(path.join(dir, "canvas.json")));

// Canvases used to live in .relay/ (and briefly relay/); move one over the first time.
for (const old of [".relay", "relay"]) {
  const from = path.join(ROOT_DIR, old);
  if (!(await exists(DIR)) && (await isCanvas(from))) {
    await fs.rename(from, DIR);
    console.log(`  moved ${old}/ → ${path.basename(DIR)}/`);
  }
}

// Never write into a "relay" folder that belongs to the project itself.
if (await exists(DIR)) {
  const ours = await isCanvas(DIR);
  const empty = (await fs.readdir(DIR)).length === 0;
  if (!ours && !empty) {
    console.error(`${DIR} already exists and isn't a relay canvas. Run relay from another folder or pass --dir.`);
    process.exit(1);
  }
}

await fs.mkdir(SNAPS, { recursive: true });
// Ignore the whole folder from inside itself, so no tracked file is touched.
await fs.writeFile(path.join(DIR, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});

const clients = new Set();
const broadcast = (event, data) => {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const send = (res, status, body, type = "application/json", headers = {}) => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Snapshot too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// Write to a temp file and rename, so a crash mid-write never leaves half a JSON file.
const writeAtomic = async (file, data) => {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
};

const listSnapshots = async () => {
  const files = (await fs.readdir(SNAPS)).filter((f) => f.endsWith(".json"));
  const metas = await Promise.all(
    files.map((f) => fs.readFile(path.join(SNAPS, f), "utf8").then(JSON.parse).catch(() => null)),
  );
  return metas.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // The toolbar posts from whatever localhost port the dev server is on.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "GET" && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, await fs.readFile(path.join(ROOT, file)), `${type}; charset=utf-8`);
  }

  if (p === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // Lets `relay.mjs off` find which project this server belongs to.
  if (p === "/api/info") return send(res, 200, { root: ROOT_DIR, dir: DIR, port: PORT });

  // Tells every open page to take its toolbar down right away.
  if (p === "/api/off" && req.method === "POST") {
    broadcast("off", {});
    return send(res, 200, { ok: true, pages: clients.size });
  }

  if (p === "/api/snapshots" && req.method === "GET") return send(res, 200, await listSnapshots());

  if (p === "/api/snapshots" && req.method === "POST") {
    const { html, meta } = JSON.parse(await readBody(req));
    if (typeof html !== "string" || !meta) return send(res, 400, { error: "Expected { html, meta }" });
    const id = newId();
    const record = {
      id,
      url: String(meta.url || ""),
      title: String(meta.title || ""),
      label: String(meta.label || ""),
      viewport: meta.viewport,
      scroll: meta.scroll,
      docHeight: meta.docHeight,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(SNAPS, `${id}.html`), html);
    await fs.writeFile(path.join(SNAPS, `${id}.json`), JSON.stringify(record, null, 2));
    broadcast("snapshot", record);
    console.log(`  ◉ ${id}  ${record.label || record.title || record.url}`);
    return send(res, 201, record);
  }

  const del = p.match(/^\/api\/snapshots\/([^/]+)$/);
  if (del && req.method === "DELETE") {
    const id = del[1];
    if (!ID_RE.test(id)) return send(res, 400, { error: "Bad id" });
    await Promise.all(["html", "json"].map((ext) => fs.rm(path.join(SNAPS, `${id}.${ext}`), { force: true })));
    broadcast("deleted", { id });
    return send(res, 200, { ok: true });
  }

  const snap = p.match(/^\/snaps\/([^/]+)\.html$/);
  if (snap && req.method === "GET") {
    if (!ID_RE.test(snap[1])) return send(res, 400, "Bad id", "text/plain");
    const html = await fs.readFile(path.join(SNAPS, `${snap[1]}.html`)).catch(() => null);
    if (!html) return send(res, 404, "Not found", "text/plain");
    // Belt and braces: the capture strips scripts, and this makes sure nothing runs anyway.
    return send(res, 200, html, "text/html; charset=utf-8", {
      "Content-Security-Policy": "script-src 'none'; object-src 'none'",
    });
  }

  if (p === "/api/canvas" && req.method === "GET") {
    const doc = await fs.readFile(CANVAS, "utf8").catch(() => null);
    return send(res, 200, doc || { version: 1, camera: null, layout: {}, annotations: [] });
  }

  if (p === "/api/canvas" && req.method === "PUT") {
    const body = await readBody(req);
    JSON.parse(body); // refuse to persist anything that isn't JSON
    await writeAtomic(CANVAS, body);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) =>
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    else res.end();
  }),
);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`Port ${PORT} is in use. Try: relay --port ${PORT + 1}`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`relay → http://localhost:${PORT}
  saving to ${path.relative(process.cwd(), DIR) || "."}/
  add to your page: <script src="http://localhost:${PORT}/relay.js" defer></script>`);
});
