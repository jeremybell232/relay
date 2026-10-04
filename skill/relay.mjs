#!/usr/bin/env node
// Fast path for the /relay skill: does every deterministic step in one run so
// Claude only has to start the servers.
//
//   node ~/.claude/skills/relay/relay.mjs add   [--dir .]   insert toolbar + launch configs
//   node ~/.claude/skills/relay/relay.mjs off   [--dir .]   remove them again
//
// Prints one JSON object describing what it did. Node resolves this file through
// the skill symlink, so ../bin/relay.js is the real relay checkout.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/relay.js");
const args = process.argv.slice(2);
const cmd = args[0] || "add";
const dirFlag = args.indexOf("--dir");
const ROOT = path.resolve(dirFlag >= 0 ? args[dirFlag + 1] : process.cwd());
const LAUNCH = path.join(ROOT, ".claude", "launch.json");
const START = "relay:start";

const read = (p) => fs.readFile(p, "utf8").catch(() => null);
const exists = async (p) => (await read(p)) != null;

// Entry points in priority order. `kind` decides what gets inserted.
const CANDIDATES = [
  ...["app", "src/app"].flatMap((d) => ["tsx", "jsx", "js", "ts"].map((x) => ({ file: `${d}/layout.${x}`, kind: "next" }))),
  ...["pages", "src/pages"].flatMap((d) => ["tsx", "jsx", "js", "ts"].map((x) => ({ file: `${d}/_document.${x}`, kind: "next" }))),
  ...["index.html", "src/index.html", "public/index.html", "app/index.html"].map((file) => ({ file, kind: "html" })),
];

const htmlBlock = (port) => `<!-- relay:start -->
<script>
  if (/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) {
    var s = document.createElement("script");
    s.src = "http://localhost:${port}/relay.js";
    document.body.appendChild(s);
  }
</script>
<!-- relay:end -->
`;

const jsxBlock = (port, indent) =>
  [
    `{/* relay:start */}`,
    `{process.env.NODE_ENV === "development" && (`,
    `  <Script src="http://localhost:${port}/relay.js" strategy="afterInteractive" />`,
    `)}`,
    `{/* relay:end */}`,
  ]
    .map((l) => indent + l)
    .join("\n") + "\n";

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
    const port = deps.next ? 3000 : deps.vite ? 5173 : deps["react-scripts"] ? 3000 : deps.astro ? 4321 : 3000;
    return { name: "app", runtimeExecutable: "npm", runtimeArgs: ["run", script], port };
  }
  return { name: "app", runtimeExecutable: "python3", runtimeArgs: ["-m", "http.server", "5180"], port: 5180 };
}

async function add() {
  const out = { root: ROOT, entry: null, inserted: false, relayConfig: "relay", relayPort: 4400, appConfig: null, appPort: null, addedAppConfig: false, notes: [] };

  // 1. launch.json: relay entry (+ the app's own, if missing)
  const cfg = await readLaunch();
  const others = cfg.configurations.filter((c) => c.name !== "relay");
  const used = new Set(others.map((c) => c.port));
  out.relayPort = used.has(4400) ? 4401 : 4400;
  const relay = { name: "relay", runtimeExecutable: "node", runtimeArgs: [RELAY_BIN, "--port", String(out.relayPort)], port: out.relayPort };
  let app = others[0];
  if (!app) {
    app = await guessAppConfig();
    out.addedAppConfig = true;
    out.notes.push(`Added a guessed "app" dev-server config (${app.runtimeExecutable} ${app.runtimeArgs.join(" ")}, port ${app.port}); check it if the app doesn't open.`);
  }
  cfg.configurations = [...(out.addedAppConfig ? [app] : others), relay];
  await writeLaunch(cfg);
  out.appConfig = app.name;
  out.appPort = app.port;

  // 2. the toolbar snippet
  const found = [];
  for (const c of CANDIDATES) if (await exists(path.join(ROOT, c.file))) found.push(c);
  if (!found.length) {
    out.notes.push("No entry file found (Next.js layout/_document or index.html). Add the snippet by hand.");
    return out;
  }
  const entry = found[0];
  out.entry = entry.file;
  if (found.length > 1) out.notes.push(`Other possible entries: ${found.slice(1).map((c) => c.file).join(", ")}`);

  const file = path.join(ROOT, entry.file);
  let src = await read(file);
  if (src.includes(START)) {
    out.notes.push("Toolbar snippet already present.");
    // Keep the port in step with launch.json.
    src = src.replace(/localhost:44\d\d\/relay\.js/g, `localhost:${out.relayPort}/relay.js`);
    await fs.writeFile(file, src);
    return out;
  }

  const close = src.toLowerCase().lastIndexOf("</body>");
  if (entry.kind === "html") {
    const block = htmlBlock(out.relayPort);
    src = close >= 0 ? src.slice(0, close) + block + src.slice(close) : src + "\n" + block;
  } else {
    if (close < 0) {
      out.notes.push(`${entry.file} has no </body>; add the snippet by hand.`);
      return out;
    }
    const lineStart = src.lastIndexOf("\n", close) + 1;
    const indent = src.slice(lineStart, close).match(/^\s*/)[0] + "  ";
    src = src.slice(0, lineStart) + jsxBlock(out.relayPort, indent) + src.slice(lineStart);
    if (!/from\s+["']next\/script["']/.test(src)) {
      // After a leading "use client"/"use strict" directive if there is one.
      const directive = src.match(/^(\s*["']use [a-z]+["'];?\s*\n)/);
      const at = directive ? directive[0].length : 0;
      src = src.slice(0, at) + `import Script from "next/script"; // relay\n` + src.slice(at);
    }
  }
  await fs.writeFile(file, src);
  out.inserted = true;
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

function stripSnippet(src) {
  return src
    .replace(/[ \t]*<!-- relay:start -->[\s\S]*?<!-- relay:end -->\n?/g, "")
    .replace(/[ \t]*\{\/\* relay:start \*\/\}[\s\S]*?\{\/\* relay:end \*\/\}\n?/g, "")
    .replace(/^import Script from "next\/script"; \/\/ relay\n/m, "");
}

async function removeFrom(root) {
  const removed = [];
  for (const c of CANDIDATES) {
    const file = path.join(root, c.file);
    const src = await read(file);
    if (!src || !src.includes(START)) continue;
    await fs.writeFile(file, stripSnippet(src));
    removed.push(path.join(root, c.file));
  }
  const launch = path.join(root, ".claude", "launch.json");
  const text = await read(launch);
  let launchUpdated = false;
  if (text) {
    const cfg = JSON.parse(text);
    const before = cfg.configurations.length;
    cfg.configurations = cfg.configurations.filter((c) => c.name !== "relay");
    if (cfg.configurations.length !== before) {
      launchUpdated = true;
      if (cfg.configurations.length) await fs.writeFile(launch, JSON.stringify(cfg, null, 2) + "\n");
      else await fs.rm(launch);
    }
  }
  return { removed, launchUpdated };
}

async function off() {
  const out = { root: ROOT, removedFrom: [], launchUpdated: false, toolbarsHidden: 0, servers: [], found: false, notes: [] };
  const servers = await runningServers();
  out.servers = servers.map((s) => ({ port: s.port, root: s.root }));

  // 1. Take toolbars off open pages immediately.
  for (const s of servers) {
    try {
      const r = await fetch(`http://localhost:${s.port}/api/off`, { method: "POST", signal: AbortSignal.timeout(400) }).then((r) => r.json());
      out.toolbarsHidden += r.pages || 0;
    } catch {}
  }

  // 2. Remove the snippet + launch config: here, or wherever a running relay says it's serving.
  const roots = [ROOT];
  if (dirFlag < 0) for (const s of servers) if (!roots.includes(s.root)) roots.push(s.root);
  for (const root of roots) {
    const r = await removeFrom(root);
    out.removedFrom.push(...r.removed);
    out.launchUpdated ||= r.launchUpdated;
  }
  out.found = out.removedFrom.length > 0 || out.launchUpdated || servers.length > 0;

  const demo = path.resolve(path.dirname(RELAY_BIN), "../example");
  if (servers.some((s) => s.root === demo)) out.notes.push("relay's own demo adds the toolbar when it serves the page; stop `npm run demo` to turn it off for good.");
  if (!out.found) out.notes.push(`relay isn't set up in ${ROOT} and no relay server is running, so there was nothing to turn off.`);
  else out.notes.push("The <project>.relay/ canvas folder was left in place.");
  return out;
}

const run = { add, off }[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Use add or off.`);
  process.exit(1);
}
console.log(JSON.stringify(await run(), null, 2));
