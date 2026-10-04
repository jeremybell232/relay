#!/usr/bin/env node
// Fast path for the /relay skill: does every deterministic step in one run so
// Claude only has to start the servers.
//
//   node ~/.claude/skills/relay/relay.mjs add   [--dir .]   insert toolbar + launch configs
//                                                           (shared layout, or every page of a plain site)
//   node ~/.claude/skills/relay/relay.mjs off   [--dir .]   remove them again
//
// Prints one JSON object describing what it did. Node resolves this file through
// the skill symlink, so ../../bin/relay.js is the real relay checkout.
//
// The relay launch config goes in the *session's* .claude/launch.json (the folder
// Claude was opened in), with --dir pointing at the project, so it also works when
// a session is opened somewhere other than the project itself.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run_ = promisify(execFile);

const RELAY_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/relay.js");
const args = process.argv.slice(2);
const cmd = args[0] || "add";
const dirFlag = args.indexOf("--dir");
const ROOT = path.resolve(dirFlag >= 0 ? args[dirFlag + 1] : process.cwd());
const SESSION = process.cwd();
const LAUNCH = path.join(SESSION, ".claude", "launch.json");
const START = "relay:start";

const read = (p) => fs.readFile(p, "utf8").catch(() => null);
const exists = async (p) => (await read(p)) != null;
const rel = (root, f) => path.relative(root, f) || f;

// Folders that are never projects; never scan or edit inside them as a whole.
const HOME = os.homedir();
const NOT_PROJECTS = new Set(["/", HOME, ...["Desktop", "Documents", "Downloads"].map((d) => path.join(HOME, d))]);

// ---------------------------------------------------------------- finding files

// Never look inside these: dependencies, build output, caches, relay's own folders.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", ".astro", ".vercel", ".netlify", ".cache", ".turbo", "coverage", "vendor", "bower_components", "tmp", "temp"]);
const skipDir = (name) => SKIP_DIRS.has(name) || name.startsWith(".") || name.endsWith(".relay");

// Project files with one of `exts`, honouring .gitignore when the project is a git repo.
async function projectFiles(root, exts) {
  const want = (f) => exts.some((x) => f.toLowerCase().endsWith(x)) && !f.split(/[\\/]/).slice(0, -1).some(skipDir);
  try {
    const { stdout } = await run_("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"]);
    const files = stdout.split("\n").filter(Boolean);
    if (files.length) return files.filter(want).map((f) => path.join(root, f));
  } catch {} // not a git repo
  const found = [];
  async function walk(dir, depth) {
    if (depth > 8 || found.length > 5000) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDir(e.name)) await walk(p, depth + 1);
      } else if (want(e.name)) found.push(p);
    }
  }
  await walk(root, 0);
  return found;
}

const hasBody = (src) => /<\/body>/i.test(src);

// ---------------------------------------------------------------- what to edit
//
// Wherever a framework has one layout shared by every route, edit only that. Plain
// sites (and single-page apps, which have one page) get every real HTML page.

async function detect(root) {
  const pkg = JSON.parse((await read(path.join(root, "package.json"))) || "null");
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const first = async (files) => {
    for (const f of files) if (await exists(path.join(root, f))) return path.join(root, f);
    return null;
  };
  const exts = ["tsx", "jsx", "js", "ts"];

  if (deps.next) {
    const appLayout = await first(["app", "src/app"].flatMap((d) => exts.map((x) => `${d}/layout.${x}`)));
    if (appLayout) return { framework: "Next.js (app router)", targets: [{ file: appLayout, kind: "next-app" }] };
    const doc = await first(["pages", "src/pages"].flatMap((d) => exts.map((x) => `${d}/_document.${x}`)));
    if (doc) return { framework: "Next.js (pages router)", targets: [{ file: doc, kind: "jsx" }] };
    return { framework: "Next.js (pages router)", targets: [], note: "No pages/_document file; create one (Next's default) and run /relay again." };
  }
  if (deps.astro) {
    // Every layout or page that renders the document shell.
    const files = (await projectFiles(root, [".astro"])).filter((f) => f.includes(`${path.sep}src${path.sep}`));
    const shells = [];
    for (const f of files) if (hasBody((await read(f)) || "")) shells.push({ file: f, kind: "astro" });
    return { framework: "Astro", targets: shells };
  }
  if (deps["@sveltejs/kit"]) {
    const app = await first(["src/app.html"]);
    return { framework: "SvelteKit", targets: app ? [{ file: app, kind: "html" }] : [] };
  }
  if (Object.keys(deps).some((d) => d.startsWith("@remix-run/") || d === "@react-router/dev")) {
    const rootFile = await first(exts.map((x) => `app/root.${x}`));
    return { framework: deps["@react-router/dev"] ? "React Router" : "Remix", targets: rootFile ? [{ file: rootFile, kind: "jsx" }] : [] };
  }
  if (deps.nuxt) return { framework: "Nuxt", targets: [], note: "Nuxt has no shared HTML file to edit; add the relay script to app.head.script in nuxt.config by hand." };

  // Everything else: every real page (one for a Vite/CRA single-page app, many for a plain site).
  const pages = [];
  for (const f of await projectFiles(root, [".html", ".htm"])) if (hasBody((await read(f)) || "")) pages.push({ file: f, kind: "html" });
  return { framework: pages.length > 1 ? "HTML pages" : "single page", targets: pages };
}

// ---------------------------------------------------------------- snippets

// Loads the toolbar only on localhost, so the snippet is harmless if it ships.
const loader = (port) =>
  `if (/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) { var s = document.createElement("script"); s.src = "http://localhost:${port}/relay.js"; document.body.appendChild(s); }`;

// Each snippet as lines, so it can go on its own indented lines or, when </body>
// shares a line with other markup, inline on that line.
const SNIPPETS = {
  html: (port) => [`<!-- relay:start -->`, `<script>${loader(port)}</script>`, `<!-- relay:end -->`],
  astro: (port) => [`<!-- relay:start -->`, `<script is:inline>${loader(port)}</script>`, `<!-- relay:end -->`],
  jsx: (port) => [`{/* relay:start */}`, `<script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(loader(port))} }} />`, `{/* relay:end */}`],
  "next-app": (port) => [
    `{/* relay:start */}`,
    `{process.env.NODE_ENV === "development" && (`,
    `  <Script src="http://localhost:${port}/relay.js" strategy="afterInteractive" />`,
    `)}`,
    `{/* relay:end */}`,
  ],
};

function insert(src, kind, port) {
  const close = src.toLowerCase().lastIndexOf("</body>");
  if (close < 0) return null;
  const lineStart = src.lastIndexOf("\n", close) + 1;
  const before = src.slice(lineStart, close);
  const lines = SNIPPETS[kind](port);
  let out;
  if (/^\s*$/.test(before)) {
    // </body> on its own line: the snippet goes on its own lines, one level deeper.
    const indent = before + (before.includes("\t") ? "\t" : "  ");
    out = src.slice(0, lineStart) + lines.map((l) => indent + l).join("\n") + "\n" + src.slice(lineStart);
  } else {
    // </body> shares a line: keep the file's shape and put the snippet inline.
    out = src.slice(0, close) + lines.map((l) => l.trim()).join("") + src.slice(close);
  }
  if (kind === "next-app" && !/from\s+["']next\/script["']/.test(out)) {
    // After a leading "use client"/"use strict" directive if there is one.
    const directive = out.match(/^(\s*["']use [a-z]+["'];?\s*\n)/);
    const i = directive ? directive[0].length : 0;
    out = out.slice(0, i) + `import Script from "next/script"; // relay\n` + out.slice(i);
  }
  return out;
}

// Exact inverse of insert(): own-line blocks take their indentation and newline with
// them; inline blocks take nothing else.
function stripSnippet(src) {
  const block = (a, b) => new RegExp(`^[ \\t]*${a}[\\s\\S]*?${b}\\n|${a}[\\s\\S]*?${b}`, "gm");
  return src
    .replace(block("<!-- relay:start -->", "<!-- relay:end -->"), "")
    .replace(block("\\{\\/\\* relay:start \\*\\/\\}", "\\{\\/\\* relay:end \\*\\/\\}"), "")
    .replace(/^import Script from "next\/script"; \/\/ relay\n/m, "");
}

// ---------------------------------------------------------------- ports + launch.json

// Is anything listening on this port right now?
const listening = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(300);
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => (sock.destroy(), resolve(false)));
  });

// First port from 4400 that no other launch config claims and that is either free
// or already a relay serving this very project.
async function pickPort(taken) {
  for (let port = 4400; port < 4420; port++) {
    if (taken.has(port)) continue;
    if (!(await listening(port))) return port;
    const info = await fetch(`http://localhost:${port}/api/info`, { signal: AbortSignal.timeout(400) }).then((r) => r.json()).catch(() => null);
    if (info?.root === ROOT) return port;
  }
  return 4420;
}

async function readLaunch() {
  const text = await read(LAUNCH);
  if (!text) return { version: "0.0.1", configurations: [] };
  return JSON.parse(text);
}
const writeLaunch = async (cfg) => {
  await fs.mkdir(path.dirname(LAUNCH), { recursive: true });
  await fs.writeFile(LAUNCH, JSON.stringify(cfg, null, 2) + "\n");
};

// A dev-server config for the app itself, when the project has none yet.
async function guessAppConfig() {
  const pkg = JSON.parse((await read(path.join(ROOT, "package.json"))) || "null");
  const scripts = pkg?.scripts || {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
  if (script) {
    const port = deps.next ? 3000 : deps.vite ? 5173 : deps["react-scripts"] ? 3000 : deps.astro ? 4321 : deps["@sveltejs/kit"] ? 5173 : 3000;
    return { name: "app", runtimeExecutable: "npm", runtimeArgs: ["run", script], port };
  }
  // A plain static site: serve it on the first free port from 5180.
  let port = 5180;
  while (port < 5200 && (await listening(port))) port++;
  return { name: "app", runtimeExecutable: "python3", runtimeArgs: ["-m", "http.server", String(port)], port };
}

// Relay for this project already answering on `port`?
const relayAt = (port) =>
  fetch(`http://localhost:${port}/api/info`, { signal: AbortSignal.timeout(400) }).then((r) => r.json()).catch(() => null);

// Start relay in the background (it outlives this script) and wait until it answers.
async function startRelay(port) {
  if ((await relayAt(port))?.root === ROOT) return "already running";
  const log = await fs.open(path.join(os.tmpdir(), `relay-${port}.log`), "a");
  spawn(process.execPath, [RELAY_BIN, "--port", String(port), "--dir", ROOT], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if ((await relayAt(port))?.root === ROOT) return "started";
  }
  return "failed";
}

// ---------------------------------------------------------------- update check
//
// Plugin installs live in Claude's plugin cache, in a folder named after the commit
// they were installed from. Compare that with the latest commit on GitHub (at most
// once a day, never slower than ~0.8s) so /relay:on can mention an available update.
// Linked/git checkouts are skipped; those update with git.

const PLUGIN_ROOT = path.resolve(path.dirname(RELAY_BIN), "..");
const CHECK_CACHE = path.join(os.tmpdir(), "relay-update-check.json");

async function checkForUpdate() {
  const installed = path.basename(PLUGIN_ROOT);
  if (!/^[0-9a-f]{7,40}$/.test(installed)) return null; // not a plugin-cache install
  const manifest = JSON.parse((await read(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"))) || "{}");
  const repo = (manifest.repository || "").match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];
  if (!repo) return null;

  let latest = null;
  const cached = JSON.parse((await read(CHECK_CACHE)) || "null");
  if (cached?.repo === repo && Date.now() - cached.at < 24 * 3600 * 1000) latest = cached.latest;
  else {
    latest = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
      headers: { Accept: "application/vnd.github.sha", "User-Agent": "relay" },
      signal: AbortSignal.timeout(800),
    })
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    if (latest) await fs.writeFile(CHECK_CACHE, JSON.stringify({ repo, latest, at: Date.now() })).catch(() => {});
  }
  if (!latest) return null;
  return {
    available: !latest.startsWith(installed),
    installed,
    latest: latest.slice(0, 12),
    how: "Claude app: Settings → Plugins → Relay → Update. Claude Code: /plugin → Installed → relay → Update now.",
  };
}

// ---------------------------------------------------------------- add

async function add() {
  const updating = checkForUpdate(); // runs alongside everything else
  const out = { root: ROOT, framework: null, files: [], inserted: 0, relay: null, relayPort: 4400, canvas: null, appConfig: null, appPort: null, appRunning: false, addedAppConfig: false, update: null, notes: [] };
  if (NOT_PROJECTS.has(ROOT)) {
    out.notes.push(`${ROOT} isn't a project folder; run with --dir <project>.`);
    return out;
  }

  // 1. launch.json: relay entry (+ the app's own, if missing)
  const cfg = await readLaunch();
  const others = cfg.configurations.filter((c) => c.name !== "relay");
  out.relayPort = await pickPort(new Set(others.map((c) => c.port)));
  const relay = {
    name: "relay",
    runtimeExecutable: "node",
    runtimeArgs: [RELAY_BIN, "--port", String(out.relayPort), "--dir", ROOT],
    port: out.relayPort,
  };
  let app = others[0];
  if (!app && SESSION !== ROOT) {
    out.notes.push(`This session is open in ${SESSION}, not the project; start the app's dev server yourself or open it with preview_start {url}.`);
  } else if (!app) {
    app = await guessAppConfig();
    out.addedAppConfig = true;
    out.notes.push(`Added a guessed "app" dev-server config (${app.runtimeExecutable} ${app.runtimeArgs.join(" ")}, port ${app.port}); check it if the app doesn't open.`);
  }
  cfg.configurations = [...(out.addedAppConfig ? [app] : others), relay];
  await writeLaunch(cfg);
  out.appConfig = app?.name || null;
  out.appPort = app?.port || null;

  // 2. the toolbar, in the shared layout (or on every page of a plain site)
  const { framework, targets, note } = await detect(ROOT);
  out.framework = framework;
  if (note) out.notes.push(note);
  if (!targets.length && !note) out.notes.push("Found no page or layout with a </body> to add the toolbar to; add the snippet by hand.");
  for (const t of targets) {
    const src = await read(t.file);
    out.files.push(rel(ROOT, t.file));
    if (src.includes(START)) {
      // Already there; just keep its port in step with launch.json.
      const next = src.replace(/localhost:\d{2,5}\/relay\.js/g, `localhost:${out.relayPort}/relay.js`);
      if (next !== src) await fs.writeFile(t.file, next);
      continue;
    }
    const next = insert(src, t.kind, out.relayPort);
    if (next == null) {
      out.notes.push(`${rel(ROOT, t.file)} has no </body>; add the snippet by hand.`);
      continue;
    }
    await fs.writeFile(t.file, next);
    out.inserted++;
  }
  if (targets.length && !out.inserted) out.notes.push("Toolbar already on every page; nothing new to add.");

  // 3. relay itself, running in the background, and whether the app is up.
  out.relay = await startRelay(out.relayPort);
  if (out.relay === "failed") out.notes.push(`relay didn't start; see ${path.join(os.tmpdir(), `relay-${out.relayPort}.log`)}.`);
  out.canvas = `http://localhost:${out.relayPort}/`;
  out.appRunning = out.appPort ? await listening(out.appPort) : false;
  out.update = await updating;
  return out;
}

// Running relay servers (from launch.json, plus the default ports) and the project each serves.
async function runningServers() {
  const ports = new Set([4400, 4401]);
  const cfg = JSON.parse((await read(LAUNCH)) || "null");
  for (const c of cfg?.configurations || []) if (c.name === "relay" && c.port) ports.add(c.port);
  const found = [];
  for (const port of ports) {
    try {
      const info = await fetch(`http://localhost:${port}/api/info`, { signal: AbortSignal.timeout(400) }).then((r) => r.json());
      if (info?.root) found.push({ ...info, port });
    } catch {} // nothing on that port
  }
  return found;
}

// Every file in the project carrying relay markers, wherever /relay put them.
async function removeSnippets(root) {
  if (NOT_PROJECTS.has(root)) return [];
  const removed = [];
  for (const f of await projectFiles(root, [".html", ".htm", ".astro", ".tsx", ".jsx", ".js", ".ts", ".vue", ".svelte"])) {
    const src = await read(f);
    if (!src || !src.includes(START)) continue;
    await fs.writeFile(f, stripSnippet(src));
    removed.push(f);
  }
  return removed;
}

async function removeLaunchConfig(dir) {
  const launch = path.join(dir, ".claude", "launch.json");
  const text = await read(launch);
  if (!text) return false;
  const cfg = JSON.parse(text);
  const before = cfg.configurations.length;
  cfg.configurations = cfg.configurations.filter((c) => c.name !== "relay");
  if (cfg.configurations.length === before) return false;
  if (cfg.configurations.length) await fs.writeFile(launch, JSON.stringify(cfg, null, 2) + "\n");
  else await fs.rm(launch);
  return true;
}

async function off() {
  const out = { root: ROOT, removedFrom: [], launchUpdated: false, toolbarsHidden: 0, turnedOff: [], found: false, notes: [] };
  const servers = await runningServers();

  // Only the relay that belongs here: the one this session's launch config starts,
  // or one serving this folder. Other projects' relays (and the demo) are left alone.
  const cfg = JSON.parse((await read(LAUNCH)) || "null");
  const myPorts = new Set((cfg?.configurations || []).filter((c) => c.name === "relay").map((c) => c.port));
  let targets = servers.filter((s) => s.root === ROOT || myPorts.has(s.port));
  if (!targets.length && dirFlag < 0 && servers.length === 1) targets = servers; // the only one running
  if (!targets.length && servers.length > 1)
    out.notes.push(`Several relays are running (${servers.map((s) => `${s.root} on ${s.port}`).join("; ")}) and none belongs to this folder. Run off with --dir <project>.`);
  out.turnedOff = targets.map((s) => ({ port: s.port, root: s.root }));

  // 1. Take toolbars off open pages immediately, then stop that relay.
  for (const s of targets) {
    try {
      const r = await fetch(`http://localhost:${s.port}/api/off`, { method: "POST", signal: AbortSignal.timeout(400) }).then((r) => r.json());
      out.toolbarsHidden += r.pages || 0;
      await fetch(`http://localhost:${s.port}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(400) });
    } catch {}
  }

  // 2. Remove the snippet from the project(s), and the relay entry from launch configs.
  const roots = [...new Set([ROOT, ...targets.map((s) => s.root)])];
  for (const root of roots) out.removedFrom.push(...(await removeSnippets(root)).map((f) => rel(root, f)));
  for (const dir of new Set([SESSION, ...roots])) out.launchUpdated = (await removeLaunchConfig(dir)) || out.launchUpdated;

  out.found = out.removedFrom.length > 0 || out.launchUpdated || targets.length > 0;
  const demo = path.resolve(path.dirname(RELAY_BIN), "../example");
  if (targets.some((s) => s.root === demo)) out.notes.push("relay's own demo adds the toolbar when it serves the page; stop `npm run demo` to turn it off for good.");
  if (!out.found && !out.notes.length) out.notes.push(`relay isn't set up in ${ROOT} and no relay server is running, so there was nothing to turn off.`);
  else if (out.found) out.notes.push("The <project>.relay/ canvas folder was left in place.");
  return out;
}

const run = { add, off }[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Use add or off.`);
  process.exit(1);
}
console.log(JSON.stringify(await run(), null, 2));
