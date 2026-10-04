#!/usr/bin/env node
// `npm run demo`: serves the example checklist app and starts relay next to it,
// with snapshots saved to example/example.relay/.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT || 5180);
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

const relay = spawn(process.execPath, [path.join(HERE, "../bin/relay.js"), "--dir", HERE], { stdio: "inherit" });
const stop = () => (relay.kill(), process.exit());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

http
  .createServer(async (req, res) => {
    const name = new URL(req.url, "http://x").pathname.slice(1) || "index.html";
    const type = TYPES[path.extname(name)];
    const body = type && !name.includes("/") ? await fs.readFile(path.join(HERE, name)).catch(() => null) : null;
    if (!body) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" }).end(body);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`checklist demo → http://localhost:${PORT}`));
