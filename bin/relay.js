#!/usr/bin/env node
// relay — a tiny local server: serves the toolbar script, stores frozen page
// snapshots under ./<project>.relay, and hosts the canvas they get annotated on.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`relay [--port 4400] [--dir .] [--open]

Saves to <dir>/<dir name>.relay/, e.g. checklists/checklists.relay/
--open opens the canvas in your browser (and just opens it if relay is already running).
The port defaults to the one in the project's toolbar snippet, else 4400.

Add to the page you're developing:
  <script src="http://localhost:4400/relay.js" defer></script>`);
  process.exit(0);
}

const ROOT_DIR = path.resolve(flag("dir", process.cwd()));
const OPEN = args.includes("--open");

// Relay belongs inside a project. Refuse folders where a canvas would just be clutter.
const HOME = os.homedir();
const NOT_PROJECTS = ["/", HOME, ...["Desktop", "Documents", "Downloads"].map((d) => path.join(HOME, d))];
if (NOT_PROJECTS.includes(ROOT_DIR) && !args.includes("--force")) {
  console.error(`relay: ${ROOT_DIR} isn't a project folder. Run relay from your project (or pass --dir <project>).`);
  process.exit(1);
}

// Use the port the project's toolbar snippet points at, so snapshots always reach this server.
async function snippetPort() {
  const files = ["index.html", "src/index.html", "public/index.html"];
  for (const d of ["app", "src/app"]) for (const x of ["tsx", "jsx", "js", "ts"]) files.push(`${d}/layout.${x}`);
  for (const d of ["pages", "src/pages"]) for (const x of ["tsx", "jsx", "js", "ts"]) files.push(`${d}/_document.${x}`);
  for (const f of files) {
    const src = await fs.readFile(path.join(ROOT_DIR, f), "utf8").catch(() => "");
    const m = src.match(/localhost:(\d{2,5})\/relay\.js/);
    if (m) return Number(m[1]);
  }
  return null;
}
const PORT = Number(flag("port", process.env.RELAY_PORT || (await snippetPort()) || 4400));
const URL_ = `http://localhost:${PORT}/`;

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, cmdArgs, () => {});
}
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

// A double-clickable way to open this canvas from Finder: starts relay for the
// project if needed, then opens the canvas in the browser.
if (process.platform === "darwin") {
  const opener = path.join(DIR, "Open canvas.command");
  const script = `#!/bin/bash
# Opens this project's relay canvas. Starts relay first if it isn't running.
cd "$(dirname "$0")/.." || exit 1
NODE="$(command -v node || echo "${process.execPath}")"
exec "$NODE" "${path.join(ROOT, "bin", "relay.js")}" --open
`;
  if ((await fs.readFile(opener, "utf8").catch(() => null)) !== script) {
    await fs.writeFile(opener, script);
    await fs.chmod(opener, 0o755);
  }
}

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

server.on("error", async (err) => {
  if (err.code !== "EADDRINUSE") {
    console.error(err);
    process.exit(1);
  }
  // Already running for this project? Then just open it.
  const info = await fetch(`${URL_}api/info`, { signal: AbortSignal.timeout(800) }).then((r) => r.json()).catch(() => null);
  if (info?.root === ROOT_DIR) {
    console.log(`relay is already running for this project → ${URL_}`);
    if (OPEN) openBrowser(URL_);
    process.exit(0);
  }
  console.error(
    info?.root
      ? `Port ${PORT} is used by relay for ${info.root}. Stop that one, or run: relay --port ${PORT + 1}`
      : `Port ${PORT} is in use. Try: relay --port ${PORT + 1}`,
  );
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  if (OPEN) openBrowser(URL_);
  console.log(`relay → http://localhost:${PORT}
  saving to ${path.relative(process.cwd(), DIR) || "."}/
  add to your page: <script src="http://localhost:${PORT}/relay.js" defer></script>`);
});
