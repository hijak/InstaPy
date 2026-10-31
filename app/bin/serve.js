#!/usr/bin/env node
// Local control panel: serves web/index.html and a small JSON API on
// 127.0.0.1. No dependencies, no build step.
//   node bin/serve.js [--port 7788]
//
// Endpoints:
//   GET  /                    the UI
//   GET  /api/state           config + breaker + LLM + quotas + run + events tail
//   POST /api/config          validate + merge + save config.json
//   POST /api/run             start a session (dry-run by default)
//   POST /api/stop            kill the running session
//   POST /api/breaker/clear   clear the challenge circuit breaker
//   POST /api/llm/test        tiny live completion through the configured LLM
//   GET  /api/stream          SSE: run output, events, run lifecycle
import http from "node:http";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, isConfigured, complete } from "../src/llm.js";
import { loadState, todayCounts } from "../src/memory.js";
import { status as breakerStatus } from "../src/breaker.js";
import { dataFile } from "../src/log.js";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(appDir, "config.json");
const RUN_FILE = () => dataFile("run.json");
const EVENTS_FILE = () => dataFile("events.jsonl");

const port = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) || 7788 : 7788;
})();

// ---------------------------------------------------------------- helpers

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

const NUM_RANGES = {
  "session.maxViews": [1, 100],
  "session.maxLikes": [0, 50],
  "session.maxDurationMin": [5, 120],
  "daily.maxViews": [1, 300],
  "daily.maxLikes": [0, 100],
  "pacing.actionGapMedianMs": [1500, 120000],
  "pacing.dwellMedianMs": [1500, 300000],
  "pacing.sigma": [0.2, 1.5],
  "pacing.idleChance": [0, 0.3],
  "pacing.idleMedianMs": [10000, 600000],
  "pacing.idleMinMs": [5000, 300000],
  "pacing.idleMaxMs": [10000, 900000],
  "jev.escalateBelowConfidence": [0, 1],
  "breaker.challengeCooldownHours": [1, 336],
};
const STRING_LIMITS = {
  niche: 40,
  "jev.model": 80,
};

// Accept both nested ({daily: {maxLikes: 5}}) and flat ("daily.maxLikes") forms.
function flattenPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!k.includes(".") && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergeConfig(patchRaw) {
  const config = readConfig();
  for (const [key, value] of Object.entries(flattenPatch(patchRaw))) {
    if (key === "hashtags") {
      if (!Array.isArray(value)) throw new Error("hashtags must be an array");
      const tags = value.map((t) => String(t).replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean);
      if (tags.length > 10) throw new Error("at most 10 hashtags");
      config.hashtags = tags;
      continue;
    }
    if (key === "niche") {
      const niche = String(value).trim();
      if (!niche || niche.length > STRING_LIMITS.niche) throw new Error("niche must be 1-40 chars");
      config.niche = niche;
      continue;
    }
    if (NUM_RANGES[key]) {
      const [lo, hi] = NUM_RANGES[key];
      const n = Number(value);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${key} must be ${lo}-${hi}`);
      const [section, field] = key.split(".");
      config[section][field] = n;
      continue;
    }
    if (STRING_LIMITS[key]) {
      const s = String(value).trim();
      if (!s || s.length > STRING_LIMITS[key]) throw new Error(`${key} must be 1-${STRING_LIMITS[key]} chars`);
      const [section, field] = key.split(".");
      config[section][field] = s;
      continue;
    }
    throw new Error(`unknown or read-only config key: ${key}`);
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  return config;
}

function tailEvents(n = 120) {
  const f = EVENTS_FILE();
  if (!existsSync(f)) return [];
  const size = statSync(f).size;
  const read = Math.min(size, 128 * 1024);
  const fd = openSync(f, "r");
  try {
    const buf = Buffer.alloc(read);
    readSync(fd, buf, 0, read, size - read);
    return buf
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { ts: "?", type: "unparsed", raw: line.slice(0, 120) };
        }
      });
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------- run control

function currentRun() {
  try {
    const run = JSON.parse(readFileSync(RUN_FILE(), "utf8"));
    let running = false;
    try {
      process.kill(run.pid, 0);
      running = true;
    } catch (e) {
      running = e.code === "EPERM";
    }
    return { ...run, running };
  } catch {
    return null;
  }
}

const consoleBuffer = [];
const sseClients = new Set();
function broadcast(obj) {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function startRun(body) {
  if (currentRun()?.running) throw new Error("a session is already running");

  const args = [path.join(appDir, "bin", "session.js")];
  if (body.dry !== false) args.push("--dry");
  if (body.maxViews != null) {
    const n = Number(body.maxViews);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("maxViews 1-100");
    args.push("--max-views", String(n));
  }
  if (body.maxLikes != null) {
    const n = Number(body.maxLikes);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error("maxLikes 0-50");
    args.push("--max-likes", String(n));
  }
  if (body.tag) {
    const tag = String(body.tag).replace(/[^A-Za-z0-9_]/g, "");
    if (!tag) throw new Error("invalid tag");
    args.push("--tag", tag);
  }
  if (body.jitterMinutes != null) {
    const n = Number(body.jitterMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 120) throw new Error("jitterMinutes 0-120");
    args.push("--jitter-minutes", String(n));
  }

  const child = spawn(process.execPath, args, { cwd: appDir });
  const run = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    args: args.slice(1),
    dry: body.dry !== false,
  };
  writeFileSync(RUN_FILE(), JSON.stringify(run));
  record("run-start", run);

  child.stdout.on("data", (chunk) =>
    String(chunk)
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        consoleBuffer.push(line);
        if (consoleBuffer.length > 300) consoleBuffer.shift();
        broadcast({ kind: "out", line });
      })
  );
  child.stderr.on("data", (chunk) =>
    String(chunk)
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        consoleBuffer.push(`[err] ${line}`);
        if (consoleBuffer.length > 300) consoleBuffer.shift();
        broadcast({ kind: "out", line: `[err] ${line}` });
      })
  );
  child.on("exit", (code) => {
    broadcast({ kind: "run-end", code });
    try {
      rmSync(RUN_FILE());
    } catch {}
  });
  broadcast({ kind: "run-start", pid: child.pid });
  return run;
}

function stopRun() {
  const run = currentRun();
  if (!run?.running) throw new Error("no session running");
  try {
    process.kill(run.pid, "SIGTERM");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  return { stopped: run.pid };
}

// ------------------------------------------------------------ events tail

let eventsOffset = existsSync(EVENTS_FILE()) ? statSync(EVENTS_FILE()).size : 0;
function pumpNewEvents() {
  if (!existsSync(EVENTS_FILE())) return;
  const size = statSync(EVENTS_FILE()).size;
  if (size < eventsOffset) eventsOffset = 0; // rotated/truncated
  if (size === eventsOffset) return;
  const fd = openSync(EVENTS_FILE(), "r");
  try {
    const buf = Buffer.alloc(size - eventsOffset);
    readSync(fd, buf, 0, buf.length, eventsOffset);
    eventsOffset = size;
    for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        broadcast({ kind: "event", event: JSON.parse(line) });
      } catch {}
    }
  } finally {
    closeSync(fd);
  }
}
setInterval(pumpNewEvents, 1000);

function record(type, data) {
  // run lifecycle records land in the same JSONL log as everything else
  const f = EVENTS_FILE();
  try {
    appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
  } catch {}
}

// ------------------------------------------------------------------ state

function stateSnapshot() {
  const state = loadState();
  const config = readConfig();
  const today = todayCounts(state.events);
  return {
    config,
    breaker: breakerStatus(),
    llm: describe(),
    today,
    run: currentRun(),
    console: consoleBuffer.slice(-100),
    events: tailEvents(60),
  };
}

// ------------------------------------------------------------------ server

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(appDir, "web", "index.html")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  const body = await readBody(req);

  if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, 200, stateSnapshot());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/config") {
    try {
      json(res, 200, { ok: true, config: mergeConfig(body) });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/run") {
    try {
      json(res, 200, { ok: true, run: startRun(body) });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/stop") {
    try {
      json(res, 200, { ok: true, ...(stopRun() ?? {}) });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/breaker/clear") {
    try {
      rmSync(dataFile("breaker.json"), { force: true });
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/llm/test") {
    if (!isConfigured()) {
      json(res, 200, { ok: false, error: "no LLM configured (see app/llm.example.json)" });
      return;
    }
    try {
      const t0 = Date.now();
      const reply = await complete("Reply with exactly the word: ready", { maxTokens: 300 });
      json(res, 200, { ok: true, reply, ms: Date.now() - t0 });
    } catch (e) {
      json(res, 200, { ok: false, error: e.message.slice(0, 200) });
    }
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try {
      json(res, 500, { ok: false, error: e.message });
    } catch {}
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`instapy-reborn control panel: http://127.0.0.1:${port}`);
});
