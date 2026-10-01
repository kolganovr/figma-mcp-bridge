#!/usr/bin/env node
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const vm = require("vm");
const { optimizeFigmaData } = require("./optimizer");

const FIGMA_TOKEN = process.env.FIGMA_PERSONAL_ACCESS_TOKEN || process.env.FIGMA_API_KEY || "";

// ==========================================
// Figma Live Plugin Bridge (HTTP + WebSocket Server)
// ==========================================
const BRIDGE_PORT = parseInt(process.env.FIGMA_BRIDGE_PORT, 10) || 8765;

// ------------------------------------------------------------------
// Access control.
//
// /execute takes an arbitrary JS string and runs it inside the user's open
// Figma document. Bound to loopback that is still reachable by ANY web page the
// user happens to have open, so without these two gates a visited site could
// read, rewrite or delete their design (and open a WebSocket to impersonate the
// plugin). Two independent checks:
//
//   1. Origin allowlist — a browser cannot forge Origin, so a page on evil.com
//      is rejected outright. Figma's plugin iframe sends "null" or figma.com.
//   2. Shared token — install.mjs generates one, puts it in the MCP config env
//      and bakes the same value into the installed plugin UI. This also covers
//      the sandboxed-iframe case, where a hostile page can also present "null".
//
// With no token configured (running straight from a clone) the Origin gate
// still applies and a warning is printed, so the bridge degrades rather than
// silently becoming wide open.
// ------------------------------------------------------------------
const BRIDGE_TOKEN = (process.env.FIGMA_BRIDGE_TOKEN || "").trim();
const ALLOWED_ORIGINS = new Set(["null", "https://www.figma.com", "https://figma.com"]);

// A single frame must not be able to exhaust memory before we can reject it.
const MAX_WS_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

function isOriginAllowed(req) {
  const origin = req.headers["origin"];
  // Non-browser callers (our own proxy fetch, curl) send no Origin at all.
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin.toLowerCase());
}

function hasValidToken(req) {
  if (!BRIDGE_TOKEN) return true;
  const headerToken = req.headers["x-bridge-token"];
  if (typeof headerToken === "string" && headerToken === BRIDGE_TOKEN) return true;
  try {
    const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    return url.searchParams.get("token") === BRIDGE_TOKEN;
  } catch (e) {
    return false;
  }
}

function isAuthorized(req) {
  if (!isOriginAllowed(req)) return false;
  if (hasValidToken(req)) return true;
  noteRejectedPlugin(req);
  return false;
}

// ------------------------------------------------------------------
// Wrong plugin copy. Figma runs whichever manifest.json the user imported;
// only the copies install.mjs writes carry the bridge token, so a plugin that
// passes the Origin gate but brings no/another token is almost always the
// repository checkout imported by hand. Agents that only see "not connected"
// have "fixed" that by writing the token into the repo's ui.html — so the
// rejection is remembered and the connect error names the real fix.
// ------------------------------------------------------------------
const INSTALLED_PLUGIN_MANIFEST = path.join(__dirname, "..", "figma-plugin", "manifest.json");
let lastRejectedPlugin = null; // { at, tokenless }
let lastRejectLogAt = 0;

function presentedToken(req) {
  const header = req.headers && req.headers["x-bridge-token"];
  if (typeof header === "string" && header) return header;
  try {
    return new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`).searchParams.get("token") || "";
  } catch (e) {
    return "";
  }
}

function noteRejectedPlugin(req) {
  const tokenless = !presentedToken(req);
  lastRejectedPlugin = { at: Date.now(), tokenless };
  if (Date.now() - lastRejectLogAt > 60000) {
    lastRejectLogAt = Date.now();
    console.error("[Figma MCP Bridge] " + wrongPluginCopyMessage(lastRejectedPlugin));
  }
}

function wrongPluginCopyMessage(rejected) {
  const ago = Math.max(0, Math.round((Date.now() - rejected.at) / 1000));
  return `A Figma plugin tried to connect ${ago}s ago and was REJECTED: it brought ` +
    (rejected.tokenless ? "no bridge token" : "a different bridge token") +
    ", so Figma is running a plugin copy install.mjs did not produce (typically this repository's figma-plugin/ imported directly" +
    (rejected.tokenless ? "" : ", or a copy from an older install") +
    `).\n\nHINT: the user fixes it once: Figma → Plugins → Development → Import plugin from manifest… → ${INSTALLED_PLUGIN_MANIFEST}, then remove the old "Antigravity Bridge" entry. ` +
    "Do NOT write the token into ui.html or any other source file — it would leak into the repository.";
}

function recentlyRejectedPlugin() {
  return lastRejectedPlugin && Date.now() - lastRejectedPlugin.at < 10 * 60 * 1000 ? lastRejectedPlugin : null;
}

// Commands queue instead of overwriting a single slot: two tool calls issued
// while the plugin is offline used to clobber each other, and the loser only
// surfaced as a timeout 40s later.
const pendingCommands = [];
let commandResolvers = new Map();
let lastPluginPing = 0;
const wsClients = new Set();

// One place instead of four different literals (40000 / 45000 / 30000 / 35000)
// scattered across handleCallTool. `escalate` is how long a synchronous
// figma_execute_code call is allowed to block before it is handed back to the
// agent as a background job instead of failing outright — see the Job Ledger
// below and SERVER_VERSION.
function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// `escalate` went 30s -> 45s: every escalation costs the agent at least one
// extra figma_job_status turn, and each turn re-reads the WHOLE conversation.
// 45s still sits under the ~60s tool-call timeout of the strictest MCP clients.
const TIMEOUTS = {
  fast: envNumber("FIGMA_MCP_TIMEOUT_FAST_MS", 15000),
  normal: envNumber("FIGMA_MCP_TIMEOUT_MS", 45000),
  heavy: envNumber("FIGMA_MCP_TIMEOUT_HEAVY_MS", 120000),
  escalate: envNumber("FIGMA_MCP_ESCALATE_MS", 45000)
};
const SERVER_VERSION = "4.2.3";

// ------------------------------------------------------------------
// Token economy. In an agent loop the price of a tool call is not its own
// output — it is the whole context re-read on the NEXT turn, and everything a
// call returns stays in that context until the session ends. So the defaults
// below optimise for: fewer turns (long-poll jobs, wait out a plugin reload),
// smaller images (tokens scale with pixels, not bytes), and bounded text.
// Every knob is overridable per call and per install (env).
// ------------------------------------------------------------------
const ECONOMY = {
  scale: envNumber("FIGMA_MCP_SCALE", 1),                        // screenshot scale when the caller passes none
  maxPx: envNumber("FIGMA_MCP_MAX_PX", 1024),                    // longest image side; ~1k tokens at 1024x1024
  maxImages: envNumber("FIGMA_MCP_MAX_IMAGES", 4),               // images per tool response (the plugin sends up to 4 downscaled ones)
  // Text budget for a whole tool response, in UTF-8 BYTES — not chars: some
  // clients spill any tool output over ~4 KB into a file the model then has to
  // open with a second tool call (Antigravity does, measured at ~4.1 KB), and
  // Cyrillic/CJK text is 2-3 bytes per char, so a 6000-char cap spilled
  // constantly. 3500 stays under that with room for the envelope.
  maxOutputBytes: envNumber("FIGMA_MCP_MAX_OUTPUT_BYTES", envNumber("FIGMA_MCP_MAX_OUTPUT_CHARS", 3500)),
  // Hard ceiling for a REQUESTED max_output_bytes: a model that saw a cut and
  // asked for 5000 got a reply over Antigravity's ~4.1 KB spill limit, which
  // was written to a file (an extra turn). Applies to max_output_bytes: 0 too.
  // Without the env var it is on for every client except the ones known not
  // to spill (see clientSpillsOutput); 0 in the env = never, N = always N.
  outputCeiling: envNumber("FIGMA_MCP_MAX_OUTPUT_CEILING", 3900),
  outputCeilingFromEnv: Number.isFinite(Number(process.env.FIGMA_MCP_MAX_OUTPUT_CEILING)) && process.env.FIGMA_MCP_MAX_OUTPUT_CEILING !== "",
  jobWaitMs: envNumber("FIGMA_MCP_JOB_WAIT_MS", 45000),          // how long figma_job_status blocks by default
  jobWaitMaxMs: 55000,                                           // keep under ~60s client tool timeouts
  reconnectGraceMs: envNumber("FIGMA_MCP_RECONNECT_GRACE_MS", 8000), // wait for a reloading plugin instead of failing
  stalledAfterMs: 120000                                         // no progress for this long => report as stalled
};

// ------------------------------------------------------------------
// Job Ledger — makes a figma_execute_code call that runs long survive its own
// synchronous wait window instead of the caller's promise just rejecting while
// the plugin keeps working. Every command gets an entry (cheap: a plain
// object); most are read once and evicted quickly by the LRU cap below. Only
// commands that actually run past TIMEOUTS.escalate are ever surfaced to the
// agent as a job_id via figma_job_status — see sendCommandToPlugin().
// ------------------------------------------------------------------
const jobs = new Map();
const JOBS_MAX = 200;
const jobWaiters = new Map(); // job id -> Set<fn>, woken when the job leaves "running"

function touchJob(id, patch) {
  let job = jobs.get(id);
  if (!job) {
    job = { id, status: "running", progress: [], result: undefined, error: null, clientId: null, createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    if (jobs.size > JOBS_MAX) {
      const oldestKey = jobs.keys().next().value;
      if (oldestKey !== id) jobs.delete(oldestKey);
    }
  }
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (job.status !== "running") wakeJobWaiters(id);
  return job;
}

function wakeJobWaiters(id) {
  const set = jobWaiters.get(id);
  if (!set) return;
  jobWaiters.delete(id);
  for (const fn of set) { try { fn(); } catch (e) {} }
}

// Resolves when the job finishes or `ms` elapses, whichever comes first — the
// long-poll behind figma_job_status. One blocking call replaces the 5-10
// "still running" polls an agent otherwise burns, each re-reading its whole
// context.
function waitForJob(id, ms) {
  const job = jobs.get(id);
  if (!job || job.status !== "running" || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    let set = jobWaiters.get(id);
    if (!set) { set = new Set(); jobWaiters.set(id, set); }
    const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

// Result of a command whose caller is still blocked on it is handed straight
// to that caller and NOT kept: the ledger used to retain every result
// (screenshots included) for the last 200 commands. Only escalated commands —
// the ones nobody is waiting on synchronously any more — keep theirs for
// figma_job_status.
// Where in the agent's code a failure happened (the plugin sends line/column/at
// for runtime errors, this server for syntax errors); {} when unknown.
function errorLocation(src) {
  const loc = {};
  if (!src) return loc;
  if (Number.isFinite(Number(src.line)) && src.line !== null && src.line !== "") loc.line = Number(src.line);
  if (Number.isFinite(Number(src.column)) && src.column !== null && src.column !== "") loc.column = Number(src.column);
  if (typeof src.at === "string" && src.at) loc.at = src.at;
  return loc;
}

function settleCommand(data) {
  const resolver = commandResolvers.get(data.id);
  const patch = {
    status: data.success === false ? "error" : "done",
    result: data.success === false ? undefined : data,
    error: data.success === false ? (data.error || "Execution failed in Figma sandbox") : null,
    code: data.code || null,
    ...(data.success === false ? errorLocation(data) : {})
  };
  if (resolver) {
    commandResolvers.delete(data.id);
    touchJob(data.id, { ...patch, result: undefined });
    jobs.delete(data.id);
    resolver(data);
  } else {
    touchJob(data.id, patch);
  }
}

// The Figma sandbox runs plugin code on one thread: a heavy call blocks every
// later one. Knowing what is still running on a client turns a bare timeout
// into "wait for job X" instead of a retry loop. Only commands that started
// BEFORE the timed-out one can be what blocked it.
function findBusyJob(clientId, exceptId, startedBefore) {
  let busiest = null;
  for (const job of jobs.values()) {
    if (job.status !== "running" || job.id === exceptId) continue;
    if (clientId && job.clientId && job.clientId !== clientId) continue;
    if (startedBefore && job.createdAt > startedBefore) continue;
    if (!busiest || job.createdAt < busiest.createdAt) busiest = job;
  }
  return busiest;
}

// A plugin that disconnects (reload, Figma closed) will never answer what it
// was running. Fail those now instead of letting callers and pollers wait out
// their full timeouts.
function failCommandsOfClient(clientId) {
  for (const job of jobs.values()) {
    if (job.status !== "running" || job.clientId !== clientId) continue;
    const data = {
      id: job.id,
      success: false,
      code: "PLUGIN_DISCONNECTED",
      error: "The Figma plugin disconnected while this command was running, so its result is lost. " +
             "It may or may not have finished: check the canvas with one cheap read before running it again."
    };
    settleCommand(data);
  }
}

// Wakes callers parked in waitForClient() the moment a plugin (re)connects.
const clientWaiters = new Set();
function wakeClientWaiters() {
  for (const fn of Array.from(clientWaiters)) { try { fn(); } catch (e) {} }
}
function waitForClient(ms) {
  if (wsClients.size > 0 || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); clientWaiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    clientWaiters.add(done);
  });
}

// Encode unmasked text frame (Server -> Client) as per RFC 6455
function encodeWsFrame(data) {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data), "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function handleWsUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  if (!isAuthorized(req)) {
    // Refuse before the handshake so a hostile page never gets a live socket.
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n");

  socket.write(responseHeaders);

  const client = {
    id: "ws_" + Math.random().toString(36).substring(2, 9),
    socket,
    lastSeen: Date.now(),
    buffer: Buffer.alloc(0),
    // Reassembly state for fragmented messages (FIN=0 + continuation frames).
    fragments: [],
    fragmentOpcode: 0,
    fragmentBytes: 0,
    // Target Router identity — filled in by CLIENT_READY/CLIENT_FOCUS once the
    // plugin reports it. Defaults to focused=true so a single connected
    // document (the overwhelmingly common case) needs no handshake to route.
    focused: true,
    fileKey: null,
    fileName: null,
    pageName: null,
    pluginVersion: null,
    send(msg) {
      try {
        if (socket.writable) {
          socket.write(encodeWsFrame(msg));
        }
      } catch (e) {}
    }
  };

  wsClients.add(client);
  lastPluginPing = Date.now();

  // Flush everything queued while nothing was connected (0ms dispatch).
  while (pendingCommands.length > 0) {
    const queued = pendingCommands.shift();
    const job = jobs.get(queued.id);
    if (job && job.status === "running") job.clientId = client.id;
    client.send(queued);
  }
  wakeClientWaiters();

  socket.on("data", (chunk) => {
    client.lastSeen = Date.now();
    lastPluginPing = Date.now();
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (client.buffer.length >= 2) {
      const byte0 = client.buffer[0];
      const byte1 = client.buffer[1];
      const isFinal = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const isMasked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < 4) break;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) break;
        payloadLen = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > MAX_WS_MESSAGE_BYTES) {
        console.error(`[Figma MCP Bridge] Dropping oversized WebSocket frame (${payloadLen} bytes).`);
        socket.destroy();
        cleanupClient();
        return;
      }

      let maskKey = null;
      if (isMasked) {
        if (client.buffer.length < offset + 4) break;
        maskKey = client.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (client.buffer.length < offset + payloadLen) {
        break; // Wait for full frame
      }

      const payload = client.buffer.slice(offset, offset + payloadLen);
      client.buffer = client.buffer.slice(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        // Close frame
        socket.end();
        cleanupClient();
        break;
      } else if (opcode === 0x9) {
        // Ping frame -> reply with Pong
        if (socket.writable) {
          socket.write(Buffer.from([0x8a, 0x00]));
        }
      } else if (opcode === 0xa) {
        // Pong — liveness only, already recorded via lastSeen above.
      } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        // Data frame. A large screenshot can arrive split across a FIN=0 frame
        // plus continuation frames; treating each fragment as a whole message
        // silently dropped it and the tool call timed out 40s later.
        if (opcode !== 0x0) {
          client.fragments = [];
          client.fragmentBytes = 0;
          client.fragmentOpcode = opcode;
        }

        client.fragments.push(payload);
        client.fragmentBytes += payload.length;

        if (client.fragmentBytes > MAX_WS_MESSAGE_BYTES) {
          console.error(`[Figma MCP Bridge] Dropping oversized fragmented message (${client.fragmentBytes} bytes).`);
          socket.destroy();
          cleanupClient();
          return;
        }

        if (isFinal) {
          const full = client.fragments.length === 1 ? client.fragments[0] : Buffer.concat(client.fragments);
          client.fragments = [];
          client.fragmentBytes = 0;
          if (client.fragmentOpcode === 0x1) {
            try {
              handleClientMessage(client, JSON.parse(full.toString("utf8")));
            } catch (err) {}
          }
        }
      }
    }
  });

  const cleanupClient = () => {
    if (!wsClients.has(client)) return; // close/end/error can all fire for one socket
    wsClients.delete(client);
    failCommandsOfClient(client.id);
  };
  socket.on("close", cleanupClient);
  socket.on("end", cleanupClient);
  socket.on("error", cleanupClient);
}

function handleClientMessage(client, data) {
  if (!data) return;
  client.lastSeen = Date.now();
  lastPluginPing = Date.now();

  if (data.type === "PING") {
    client.send({ type: "PONG" });
    return;
  }

  // Target Router — every other connected client loses focus the moment one
  // reports it, so "the window the user is looking at" is always at most one
  // client, matching what the plugin's own focus/blur listeners see.
  if (data.type === "CLIENT_FOCUS" || data.type === "CLIENT_READY") {
    for (const c of wsClients) c.focused = false;
    client.focused = true;
    if (data.fileKey !== undefined) client.fileKey = data.fileKey;
    if (data.fileName !== undefined) client.fileName = data.fileName;
    if (data.pageName !== undefined) client.pageName = data.pageName;
    if (data.pluginVersion !== undefined) client.pluginVersion = data.pluginVersion;
    return;
  }

  if (data.type === "PAGE_CHANGED") {
    if (data.pageName !== undefined) client.pageName = data.pageName;
    return;
  }

  if (data.type === "PROGRESS" && data.id) {
    const job = touchJob(data.id, {});
    job.progress.push({ step: data.step, of: data.of, note: data.note, ts: data.ts || Date.now() });
    if (job.progress.length > 50) job.progress.shift();
    return;
  }

  if (data.id) {
    // Goes to the blocked caller if there still is one, otherwise into the job
    // ledger — a call that already escalated past TIMEOUTS.escalate has
    // nothing left in commandResolvers, but figma_job_status needs to see it.
    settleCommand(data);
  }
}

// Reads a request body with a hard ceiling, so a hostile or runaway client
// cannot grow an unbounded string in memory.
function readBody(req, limit = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const bridgeServer = http.createServer((req, res) => {
  // CORS is echoed back only for origins we actually trust — "*" turned every
  // page the user visits into a client of /execute.
  const origin = req.headers["origin"];
  if (origin && ALLOWED_ORIGINS.has(origin.toLowerCase())) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(isOriginAllowed(req) ? 204 : 403);
    return res.end();
  }

  // The query string now carries ?token=, so route on the pathname alone.
  let pathname = req.url || "/";
  const queryStart = pathname.indexOf("?");
  if (queryStart !== -1) pathname = pathname.substring(0, queryStart);

  if (!isAuthorized(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: "Forbidden: the Figma bridge only accepts requests from the Antigravity Bridge plugin. " +
             "If you are the plugin, make sure install.mjs baked the matching bridge token into it."
    }));
  }

  // HTTP Long-Polling Fallback
  if (pathname === "/poll" && req.method === "GET") {
    lastPluginPing = Date.now();
    if (pendingCommands.length > 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(pendingCommands.shift()));
    }

    let idleTimer = null;
    const checkInterval = setInterval(() => {
      if (pendingCommands.length > 0) {
        clearInterval(checkInterval);
        clearTimeout(idleTimer);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(pendingCommands.shift()));
      }
    }, 100);

    idleTimer = setTimeout(() => {
      clearInterval(checkInterval);
      if (!res.writableEnded) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "idle" }));
      }
    }, 10000);

    // A client that hangs up mid-poll must not leave the interval spinning.
    req.on("close", () => {
      clearInterval(checkInterval);
      clearTimeout(idleTimer);
    });
    return;
  }

  if (pathname === "/result" && req.method === "POST") {
    readBody(req).then((body) => {
      try {
        const data = JSON.parse(body);
        // Same path as a WebSocket result: this used to bypass the job ledger,
        // so an escalated job from an HTTP-polling plugin never finished.
        if (data && data.id) settleCommand(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch((err) => {
      if (res.writableEnded) return;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (pathname === "/execute" && req.method === "POST") {
    readBody(req).then(async (body) => {
      try {
        const payload = JSON.parse(body);
        const timeoutMs = payload.timeoutMs || 45000;
        const escalateMs = payload.escalateMs;
        delete payload.timeoutMs;
        delete payload.escalateMs;
        // A proxy's call escalates here, in the master that owns the job
        // ledger, so its figma_job_status (forwarded to /job) can find it.
        const result = await sendCommandToPlugin(payload, timeoutMs, escalateMs ? { escalateMs } : {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message, code: err.code || null, ...errorLocation(err) }));
      }
    }).catch((err) => {
      if (res.writableEnded) return;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // Job long-poll for proxies: the ledger only exists in the master process.
  if (pathname === "/job" && req.method === "GET") {
    const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    readJobSnapshot(url.searchParams.get("id"), Number(url.searchParams.get("wait_ms")) || 0)
      .then((snap) => {
        if (res.writableEnded) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snap));
      })
      .catch((err) => {
        if (res.writableEnded) return;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (pathname === "/status") {
    const isOnline = wsClients.size > 0 || (Date.now() - lastPluginPing) < 60000;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      connected: isOnline,
      wsClients: wsClients.size,
      lastPing: lastPluginPing,
      serverVersion: SERVER_VERSION,
      targets: listTargets()
    }));
  }

  res.writeHead(404);
  res.end();
});

// Attach WebSocket Upgrade Handler
bridgeServer.on("upgrade", (req, socket, head) => {
  const upgradeHeader = (req.headers["upgrade"] || "").toLowerCase();
  if (upgradeHeader === "websocket") {
    handleWsUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

let isBridgeMaster = false;
let listenAttemptInFlight = false;

bridgeServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    isBridgeMaster = false;
    listenAttemptInFlight = false;
    console.error(`[Figma MCP Bridge] Port ${BRIDGE_PORT} is already in use. Forwarding commands to existing bridge instance.`);
  } else {
    console.error(`[Figma MCP Bridge] Server error:`, err);
  }
});

// Multiple agents (Antigravity, Claude Desktop, Cursor, ...) each spawn their own
// copy of this server; the first one to bind :8765 owns the plugin socket and the
// rest proxy to it. When the owner exits, one of the proxies has to be able to
// take the port over — previously `isBridgeMaster` was latched to false forever,
// so every surviving agent stayed permanently broken until it was restarted.
function tryBecomeMaster() {
  if (isBridgeMaster || listenAttemptInFlight) return;
  listenAttemptInFlight = true;
  try {
    bridgeServer.listen(BRIDGE_PORT, "127.0.0.1", () => {
      isBridgeMaster = true;
      listenAttemptInFlight = false;
      if (!BRIDGE_TOKEN) {
        console.error(
          "[Figma MCP Bridge] WARNING: no FIGMA_BRIDGE_TOKEN configured. " +
          "Only the Origin allowlist is protecting :8765 — re-run install.mjs to provision a token."
        );
      }
    });
  } catch (e) {
    listenAttemptInFlight = false;
  }
}

// Side effects live here, not at module load, so tests can require() this
// file for its pure helpers without binding a port — see the bottom of file.
function startBridge() {
  tryBecomeMaster();

  // Cheap safety net for the case where the owner dies while this process is idle.
  const masterWatchdog = setInterval(tryBecomeMaster, 5000);
  if (masterWatchdog.unref) masterWatchdog.unref();

  const cleanup = () => {
    try { bridgeServer.close(); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.on("close", cleanup);
}

// Target Router — picks WHICH connected Figma document a command goes to.
// `targetFileName`, when given, filters to clients reporting that fileName and
// throws TARGET_NOT_FOUND if none match. Otherwise: the single connected
// client wins outright; among several, the focused one wins; several
// simultaneously "focused" (a focus message crossed in flight) breaks the tie
// by recency; several connected and NONE focused is genuinely ambiguous and
// throws AMBIGUOUS_TARGET rather than silently guessing wrong, which is what
// sorting by lastSeen alone used to do (a PING updates lastSeen too, so it
// wasn't even reliably tracking real focus).
function listTargets() {
  return Array.from(wsClients).map(c => ({
    id: c.id,
    fileName: c.fileName || null,
    pageName: c.pageName || null,
    pluginVersion: c.pluginVersion || null,
    focused: !!c.focused,
    lastSeenMsAgo: Date.now() - c.lastSeen
  }));
}

function pickTargetClient(targetFileName) {
  const clients = Array.from(wsClients);
  if (clients.length === 0) return null;

  let pool = clients;
  if (targetFileName) {
    const wanted = String(targetFileName).toLowerCase();
    const matched = clients.filter(c => (c.fileName || "").toLowerCase() === wanted);
    if (matched.length === 0) {
      const available = clients.map(c => c.fileName || "(unnamed)").join(", ") || "(none connected)";
      const err = new Error(`No connected Figma document named "${targetFileName}". Currently open: ${available}. Call figma_list_targets to check.`);
      err.code = "TARGET_NOT_FOUND";
      throw err;
    }
    pool = matched;
  }

  if (pool.length === 1) return pool[0];

  const focused = pool.filter(c => c.focused);
  if (focused.length === 1) return focused[0];
  if (focused.length > 1) return focused.sort((a, b) => b.lastSeen - a.lastSeen)[0];

  if (!targetFileName) {
    const err = new Error(
      `${pool.length} Figma documents are connected and none is focused (${pool.map(c => c.fileName || "(unnamed)").join(", ")}). ` +
      `Click into the intended Figma window, or pass target: "<fileName>" — see figma_list_targets.`
    );
    err.code = "AMBIGUOUS_TARGET";
    throw err;
  }
  return pool.sort((a, b) => b.lastSeen - a.lastSeen)[0];
}

// `options.target` routes to a specific connected document (Target Router).
// `options.escalateMs`, when set and shorter than timeoutMs, converts a call
// that is STILL running at that point into a background job instead of
// blocking (or eventually rejecting) the caller — see the Job Ledger above
// and figma_job_status. Every other call site keeps today's plain
// resolve/reject-on-timeout behaviour by simply not passing it.
async function sendCommandToPlugin(payload, timeoutMs = 45000, options = {}) {
  if (!isBridgeMaster) {
    return proxyToMaster("/execute", {
      method: "POST",
      body: { ...payload, timeoutMs, ...(options.escalateMs ? { escalateMs: options.escalateMs } : {}) },
      // The master enforces timeoutMs/escalateMs itself; this is only the
      // outer bound, so a slow-but-healthy call is not cut short by the hop.
      timeoutMs: (options.escalateMs ? Math.min(options.escalateMs, timeoutMs) : timeoutMs) + 5000
    });
  }

  let targetClient = pickTargetClient(payload.target);

  // A plugin that was connected recently is most likely reloading
  // (Ctrl+Alt+P, Figma tab switch, a server restart). Waiting a few seconds
  // for it to come back is far cheaper than failing: a failure costs the
  // agent a turn to read the error, and usually a list_targets + retry turn.
  if (!targetClient && wsClients.size === 0 && lastPluginPing > 0 &&
      (Date.now() - lastPluginPing) < 10 * 60 * 1000 && ECONOMY.reconnectGraceMs > 0) {
    await waitForClient(ECONOMY.reconnectGraceMs);
    targetClient = pickTargetClient(payload.target);
  }

  // Fail-Fast: with zero WS clients AND no recent /poll heartbeat, no plugin
  // is realistically going to show up before the hard timeout — queuing the
  // command and waiting the full 45s (until the caller gives up) just makes
  // every live tool call look hung. Bail immediately with an actionable error
  // instead. A poll-based client that pinged inside the last 60s still gets
  // the benefit of the doubt and the command is queued normally.
  if (!targetClient && (Date.now() - lastPluginPing) >= 60000) {
    const rejected = recentlyRejectedPlugin();
    if (rejected) {
      const err = new Error("No Figma plugin is connected to the bridge. " + wrongPluginCopyMessage(rejected));
      err.code = "PLUGIN_TOKEN_REJECTED";
      throw err;
    }
    const err = new Error(
      "No Figma plugin is connected to the bridge. Ask the user to open Figma DESKTOP (not the browser) and launch the Antigravity Bridge plugin (Ctrl+Alt+P / Cmd+Option+P) until the status shows CONNECTED, then retry."
    );
    err.code = "NO_CONNECTED_CLIENTS";
    throw err;
  }

  const cmdPayload = { ...payload };
  delete cmdPayload.target;

  return new Promise((resolve, reject) => {
    const id = "cmd_" + Math.random().toString(36).substring(2, 9);
    const cmd = { id, ...cmdPayload };
    const clientId = targetClient ? targetClient.id : null;
    let escalateTimer = null;

    // Ledger entry from the very start: elapsed_ms used to count from the
    // moment of escalation, and "what else is running on this plugin" (see
    // findBusyJob) needs in-flight commands, not just escalated ones.
    const startedAt = touchJob(id, { clientId, kind: cmdPayload.type || "EXECUTE", description: cmdPayload.description || null }).createdAt;

    const hardTimer = setTimeout(() => {
      commandResolvers.delete(id);
      const queuedAt = pendingCommands.findIndex(c => c.id === id);
      if (queuedAt !== -1) pendingCommands.splice(queuedAt, 1);
      jobs.delete(id);
      const busy = findBusyJob(clientId, id, startedAt);
      let err;
      if (busy) {
        err = new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s: the plugin is still busy with ${busy.id}` +
          `${busy.description ? ` ("${busy.description}")` : ""}, running for ${Math.round((Date.now() - busy.createdAt) / 1000)}s. ` +
          `Figma runs plugin code on a single thread, so retrying now will time out again — ` +
          `wait for it with figma_job_status({ job_id: "${busy.id}" }) first.`
        );
        err.code = "PLUGIN_BUSY";
      } else {
        err = new Error("Timeout waiting for Figma Plugin response. Ensure Figma is active and Antigravity Bridge plugin is running.");
        err.code = "BRIDGE_OFFLINE";
      }
      reject(err);
    }, timeoutMs);

    if (options.escalateMs && options.escalateMs < timeoutMs) {
      escalateTimer = setTimeout(() => {
        if (!commandResolvers.has(id)) return; // already settled through the normal path
        commandResolvers.delete(id);
        clearTimeout(hardTimer);
        touchJob(id, {}); // ensure a ledger entry exists even if no PROGRESS frame ever arrived
        resolve({ __escalated: true, job_id: id, elapsed_ms: options.escalateMs });
      }, options.escalateMs);
    }

    commandResolvers.set(id, (response) => {
      clearTimeout(hardTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      if (response.success) {
        resolve(response);
      } else {
        const err = new Error(response.error || "Execution failed in Figma sandbox");
        if (response.code) err.code = response.code;
        Object.assign(err, errorLocation(response));
        reject(err);
      }
    });

    // 1. Direct WebSocket Push (0ms latency)
    if (targetClient) {
      targetClient.send(cmd);
    } else {
      // 2. Queue for incoming WebSocket connection or HTTP long-poll
      pendingCommands.push(cmd);
    }
  });
}

// One hop to the process that owns :8765 (see tryBecomeMaster). A zombie
// master (still bound but wedged — stale after `install.mjs --update`, or a
// crashed event loop) never refuses the connection, it just hangs. The old
// guard capped EVERY proxied call at 10s, which also killed healthy long
// calls and made the proxy "take over" a port that was never free — two
// wasted agent turns per heavy call. Now a /status probe at the 10s mark
// decides: answered => master alive, keep waiting; silent => zombie, abort.
async function proxyToMaster(pathname, { method = "GET", body, timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  let zombie = false;
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const probeTimer = setTimeout(async () => {
    try {
      const probe = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/status`, {
        headers: BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {},
        signal: AbortSignal.timeout(2500)
      });
      if (!probe.ok) throw new Error("status " + probe.status);
    } catch (e) {
      zombie = true;
      controller.abort();
    }
  }, Math.min(10000, timeoutMs));

  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text();
      let detail = errText;
      let code = null;
      let loc = {};
      try {
        const parsed = JSON.parse(errText);
        detail = parsed.error || errText;
        code = parsed.code || null;
        loc = errorLocation(parsed);
      } catch (e) {}
      // A 500 from /execute is the master relaying a real tool failure
      // (NO_CONNECTED_CLIENTS, a sandbox error...) — pass it through as-is.
      const err = new Error(res.status === 500 ? detail : `Bridge proxy error (HTTP ${res.status}): ${detail}`);
      if (code) err.code = code;
      Object.assign(err, loc);
      throw err;
    }
    const data = await res.json();
    if (pathname !== "/execute" || data.success || data.__escalated) return data;
    const err = new Error(data.error || "Execution failed in Figma sandbox");
    if (data.code) err.code = data.code;
    Object.assign(err, errorLocation(data));
    throw err;
  } catch (err) {
    // The owner of :8765 is gone, or alive but wedged — claim the port
    // ourselves so the NEXT call succeeds instead of failing forever.
    const cause = err && err.cause ? err.cause.code : null;
    const aborted = err && err.name === "AbortError";
    if (zombie || cause === "ECONNREFUSED" || cause === "ECONNRESET" || /fetch failed/i.test(err.message || "")) {
      tryBecomeMaster();
      const wrapped = new Error(
        zombie
          ? "The bridge instance that owned :8765 stopped responding. This server is taking the port over — retry the call."
          : "The bridge instance that owned :8765 is no longer running. This server is taking the port over — retry the call."
      );
      wrapped.code = "BRIDGE_OFFLINE";
      throw wrapped;
    }
    if (aborted) {
      const wrapped = new Error("Timeout waiting for Figma Plugin response. Ensure Figma is active and Antigravity Bridge plugin is running.");
      wrapped.code = "BRIDGE_OFFLINE";
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(probeTimer);
  }
}

// Shared by figma_job_status (master) and GET /job (what proxies call).
// Blocks up to waitMs for the job to finish; a finished job is read once and
// forgotten so the ledger does not keep screenshots alive.
async function readJobSnapshot(id, waitMs) {
  const waitStart = Date.now();
  await waitForJob(id, Math.min(Math.max(0, waitMs || 0), ECONOMY.jobWaitMaxMs));
  const job = jobs.get(id);
  if (!job) {
    return {
      ok: false, code: "JOB_NOT_FOUND",
      error: `No job "${id}". A job is forgotten once read after finishing, or after ~${JOBS_MAX} newer jobs have been created.`
    };
  }
  if (job.status === "running") {
    const lastProgress = job.progress.length ? job.progress[job.progress.length - 1].ts : 0;
    const quietMs = Date.now() - Math.max(job.createdAt, lastProgress || 0);
    const snap = {
      ok: true, status: "running", job_id: job.id,
      elapsed_ms: Date.now() - job.createdAt,
      waited_ms: Date.now() - waitStart
    };
    if (job.progress.length) snap.progress = job.progress.slice(-3);
    if (quietMs > ECONOMY.stalledAfterMs) {
      snap.stalled = true;
      snap.hint = `No result or progress for ${Math.round(quietMs / 1000)}s. The Figma plugin is probably frozen on a heavy operation — ask the user to check Figma (or reload the plugin) instead of polling again.`;
    }
    return snap;
  }
  jobs.delete(job.id);
  if (job.status === "error") return { ok: false, status: "error", job_id: job.id, code: job.code, error: job.error, ...errorLocation(job) };
  return { ok: true, status: "done", job_id: job.id, response: job.result };
}

// ==========================================
// Figma REST API Helpers
// ==========================================
function parseFigmaUrlOrKey(input) {
  if (!input) return { fileKey: null, nodeId: null };
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/[^?#]*)?(?:\?[^#]*node-id=([a-zA-Z0-9%:-]+))?/);
  if (urlMatch) {
    let nodeId = urlMatch[2] ? decodeURIComponent(urlMatch[2]).replace(/-/g, ":") : null;
    return { fileKey: urlMatch[1], nodeId: nodeId };
  }
  return { fileKey: trimmed, nodeId: null };
}

async function figmaApiRequest(endpoint, options = {}) {
  if (!FIGMA_TOKEN) {
    throw new Error("FIGMA_PERSONAL_ACCESS_TOKEN is required for Figma Cloud REST API calls. Provide your token in the MCP configuration.");
  }
  const url = `https://api.figma.com/v1${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-Figma-Token": FIGMA_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Figma API error (${response.status} ${response.statusText}): ${errorBody}`);
  }

  return await response.json();
}

// ==========================================
// Tool Definitions & Handler
// ==========================================
const TOOLS = [
  // 1. Live Canvas Tools
  {
    name: "figma_execute_code",
    // Kept short, but the few rules that decide how many turns a task takes
    // live HERE, not only in SERVER_INSTRUCTIONS: some clients never show a
    // server's instructions to the model (Antigravity sessions made 0 bridge.*
    // calls in ~220 figma_execute_code runs), while tool descriptions always
    // reach it. The long-form contract stays in instructions + bridge.info().
    description: "WRITE tool: run JavaScript in the open Figma document (Figma Desktop + 'Antigravity Bridge' plugin) to create, edit, move, style or delete nodes. To READ (explore a section, list children, find layers, check texts / fonts / variants / table columns) call figma_inspect instead: every id in one call, one line per node, view:\"table\" for tables; a read script here costs a model turn per question and its reply names the figma_inspect call to use (use_instead). Every call is a full model turn, so make the whole change in ONE call — all screens / breakpoints, verified in the same code with bridge.check — and put capture_node_ids on that same call instead of a separate figma_screenshot. Globals: `figma`, `await ensureFont(family, style)`, `getFreePosition(w, h)`, `bridge`: bridge.check({ '1:2': { width: 320, fill: '#FFFFFF' } }) -> pass/fail list; bridge.define(name, src) + bridge.require(name) keep helpers between calls (each call is a fresh function body — never eval); `return bridge.info()` lists the rest. Macros: bridge.replaceWithInstance(target, comp, {props, text}), bridge.setProps(inst, {Status: 'Dropdown'}), bridge.setText(root, {layer: '…'}), bridge.shift(ids, {dx, dy}), bridge.moveInto(ids, section, {layout, gap}), bridge.fitSection(s), bridge.context(id). Return only the ids/flags you need: responses over max_output_bytes (3500) are shrunk, the full value stays in bridge.state.lastResult.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript to run in the Figma sandbox, compiled as an async function body (top-level await and return allowed; import/export are not). Example: const frame = figma.createFrame(); frame.resize(400, 600); frame.name = 'Card'; figma.currentPage.appendChild(frame); return 'Created frame';"
        },
        description: {
          type: "string",
          description: "Short human-readable description of the action (e.g. 'Create login modal', 'Update brand colors') shown in Figma toasts and logs."
        },
        capture: {
          type: "boolean",
          description: "Set to true to capture a PNG of what this call created/modified and return it for visual verification. Never touches the user's selection — see capture_node_ids."
        },
        capture_node_ids: {
          type: "array",
          items: { type: "string" },
          description: "Node ids to screenshot instead of the default (whatever this call created/modified, falling back to the user's current selection only if neither exists). The user's selection is never mutated to enable a capture."
        },
        diff: {
          type: "boolean",
          description: "Requires capture_node_ids. Captures those nodes BEFORE running the code too, so the response includes a before/after image pair instead of just after."
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1)."
        },
        max_px: {
          type: "number",
          description: "Longest side of each returned image in px (default: 1024). Image tokens grow with pixel count, not file size."
        },
        max_output_bytes: {
          type: "number",
          description: "Cap on the whole text response in UTF-8 bytes (default: 3500 — under the ~4 KB at which some clients spill output to a file and cost an extra turn; in clients that spill big outputs to a file, 0 and values above 3900 become 3900). Larger results are shrunk structurally (multi-line text is cut by whole lines), cuts marked with …."
        },
        async: {
          type: "boolean",
          description: "Return { status: 'running', job_id } immediately instead of waiting — collect it later with figma_job_status. Calls that run past 45s do this automatically."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document to run this in, when more than one is open (see figma_list_targets). Defaults to whichever is currently focused."
        }
      },
      required: ["code"]
    }
  },
  {
    name: "figma_inspect",
    description: "READ the live Figma document in ONE call — the tool for any read (not figma_execute_code); pass every node id you need at once instead of one call per node. Default: a compact outline, one line per node (TYPE \"name\" #id WxH @x,y [V gap8 pad16 fill/hug a:start/center] size:fill/hug fill:#FFF stroke:#E8EAF0/0,1,1,1 r0,0,3,3 shadow:… font \"text…\"; non-defaults only), as deep as fits the reply unless `depth` is given; `children:N` marks a node with more below. `compare: \"<ref id>\"` lists, per node_id, every difference from that reference (layout, sizing, stroke, radius, effects, clip, font, variant; children matched by name) — one call for \"make these like that one\", and the check after the write. `props` returns exact values instead: { id: { prop: value } } (also fill, stroke, text, font, layout, padding, parent, children, main, variant, props, absolute, reactions, connector). `find` searches node names under node_ids (or the current page); `find_text` searches text content. `view: \"map\"` = canvas map (sections, breakpoints). `context: true` adds ancestor sections, breakpoints and component variants. `offset` skips the first N outline lines when a reply ends with `pass offset=K`. `check` returns only mismatches. Combine them freely. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "array",
          items: { type: "string" },
          description: "Node ids to read (\"12:34\" or \"12-34\"). Omit to use the current page."
        },
        depth: {
          type: "number",
          description: "Outline levels below each node (0 = the nodes only, max 6). Omit it: the outline goes as deep as fits the reply."
        },
        props: {
          type: "array",
          items: { type: "string" },
          description: "Return these properties per node instead of an outline, e.g. [\"width\", \"layoutSizingHorizontal\", \"fill\", \"text\"]; also \"reactions\" (prototype interactions) and \"connector\" (FigJam connector ends)."
        },
        view: {
          type: "string",
          enum: ["outline", "map", "table"],
          description: "\"outline\" (default) = one line per node; \"map\" = canvas map: sections, frames, breakpoints and component sets in a few lines; \"table\" = per table (found by structure) the columns: header, width, sizing, cell contents, plus row and cell ids."
        },
        context: {
          type: "boolean",
          description: "Also return, per node: ancestor sections, breakpoint siblings and component variants ({ id: context })."
        },
        compare: {
          type: "string",
          description: "Reference node id: instead of an outline, list how each node_id differs from it (geometry and text content are skipped). 'identical' = nothing to fix."
        },
        find_text: {
          type: "string",
          description: "Case-insensitive substring of TEXT content to search for under node_ids (or the current page). One line per match: #id \"layer\" «text» in <top frame>."
        },
        offset: {
          type: "number",
          description: "Skip the first N lines of the outline / found list (use the K from a '… pass offset=K' line to read the next page)."
        },
        find: {
          type: "string",
          description: "Case-insensitive substring of node names to search for under node_ids (or the current page). Matches come back as outline lines."
        },
        find_type: {
          type: "string",
          description: "Restrict find to one node type, e.g. FRAME, TEXT, INSTANCE."
        },
        limit: {
          type: "number",
          description: "Max find matches (default 30)."
        },
        check: {
          type: "object",
          description: "Expectations to verify: { \"12:34\": { \"width\": 320, \"fill\": \"#FFFFFF\", \"layout\": \"V gap8 pad16\" } }. Returns { pass, fail: [{ id, key, want, got }], missing }."
        },
        max_output_bytes: {
          type: "number",
          description: "Cap on the text response in UTF-8 bytes (default 3500; in clients that spill big outputs to a file, 0 and values above 3900 become 3900). A cut outline ends with '… pass offset=K': use `offset` to page instead of raising this."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_screenshot",
    description: "Capture PNG screenshots of specific nodes or the current selection in Figma, to check layout, contrast, typography and spacing. Each image costs ~1k tokens at the default max_px, and stays in context: check mechanical things through write-call `warnings` or bridge.check first, and take one screenshot per finished stage rather than after every edit. Right after a figma_execute_code edit, put capture_node_ids on that call instead — this tool is then an extra turn.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
          description: "Optional comma-separated list of Figma node IDs to screenshot (e.g. '123:456, 123:457'). If omitted, captures current selection or entire page."
        },
        scale: {
          type: "number",
          description: "Export resolution scale factor (default: 1)."
        },
        max_px: {
          type: "number",
          description: "Longest side of each image in px (default: 1024). Raise only to read fine detail; crop with node_ids instead where possible."
        },
        description: {
          type: "string",
          description: "Optional action description for Figma toast and logs."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_get_selection",
    description: "Get information and properties (dimensions, coordinates, text, fills, parent, page, AutoLayout context) of the currently selected nodes on the Figma canvas.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_create_ui_card",
    description: "Create a modern, professionally styled UI Card with badge/pill, bold title, subtitle, full-width action button, and AutoLayout in Figma. Automatically captures and returns a visual screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title (default: 'Figma AI Bridge')" },
        subtitle: { type: "string", description: "Card description or subtitle text" },
        badge_text: { type: "string", description: "Optional badge/pill label" },
        button_text: { type: "string", description: "Action button label" },
        bg_color: { type: "string", description: "Hex background color (default: '#F5F0FF')" },
        width: { type: "number", description: "Width in px (default: 400)" }
      }
    }
  },
  {
    name: "figma_find_components",
    description: "Find and inspect components, component sets, variants, and component property definitions in the active Figma file without flooding LLM context. Returns names, variant values, keys, and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to filter components by name, description, or variant name (optional, if empty returns all top components)"
        },
        page_name: {
          type: "string",
          description: "Optional page name filter (e.g. '🎨 Design System' or 'Components')"
        },
        include_variants: {
          type: "boolean",
          description: "Whether to collect and return all available variant property keys and values (default: true)"
        },
        limit: {
          type: "number",
          description: "Maximum number of components to return to prevent token bloat (default: 30)"
        },
        refresh_index: {
          type: "boolean",
          description: "Force a fresh scan instead of using the cached component index (normally at most 60s stale — see figma_read_canvas / instructions for how the index works)."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_insert_component_instance",
    description: "Create and insert an instance of a master component or component set into the canvas or target AutoLayout container. Supports selecting variants, applying text overrides with auto font loading, and can return a PNG screenshot (capture: true) for visual verification.",
    inputSchema: {
      type: "object",
      properties: {
        component_name: {
          type: "string",
          description: "Name of the master component or ComponentSet to instantiate (e.g. 'Button', 'Card', 'Input')"
        },
        component_id: {
          type: "string",
          description: "Direct node ID of the master component or ComponentSet (optional alternative to component_name)"
        },
        properties: {
          type: "object",
          description: "Key-value map of variant properties and component properties to apply (e.g. {'Type': 'Primary', 'Size': 'MD', 'State': 'Default'})"
        },
        text_overrides: {
          type: "object",
          description: "Key-value map of text overrides for text layers inside the component (e.g. {'Label': 'Submit', 'Description': 'Confirm order'})"
        },
        target_parent_id: {
          type: "string",
          description: "Target container/frame node ID to insert the instance into. If omitted, inserts into current selected frame or active page."
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            index: { type: "number", description: "Child index in AutoLayout parent" }
          },
          description: "Optional placement coordinates or child index in AutoLayout container"
        },
        capture: {
          type: "boolean",
          description: "Whether to capture and return a PNG screenshot of the inserted instance (default: false)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_get_variables",
    description: "Retrieve all Figma Variable collections, modes (e.g. Light/Dark), and design tokens (colors, numbers, strings, booleans) from the active document.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Optional filter by variable collection name (e.g. 'Theme', 'Tokens', 'Spacing')"
        },
        limit: {
          type: "number",
          description: "Maximum number of tokens to return across all matched collections, to prevent token bloat on large design-token files (default: 300)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_set_variables_mode",
    description: "Switch the active Figma Variables mode (e.g. Dark Mode, Light Mode, Brand theme) for a specific artboard/frame or the entire page.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Name of the variable collection (e.g. 'Theme', 'Mode', 'Brand')"
        },
        mode_name: {
          type: "string",
          description: "Target mode name to activate (e.g. 'Dark', 'Light', 'Compact')"
        },
        target_id: {
          type: "string",
          description: "Target node ID (frame/artboard) to set mode on. If omitted, applies to current selection or active page."
        },
        capture: {
          type: "boolean",
          description: "Whether to capture a PNG screenshot of the target after switching mode (default: false)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      },
      required: ["collection_name", "mode_name"]
    }
  },
  {
    name: "figma_insert_svg",
    description: "Insert raw SVG/vector code directly into Figma canvas or target AutoLayout container with automatic scale-proportional resizing, fill/stroke color overrides, optional component creation, and an optional PNG screenshot (capture: true).",
    inputSchema: {
      type: "object",
      properties: {
        svg_code: {
          type: "string",
          description: "Raw XML/SVG string (e.g. '<svg xmlns=\"...\" viewBox=\"0 0 24 24\">...</svg>')"
        },
        name: {
          type: "string",
          description: "Optional layer name for the created SVG node (e.g. 'Icon / Shield', 'Brand / Google')"
        },
        width: {
          type: "number",
          description: "Desired width in pixels (e.g. 24, 32, 48)"
        },
        height: {
          type: "number",
          description: "Desired height in pixels (e.g. 24, 32, 48)"
        },
        fill_override: {
          type: "string",
          description: "Specific fill color override (Hex e.g. '#FFFFFF' or RGB) applied to vector shapes with non-empty fills"
        },
        stroke_override: {
          type: "string",
          description: "Specific stroke color override (Hex e.g. '#6366F1' or RGB) applied to vector paths with non-empty strokes"
        },
        color_override: {
          type: "string",
          description: "Universal color override (Hex '#6366F1' or RGB) applied to all active fills and strokes"
        },
        target_parent_id: {
          type: "string",
          description: "Target container/frame node ID to insert the SVG into. If omitted, inserts into current selected frame or active page."
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            index: { type: "number", description: "Child index in AutoLayout parent" }
          },
          description: "Optional placement coordinates or child index in AutoLayout container"
        },
        as_component: {
          type: "boolean",
          description: "Whether to wrap the resulting SVG node into a reusable master ComponentNode (default: false)"
        },
        capture: {
          type: "boolean",
          description: "Whether to capture and return a PNG screenshot of the inserted SVG (default: false)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale factor (default: 2.0)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      },
      required: ["svg_code"]
    }
  },
  {
    name: "figma_get_canvas_layout",
    description: "Inspect top-level frames and artboards on the active Figma page to prevent overlap. Returns all screen coordinates, bounding box, and a calculated 'suggestedNextPosition' for placing new artboards safely.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["RIGHT", "BOTTOM"],
          description: "Placement direction relative to existing screens ('RIGHT' or 'BOTTOM', default: 'RIGHT')"
        },
        gap: {
          type: "number",
          description: "Spacing in pixels between artboards (default: 80)"
        },
        limit: {
          type: "number",
          description: "Maximum number of artboards to list, to prevent token bloat on pages with hundreds of frames (default: 200)"
        },
        layout: {
          type: "string",
          enum: ["row", "grid"],
          description: "'row' (default) places along one axis per `direction`, like before. 'grid' shelf-packs into a `columns`-wide grid so a run of generated screens fills a compact rectangle instead of one long ribbon."
        },
        columns: {
          type: "number",
          description: "Column count for layout: 'grid' (default: 4)."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_rollback",
    description: "Undo what a previous write call (figma_execute_code, figma_insert_component_instance, figma_insert_svg) did: removes nodes it created and restores properties on nodes it modified. Deletions the code performed on pre-existing nodes are never recoverable. Every write call's response includes the checkpoint_id to pass here.",
    inputSchema: {
      type: "object",
      properties: {
        checkpoint_id: {
          type: "string",
          description: "The checkpoint_id from a previous write call's response. Omit (or pass \"last\") to roll back the most recent not-yet-rolled-back checkpoint."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_job_status",
    description: "Wait for a figma_execute_code call that came back as { status: 'running', job_id } (it ran past 45s, or was called with async: true). BLOCKS until the job finishes or wait_ms passes, then returns the same result/screenshot the synchronous call would have — so call it once, not in a polling loop. `stalled: true` means the plugin looks frozen: ask the user instead of waiting again. A finished job is forgotten after being read once.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job_id from figma_execute_code's { status: 'running', job_id } response." },
        wait_ms: { type: "number", description: "How long to block waiting for the job to finish (default: 45000, max: 55000; 0 = just peek)." }
      },
      required: ["job_id"]
    }
  },
  {
    name: "figma_list_targets",
    description: "List every Figma document currently connected to this bridge (fileName, current page, which one is focused). Use this when a LIVE tool call fails with AMBIGUOUS_TARGET, or before working with a specific file among several open at once — pass the fileName as `target` on any LIVE tool.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "figma_read_canvas",
    description: "Read the LIVE, currently-open Figma document as token-optimized Pseudo-JSX/Tree/JSON — the same pipeline get_file/get_node use for the cloud API, applied to whatever is open in Figma Desktop right now. Prefer this over hand-writing a tree walk in figma_execute_code; it is far cheaper in tokens and its output format matches get_file/get_node exactly.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
          description: "Comma-separated node IDs to read. Omit to read the top-level frames of the current page."
        },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json"],
          description: "Output format — same meaning as get_file/get_node (default: 'jsx')."
        },
        depth: {
          type: "number",
          description: "Traversal depth from each requested node, hard-capped at 12 (default: 6)."
        },
        include_hidden: {
          type: "boolean",
          description: "Whether to include hidden (visible=false) layers (default: false)."
        },
        budget_tokens: {
          type: "number",
          description: "Target response size in tokens (default: 4000). If the requested depth overshoots this, depth is reduced and re-serialized (no extra round trip) until it fits, with a trailing comment noting the reduction."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },

  // 2. Figma REST API Tools (Cloud)
  {
    name: "get_me",
    description: "Verify authenticated user and token validity via Figma Cloud REST API.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_file",
    description: "Get full document metadata and token-optimized layer hierarchy of a Figma file by URL or file key. Automatically prunes noise and converts to semantic Pseudo-JSX/Tree format to save 85%+ tokens.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma file/design URL" },
        depth: { type: "number", description: "Hierarchy depth (default: 2)" },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json", "raw"],
          description: "Output format: 'jsx' (clean semantic Pseudo-JSX, default), 'tree' (indented text tree), 'json' (pruned JSON), or 'raw' (unmodified raw Figma API response)"
        },
        simplify: { type: "boolean", description: "Whether to apply token pruning and vector collapsing (default: true)" },
        include_hidden: { type: "boolean", description: "Whether to include hidden layers (default: false)" },
        max_depth: { type: "number", description: "Hard cap on tree traversal depth before nodes are truncated (default: 25)" },
        budget_tokens: { type: "number", description: "Target response size in tokens. If set (and simplify is not false), depth is reduced and re-serialized until the output fits, with a trailing comment noting the reduction." }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_node",
    description: "Get token-optimized node/component design data for specific nodes in a Figma file. Automatically prunes AST noise, collapses vector icons, and returns clean Pseudo-JSX/Tree format (saves 85%+ tokens).",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        node_ids: { type: "string", description: "Comma-separated list of node IDs (e.g. '1234:5678') or encoded from URL" },
        depth: { type: "number", description: "Subtree depth (default: 3)" },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json", "raw"],
          description: "Output format: 'jsx' (clean semantic Pseudo-JSX, default), 'tree' (indented text tree), 'json' (pruned JSON), or 'raw' (unmodified raw Figma API response)"
        },
        simplify: { type: "boolean", description: "Whether to apply token pruning and vector collapsing (default: true)" },
        include_hidden: { type: "boolean", description: "Whether to include hidden layers (default: false)" },
        max_depth: { type: "number", description: "Hard cap on tree traversal depth before nodes are truncated (default: 25)" },
        budget_tokens: { type: "number", description: "Target response size in tokens. If set (and simplify is not false), depth is reduced and re-serialized until the output fits, with a trailing comment noting the reduction." }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_image",
    description: "Render and export nodes to image URLs (PNG, SVG, JPG, PDF) via Figma Cloud API.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        node_ids: { type: "string", description: "Comma-separated node IDs to render" },
        format: { type: "string", enum: ["png", "jpg", "svg", "pdf"], description: "Image format (default: png)" },
        scale: { type: "number", description: "Image scale factor 1 to 4 (default: 2)" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_image_fills",
    description: "Get download URLs for all images used as fills in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_styles",
    description: "Get all color, text, and effect styles defined in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_components",
    description: "Get all components and component sets in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_comments",
    description: "List all comments and threads on a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "post_comment",
    description: "Post a comment or reply to a Figma file or specific node.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        message: { type: "string", description: "Comment message text" },
        node_id: { type: "string", description: "Optional target node ID" }
      },
      required: ["file_key", "message"]
    }
  }
];

// ==========================================================================
// Tool tiers — which of the 22 defined tools are actually SENT to the model.
// A longer tools/list costs every single turn (every schema is re-sent) and
// makes tool SELECTION worse, not just more expensive, so the surface is
// trimmed by what's actually usable in this server's current configuration:
//   - "core"/"extended" tools are always sent — LIVE tools work with zero
//     configuration once the plugin is connected.
//   - "rest" tools need FIGMA_PERSONAL_ACCESS_TOKEN; without one they are
//     dead weight (every call would just fail with REST_TOKEN_MISSING), so
//     they're hidden entirely rather than left in as a confusing option.
//   - "legacy" tools (figma_create_ui_card, get_me, get_image_fills) are
//     superseded by other tools and hidden by default; set
//     FIGMA_MCP_LEGACY_TOOLS=1 to keep them available for existing workflows
//     built around them. Nothing is deleted, only hidden.
// ==========================================================================
const TOOL_TIERS = {
  figma_execute_code: "core",
  figma_inspect: "core",
  figma_read_canvas: "core",
  figma_screenshot: "core",
  figma_find_components: "core",
  figma_insert_component_instance: "core",
  figma_insert_svg: "core",
  figma_get_variables: "core",
  figma_rollback: "core",

  figma_get_selection: "extended",
  figma_get_canvas_layout: "extended",
  figma_set_variables_mode: "extended",
  figma_job_status: "extended",
  figma_list_targets: "extended",

  get_file: "rest",
  get_node: "rest",
  get_image: "rest",
  get_styles: "rest",
  get_components: "rest",
  get_comments: "rest",
  post_comment: "rest",

  figma_create_ui_card: "legacy",
  get_me: "legacy",
  get_image_fills: "legacy"
};

function getActiveTools() {
  const hasRestToken = !!FIGMA_TOKEN;
  const legacyEnabled = process.env.FIGMA_MCP_LEGACY_TOOLS === "1";
  return TOOLS.filter(t => {
    const tier = TOOL_TIERS[t.name] || "extended";
    if (tier === "rest") return hasRestToken;
    if (tier === "legacy") return legacyEnabled;
    return true;
  });
}

// ==========================================================================
// Server-level instructions handed to the MCP client on initialize, plus
// hints appended to failures that never reach the Figma sandbox.
// ==========================================================================
// Some clients (Claude Code among them) cut server instructions off after
// ~2000 characters, so this is ordered by value and kept near that size: the
// token-economy rules first, the execution model next, reference last. The
// long-form guide lives in docs/GUIDE.md and bridge.info().
const SERVER_INSTRUCTIONS = [
  "Figma MCP Bridge: LIVE read/write of the file open in Figma Desktop (Antigravity Bridge plugin), plus optional read-only REST tools.",
  "",
  "TOKEN ECONOMY — every call re-reads the whole conversation, and what it returns stays there:",
  "1. READ with figma_inspect: every id in ONE call; find / props / context; compare:'<ref id>' = diff vs reference; view:'map' (canvas), view:'table'; figma_read_canvas = page tree. No read scripts in figma_execute_code: each costs a turn; its reply names the inspect call (use_instead).",
  "2. WRITE the whole change in ONE figma_execute_code call (all breakpoints; verify inside: bridge.check / compare). Return only ids/flags.",
  "3. Replies over max_output_bytes (3500 UTF-8 bytes, max 3900) are shrunk: page with offset=K, don't slice bridge.state.lastResult turn by turn.",
  "4. A screenshot is ~1k tokens and stays in context: trust `warnings` and bridge.check; capture once per stage.",
  "5. Past 45s a call returns { status: \"running\", job_id }: call figma_job_status once — it blocks until done. PLUGIN_BUSY: wait for the named job, never retry blindly. `stalled`: ask the user.",
  "",
  "Execution model: each call is a FRESH async function body (top-level await/return work, import/export don't, declarations don't survive). Never eval. Persist code with bridge.define(name, src ending in module.exports = {...}) + bridge.require(name); data with bridge.store.set/get (in the file) or bridge.state (until reload). `return bridge.info()` lists all helpers; macros: bridge.replaceWithInstance/setProps/setText/shift/moveInto/fitSection/context.",
  "",
  "Figma limits: no x/y inside an INSTANCE (use AutoLayout; bridge.setPosition explains), bridge.componentize(node) instead of createComponentFromNode, await ensureFont(family, style) before text edits, colors are 0..1 floats.",
  "",
  "Write calls return checkpoint_id (figma_rollback undoes creations and snapshotted edits, not deletions), created/modified ids and lint warnings. Several files open: figma_list_targets, then target: \"<fileName>\"."
].join("\n");

const SERVER_ERROR_HINTS = [
  {
    test: /timeout|not connected|8765|bridge/i,
    code: "BRIDGE_OFFLINE",
    hint: "The Figma plugin did not answer. Ask the user to open Figma DESKTOP (not the browser) and launch the Antigravity Bridge plugin (Ctrl+Alt+P / Cmd+Option+P) until the status shows CONNECTED, then retry."
  },
  {
    test: /FIGMA_PERSONAL_ACCESS_TOKEN|401|403|Unauthorized/i,
    code: "REST_TOKEN_MISSING",
    hint: "REST tools need FIGMA_PERSONAL_ACCESS_TOKEN in the MCP server environment. Live tools (figma_execute_code, figma_screenshot, ...) work without a token — prefer them when the file is open in Figma Desktop."
  },
  {
    test: /Unknown tool/i,
    code: "UNKNOWN_TOOL",
    hint: "Call tools/list to see the tools this bridge actually exposes."
  }
];

// node_ids is declared as a comma-separated string, but models (and the older
// README) reach for an array often enough that rejecting one is pure friction —
// and it used to blow up on `.trim is not a function` deep inside the plugin.
function normalizeNodeIds(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const ids = raw.split(",").map(s => s.trim().replace(/-/g, ":")).filter(Boolean);
  return ids.length > 0 ? ids.join(",") : null;
}

function classifyServerCode(message) {
  for (const rule of SERVER_ERROR_HINTS) {
    if (rule.test.test(message)) return rule.code;
  }
  return null;
}

function withServerHint(message) {
  if (/\bHINT:/.test(message)) return message; // plugin already explained it
  for (const rule of SERVER_ERROR_HINTS) {
    if (rule.test.test(message)) return message + "\n\nHINT: " + rule.hint;
  }
  return message;
}

// Tool output is compact JSON. Pretty-printing (indent 2) spent a newline and
// indentation tokens on every key of every result, and results stay in the
// agent's context for the rest of the session.
function toJson(value) {
  return JSON.stringify(value);
}

// ------------------------------------------------------------------
// Output budget. A tree walk that returns every node's properties can come
// back as 40k characters; one such result then rides along in every later
// turn. shrinkToBudget() keeps the SHAPE of an oversized result and cuts its
// bulk — least lossy level that fits wins — so the agent still sees what is
// there (and how much was cut) and can ask for exactly the part it needs.
// ------------------------------------------------------------------
const SHRINK_LEVELS = [
  { str: 400, arr: 50, keys: 60, depth: 8 },
  { str: 300, arr: 30, keys: 50, depth: 7 },
  { str: 200, arr: 20, keys: 40, depth: 6 },
  { str: 160, arr: 15, keys: 30, depth: 5 },
  { str: 120, arr: 10, keys: 25, depth: 4 },
  { str: 100, arr: 7, keys: 20, depth: 4 },
  { str: 80, arr: 5, keys: 15, depth: 3 },
  { str: 60, arr: 3, keys: 10, depth: 2 }
];

// A multi-line string (an outline, a log) is cut by whole LINES, never by a
// fixed character count: figma_inspect returns { outline: "<many lines>" } and
// a 400-char cut on the first shrink level used to throw away the whole child
// tree ("shrunk 8064→502 bytes"). While shrinkToBudget() is pruning the rest of
// the value, each multi-line string is parked in a MultiLine slot; once the
// rest is known, the slots share what is left of the byte budget.
class MultiLine {
  constructor(text) { this.text = text; this.set = null; this.fitted = ""; }
  toJSON() { return this.fitted; }
}

// `budget` (optional { left }) aborts the walk with PRUNE_OVER once more values
// were emitted than the byte budget could ever hold (each costs >= 1 byte).
const PRUNE_OVER = { over: true };
function pruneValue(value, lvl, depth, slots, budget) {
  if (budget && --budget.left < 0) throw PRUNE_OVER;
  if (typeof value === "string") {
    if (slots && value.indexOf("\n") !== -1) return new MultiLine(value);
    return value.length > lvl.str ? value.slice(0, lvl.str) + `…(+${value.length - lvl.str} chars)` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth >= lvl.depth) return `[array of ${value.length}]`;
    const out = [];
    value.slice(0, lvl.arr).forEach((v, i) => {
      const r = pruneValue(v, lvl, depth + 1, slots, budget);
      out.push(r);
      if (r instanceof MultiLine) { r.set = (t) => { out[i] = t; }; slots.push(r); }
    });
    if (value.length > lvl.arr) out.push(`…+${value.length - lvl.arr} more (${value.length} total)`);
    return out;
  }
  const keys = Object.keys(value);
  if (depth >= lvl.depth) return `{object with ${keys.length} keys}`;
  const out = {};
  for (const k of keys.slice(0, lvl.keys)) {
    const r = pruneValue(value[k], lvl, depth + 1, slots, budget);
    out[k] = r;
    if (r instanceof MultiLine) { r.set = (t) => { out[k] = t; }; slots.push(r); }
  }
  if (keys.length > lvl.keys) out["…"] = `+${keys.length - lvl.keys} more keys`;
  return out;
}

// Bytes a string costs inside JSON (escapes included, the two quotes not).
function jsonStringCost(s) {
  return byteLength(JSON.stringify(String(s))) - 2;
}

// 2 spaces per outline level.
function indentLevel(line) {
  let n = 0;
  while (line.charCodeAt(n) === 32) n++;
  return Math.floor(n / 2);
}

function depthMarker(run, k) {
  const t = " ".repeat(2 * k) + `… +${run.n} deeper`;
  return { t, i: run.first, lv: k, cost: jsonStringCost(t) };
}

// Fits a multi-line string into `budget` JSON-string bytes. Returns
// { text, ok }; ok is false only when not even the first line (plus the
// marker) fits, in which case that first line is cut mid-way.
//  1. While it does not fit and there is more than one indent level, drop the
//     DEEPEST level: each consecutive run of dropped lines becomes one
//     "<indent>… +N deeper" line. (A single root line keeps its children's
//     level: collapsing 79 children into "+79 deeper" would show nothing.)
//  2. Still too big: keep whole leading lines and end with
//     "… +N more lines (T total) — pass offset=K".
// A leading "… lines 0–B skipped" header (figma_inspect's offset) is kept and
// shifts the K numbering so offset always counts ORIGINAL lines.
function fitLines(text, budget) {
  if (jsonStringCost(text) <= budget) return { text, ok: true };
  let head = "", base = 0, body = text;
  const skipped = /^… lines 0–(\d+) skipped\n/.exec(text);
  if (skipped) { head = skipped[0]; base = Number(skipped[1]) + 1; body = text.slice(head.length); }
  const rawLines = body.split("\n");
  const total = base + rawLines.length;
  const NL = 2; // "\n" costs two bytes once JSON-escaped
  const headCost = jsonStringCost(head);
  let prev = 0;
  const items = rawLines.map((t, i) => {
    const lv = t.trim() ? indentLevel(t) : prev;
    prev = lv;
    return { t, i, lv, cost: jsonStringCost(t) };
  });
  const costOf = (list) => headCost + list.reduce((sum, it) => sum + it.cost, 0) + NL * Math.max(0, list.length - 1);

  // 1. drop the deepest indent levels
  let list = items;
  const maxLv = items.reduce((m, it) => Math.max(m, it.lv), 0);
  const roots = items.filter(it => it.lv === 0).length;
  const minKeep = roots <= 1 ? 2 : 1; // never collapse below this level
  for (let k = maxLv; k >= minKeep; k--) {
    const collapsed = [];
    let run = null;
    for (const it of items) {
      if (it.lv >= k) {
        if (!run) run = { first: it.i, n: 0 };
        run.n++;
      } else {
        if (run) { collapsed.push(depthMarker(run, k)); run = null; }
        collapsed.push(it);
      }
    }
    if (run) collapsed.push(depthMarker(run, k));
    list = collapsed;
    if (costOf(list) <= budget) return { text: head + list.map(it => it.t).join("\n"), ok: true };
  }

  // 2. cut the tail on a line boundary
  const moreLine = (it) => {
    const first = base + it.i;
    return `… +${total - first} more lines (${total} total) — pass offset=${first}`;
  };
  let used = headCost;
  const prefix = []; // bytes of the first n lines, each followed by "\n"
  for (const it of list) { used += it.cost + NL; prefix.push(used); }
  for (let n = list.length - 1; n >= 1; n--) {
    if (prefix[n - 1] + jsonStringCost(moreLine(list[n])) <= budget) {
      return { text: head + list.slice(0, n).map(it => it.t).join("\n") + "\n" + moreLine(list[n]), ok: true };
    }
  }
  // Not even one whole line plus the marker: cut the first line by bytes.
  const marker = list.length > 1 ? moreLine(list[1]) : "";
  const room = Math.max(0, budget - headCost - NL - jsonStringCost(marker));
  let lo = 0, hi = list[0].t.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (jsonStringCost(list[0].t.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(list[0].t[lo - 1])) lo -= 1;
  const first = list[0].t.slice(0, lo);
  return { text: head + first + (marker ? "\n" + marker : "…"), ok: false };
}

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

// Longest prefix of `text` that fits in maxBytes of UTF-8 without splitting a
// character.
function cutToBytes(text, maxBytes) {
  const s = String(text);
  if (byteLength(s) <= maxBytes) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo -= 1; // don't end on half a surrogate pair
  return s.slice(0, lo);
}

// The pruning (depth × array length × string length) whose JSON is the
// largest that still fits; ties go to the deeper one. -> { value, bytes } | null
const GRID_DEPTHS = [8, 7, 6, 5, 4, 3, 2];
const GRID_ARRS = [50, 30, 20, 15, 10, 7, 5, 3, 2];
const GRID_STRS = [400, 200, 120, 80, 60];
function bestStructuralFit(value, maxBytes) {
  let best = null;
  for (const depth of GRID_DEPTHS) {
    for (const arr of GRID_ARRS) {
      for (const str of GRID_STRS) {
        let pruned;
        try {
          pruned = pruneValue(value, { depth, arr, str, keys: Math.max(10, arr + 10) }, 0, null, { left: maxBytes });
        } catch (e) {
          if (e === PRUNE_OVER) continue;
          throw e;
        }
        const bytes = byteLength(toJson(pruned));
        if (bytes <= maxBytes && (!best || bytes > best.bytes)) best = { value: pruned, bytes };
      }
    }
  }
  return best;
}

// -> { value, truncated: null | { from, to } } in UTF-8 bytes; maxBytes <= 0 disables.
function shrinkToBudget(value, maxBytes) {
  let full;
  try { full = toJson(value); } catch (e) { full = String(value); }
  if (!(maxBytes > 0) || full === undefined) return { value, truncated: null };
  const fullBytes = byteLength(full);
  if (fullBytes <= maxBytes) return { value, truncated: null };
  if (typeof value === "string") {
    if (value.indexOf("\n") !== -1) {
      const fit = fitLines(value, Math.max(0, maxBytes - 2));
      return { value: fit.text, truncated: { from: fullBytes, to: byteLength(toJson(fit.text)) } };
    }
    const cut = cutToBytes(value, Math.max(0, maxBytes - 24));
    return { value: cut + `…(+${value.length - cut.length} chars)`, truncated: { from: fullBytes, to: maxBytes } };
  }
  // Plain data (no multi-line text): the fixed levels cut depth, arrays and
  // strings together, so one step too far collapses everything — session
  // e6524905 saw 4444→651 and 5840→998 bytes under a 3500 budget, then 15
  // calls slicing lastResult. Search the grid for the fit that keeps the most.
  const probe = [];
  let probed = true;
  try { pruneValue(value, SHRINK_LEVELS[0], 0, probe, { left: 200000 }); } catch (e) { if (e !== PRUNE_OVER) throw e; probed = false; }
  if (probed && probe.length === 0) {
    const best = bestStructuralFit(value, maxBytes);
    if (best) return { value: best.value, truncated: { from: fullBytes, to: best.bytes } };
  }
  let fallback = null;
  for (const lvl of SHRINK_LEVELS) {
    const slots = [];
    const pruned = pruneValue(value, lvl, 0, slots);
    let allFit = true;
    if (slots.length) {
      // Whatever the rest of the value leaves is shared between the multi-line
      // strings, smallest first, so a short one is never cut for a long one.
      let avail = maxBytes - byteLength(toJson(pruned));
      const order = slots.slice().sort((a, b) => a.text.length - b.text.length);
      order.forEach((slot, idx) => {
        const fit = fitLines(slot.text, Math.max(0, Math.floor(avail / (order.length - idx))));
        slot.fitted = fit.text;
        if (!fit.ok) allFit = false;
        avail -= jsonStringCost(fit.text);
      });
      for (const slot of slots) slot.set(slot.fitted);
    }
    const bytes = byteLength(toJson(pruned));
    if (bytes <= maxBytes) {
      const res = { value: pruned, truncated: { from: fullBytes, to: bytes } };
      if (allFit) return res;
      fallback = fallback || res; // a first line had to be cut: try a level that shrinks the rest more
    }
  }
  if (fallback) return fallback;
  // Nothing structural fits (thousands of top-level keys, say): plain cut.
  return { value: cutToBytes(full, maxBytes) + "…", truncated: { from: fullBytes, to: maxBytes } };
}

// Who is on the other end, from `initialize` clientInfo.name. Antigravity
// writes any tool output over ~4.1 KB to a file and makes the model spend a
// turn reading it; the clients below keep large outputs inline.
const MCP_CLIENT = { name: null };
const NO_SPILL_CLIENTS = /claude|cursor|windsurf|cline|roo-?code|codex|zed|continue/i;

function clientSpillsOutput() {
  return !(MCP_CLIENT.name && NO_SPILL_CLIENTS.test(MCP_CLIENT.name) && !/antigravity|gemini/i.test(MCP_CLIENT.name));
}

// The ceiling in force for this client (0 = none).
function activeOutputCeiling() {
  if (ECONOMY.outputCeilingFromEnv) return ECONOMY.outputCeiling;
  return clientSpillsOutput() ? ECONOMY.outputCeiling : 0;
}

// max_output_chars is the pre-4.2 name of max_output_bytes, still honoured.
// A REQUESTED value above the active ceiling — or 0, "no limit" — is clamped
// to it; the server default is left alone. -> { bytes, capNote }
function outputBudgetInfo(args) {
  for (const key of ["max_output_bytes", "max_output_chars"]) {
    const n = Number(args && args[key]);
    if (args && args[key] !== undefined && Number.isFinite(n) && n >= 0) {
      const ceiling = activeOutputCeiling();
      if (ceiling > 0 && (n === 0 || n > ceiling)) {
        return {
          bytes: ceiling,
          capNote: `max_output_bytes capped at ${ceiling}: a bigger reply is written to a file (an extra turn) — page with offset, or return a slice of bridge.state.lastResult`
        };
      }
      return { bytes: n, capNote: null };
    }
  }
  return { bytes: ECONOMY.maxOutputBytes, capNote: null };
}

function outputBudget(args) {
  return outputBudgetInfo(args).bytes;
}

// The options every text-rendering tool passes to renderPluginResponse.
function budgetOptions(args) {
  const info = outputBudgetInfo(args);
  return { maxOutputBytes: info.bytes, capNote: info.capNote };
}

// Tells the model the cheapest next step. Raising max_output_bytes is only
// offered where it cannot push the reply past a client's spill limit.
function truncationNote(truncated, stashed, readNudged) {
  // A cut hand-written read: slicing lastResult would cost a turn per slice
  // (15 such calls in session e6524905) — point at the paged outline instead.
  if (readNudged) {
    return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
      "Don't slice bridge.state.lastResult turn by turn: the use_instead call reads these nodes in one call and pages with offset.";
  }
  return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
    (stashed
      ? "Full value is in bridge.state.lastResult — next call return just the part you need, e.g. " +
        "`return bridge.state.lastResult.slice(40, 80)` for an array, or only the keys you need; don't re-run. "
      : "") +
    (activeOutputCeiling() > 0 ? "Return less." : "Return less, or raise max_output_bytes.");
}

// Room the rest of an envelope leaves for its `result` inside `budget`.
// Never below a floor that still shows the shape of what came back.
function resultBudget(budget, envelopeWithoutResult, noteBytes) {
  if (!(budget > 0)) return budget;
  const overhead = byteLength(toJson({ ...envelopeWithoutResult, result: null })) + noteBytes;
  return Math.max(budget - overhead, 600);
}

// ------------------------------------------------------------------
// Images. Tokens are charged by pixel area (~w*h/750), so the useful facts to
// surface are the real dimensions and the price. The PNG size is read from
// the IHDR chunk — no decoding, no dependencies.
// ------------------------------------------------------------------
function stripDataUrl(b64) {
  return String(b64 || "").replace(/^data:image\/\w+;base64,/, "");
}

function pngSize(b64) {
  try {
    const head = Buffer.from(stripDataUrl(b64).slice(0, 32), "base64");
    if (head.length < 24 || head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch (e) {
    return null;
  }
}

function describeImage(b64, label) {
  const size = pngSize(b64);
  const dims = size ? `${size.w}x${size.h} ~${Math.ceil((size.w * size.h) / 750)}tok` : "?";
  return label ? `${label} ${dims}` : dims;
}

// Gathers every image a plugin response carries (before/after, single, list),
// caps how many go back to the model, and describes each one in text.
function collectImages(response, maxImages = ECONOMY.maxImages) {
  const found = [];
  if (!response) return { parts: [], meta: [], skipped: 0, errors: [] };
  if (response.beforeScreenshot) found.push({ b64: response.beforeScreenshot, label: "before" });
  if (response.screenshot) found.push({ b64: response.screenshot, label: response.targetName || null });
  const errors = [];
  if (Array.isArray(response.screenshots)) {
    for (const shot of response.screenshots) {
      if (shot && shot.base64) found.push({ b64: shot.base64, label: shot.name || shot.label || shot.id || null });
      else if (shot && shot.error) errors.push(`${shot.name || shot.id || "node"}: ${shot.error}`);
    }
  }
  const limit = Number.isFinite(maxImages) && maxImages > 0 ? maxImages : found.length;
  const kept = found.slice(0, limit);
  return {
    parts: kept.map(img => ({ type: "image", data: stripDataUrl(img.b64), mimeType: "image/png" })),
    meta: kept.map(img => describeImage(img.b64, img.label)),
    skipped: found.length - kept.length,
    errors
  };
}

// Every successful write/read tool renders through this so an agent gets the
// same envelope shape regardless of which tool it called: { ok, result,
// created, modified, warnings, checkpoint_id, duration_ms, ...extra }.
//
// The byte budget covers the WHOLE envelope, not just `result`: a client that
// spills oversized tool output to a file measures everything it was handed.
function buildStructuredResult(response, extra, options = {}) {
  const budget = Number.isFinite(options.maxOutputBytes) ? options.maxOutputBytes : ECONOMY.maxOutputBytes;
  // Side lists get a share of the budget so they can never crowd out result.
  const sideCap = budget > 0 ? Math.min(1500, Math.floor(budget / 4)) : 0;
  const rest = {};
  if (response) {
    if (Array.isArray(response.created) && response.created.length) rest.created = shrinkToBudget(response.created, sideCap).value;
    if (Array.isArray(response.modified) && response.modified.length) rest.modified = shrinkToBudget(response.modified, sideCap).value;
    if (Array.isArray(response.warnings) && response.warnings.length) rest.warnings = shrinkToBudget(response.warnings, sideCap).value;
    if (response.checkpointId) rest.checkpoint_id = response.checkpointId;
    if (typeof response.durationMs === "number") rest.duration_ms = response.durationMs;
    if (response.captureNote) rest.capture_note = response.captureNote;
  }
  if (options.images) {
    if (options.images.meta.length) rest.images = options.images.meta;
    if (options.images.skipped) rest.images_skipped = `${options.images.skipped} more image(s) not sent (max ${ECONOMY.maxImages} per call) — capture those nodes separately if you need them.`;
    if (options.images.errors.length) rest.image_errors = options.images.errors;
  }
  if (options.capNote) rest.note = options.capNote;
  if (extra) Object.assign(rest, extra);

  // `lead` fields (the read nudge) go BEFORE result: the first thing the model
  // reads, not one more key after a long payload.
  const lead = options.lead || null;
  const stashed = !!(response && response.resultStashed);
  const readNote = !!(lead && lead.use_instead);
  const noteBytes = byteLength(toJson(truncationNote({ from: 9999999, to: 9999999 }, stashed, readNote))) + 16;
  const shrunk = shrinkToBudget(
    response && response.result !== undefined ? response.result : null,
    resultBudget(budget, lead ? Object.assign({}, lead, rest) : rest, noteBytes)
  );
  const envelope = Object.assign({ ok: true }, lead || {}, { result: shrunk.value });
  if (shrunk.truncated) envelope.truncated = truncationNote(shrunk.truncated, stashed, readNote);
  return toJson(Object.assign(envelope, rest));
}

// Text envelope + image parts, the shape every capture-capable tool returns.
function renderPluginResponse(response, extra, options = {}) {
  const images = collectImages(response, options.maxImages);
  return {
    content: [
      { type: "text", text: buildStructuredResult(response, extra, { ...options, images }) },
      ...images.parts
    ]
  };
}

// Screenshot knobs shared by every capture-capable tool.
function captureOptions(args, defaultScale = ECONOMY.scale) {
  const scale = Number(args && args.scale);
  const maxPx = Number(args && args.max_px);
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : defaultScale,
    max_px: Number.isFinite(maxPx) && maxPx > 0 ? maxPx : ECONOMY.maxPx
  };
}

// Mirrors buildStructuredResult for the failure path, used by handleCallTool's
// outer catch — every tool failure comes back with the same { ok:false, code,
// error } shape instead of a single opaque line of text.
function buildErrorEnvelope(error) {
  const rawMessage = error && error.message ? error.message : String(error);
  const code = (error && error.code) || classifyServerCode(rawMessage) || null;
  return { ok: false, code, error: withServerHint(rawMessage), ...errorLocation(error) };
}

// Catches a SyntaxError in the agent's code BEFORE it is queued for the plugin:
// the round trip costs a turn and the plugin's own message has no line number.
// The wrapper mirrors the plugin's AsyncFunction (same parameter names), one line
// above the code, so lineOffset -1 makes the reported line the agent's own.
// Throws an Error carrying code/line/at, or returns when the code compiles.
const SYNTAX_HINT = "Your code is compiled as an async function body: top-level await and return are allowed, " +
  "import/export are not. Check for unbalanced braces or quotes in the code string.";
function checkAgentSyntax(code) {
  if (typeof code !== "string") return;
  try {
    new vm.Script(
      "(async function (figma, ensureFont, notify, log, getFreePosition, getFreeCanvasPosition, bridge, progress) {\n" + code + "\n})",
      { filename: "code.js", lineOffset: -1 }
    );
  } catch (e) {
    if (!e || e.name !== "SyntaxError") return; // not ours to judge: let the plugin run it
    const err = new Error(`${e.message}\n\nHINT: ${SYNTAX_HINT}`);
    err.code = "SCRIPT_SYNTAX_ERROR";
    const m = /^code\.js:(\d+)/m.exec(String(e.stack || ""));
    if (m) {
      const line = Number(m[1]);
      err.line = line;
      const src = code.split("\n")[line - 1];
      if (typeof src === "string" && src.trim()) err.at = src.trim().slice(0, 160);
    }
    throw err;
  }
}

// figma_inspect's `offset`: drop the first `offset` lines of the string
// results (outline / found) and say so on the first line. Runs before the
// budget shrink; shrinkToBudget numbers its own "pass offset=K" from ORIGINAL lines.
function applyLineOffset(result, offset) {
  const off = Math.floor(Number(offset));
  if (!result || typeof result !== "object" || !Number.isFinite(off) || off <= 0) return result;
  const out = { ...result };
  for (const key of ["outline", "found", "compare"]) {
    if (typeof out[key] !== "string" || out[key].indexOf("\n") === -1) continue;
    out[key] = `… lines 0–${off - 1} skipped\n` + out[key].split("\n").slice(off).join("\n");
  }
  return out;
}

// Plain data results (list/find/variables/layout...) under the same budget.
const NARROW_HINT = " Narrow the query (query/limit/collection_name/node_ids) to see the rest.";

function jsonResult(value, args) {
  const noteBytes = byteLength(truncationNote({ from: 9999999, to: 9999999 }, false) + NARROW_HINT) + 16;
  const info = outputBudgetInfo(args);
  const shrunk = shrinkToBudget(value, resultBudget(info.bytes, info.capNote ? { note: info.capNote } : {}, noteBytes));
  const body = { ok: true, result: shrunk.value };
  if (info.capNote) body.note = info.capNote;
  if (shrunk.truncated) body.truncated = truncationNote(shrunk.truncated, false) + NARROW_HINT;
  return { content: [{ type: "text", text: toJson(body) }] };
}

// Shared by figma_read_canvas AND get_file/get_node: serialize at the
// requested depth, and if that overshoots the byte budget, re-serialize the
// SAME already-fetched tree at a shallower maxDepth (cheap — pure JS, no
// extra network/plugin round trip) until it fits or depth bottoms out at 0.
// Still too big at depth 0 (hundreds of top-level frames): cut, and say so.
function applyTokenBudget(rawData, { format, includeHidden, maxDepth, budgetBytes }) {
  let depthTry = maxDepth;
  let output = optimizeFigmaData(rawData, { format, simplify: true, maxDepth: depthTry, includeHidden });

  while (budgetBytes > 0 && byteLength(output) > budgetBytes && depthTry > 0) {
    depthTry -= 1;
    output = optimizeFigmaData(rawData, { format, simplify: true, maxDepth: depthTry, includeHidden });
  }

  let cut = false;
  if (budgetBytes > 0 && byteLength(output) > budgetBytes) {
    output = cutToBytes(output, budgetBytes - 200);
    cut = true;
  }
  if (depthTry < maxDepth || cut) {
    output += `\n\n<!-- ${cut ? "cut" : "truncated"} at depth=${depthTry} to fit ${budgetBytes} bytes. Read a specific node_id for more depth, or raise budget_tokens. -->`;
  }
  return output;
}

// budget_tokens (the public knob) -> bytes at ~4 bytes/token; absent -> the
// server-wide byte budget.
function budgetBytesFromTokens(budgetTokens) {
  return Number.isFinite(budgetTokens) ? budgetTokens * 4 : ECONOMY.maxOutputBytes;
}

// figma_inspect runs as ordinary plugin code over the bridge's cheap-read
// helpers (bridge.find / summarize / inspect / check), so it needs no plugin
// message type of its own and inherits the job ledger, target routing and
// bridge.state.lastResult. Arguments travel as a JSON literal, never spliced
// in as code.
function buildInspectCode(args = {}) {
  const ids = normalizeNodeIds(args.node_ids || args.node_id || args.ids);
  const depth = Number(args.depth);
  const limit = Number(args.limit);
  const spec = {
    ids: ids ? ids.split(",") : [],
    depth: Number.isFinite(depth) ? Math.max(0, Math.min(6, Math.floor(depth))) : null,
    props: Array.isArray(args.props) && args.props.length ? args.props.map(String) : null,
    view: args.view === "map" || args.view === "table" ? args.view : null,
    context: args.context === true,
    find: typeof args.find === "string" && args.find ? args.find : null,
    findText: typeof args.find_text === "string" && args.find_text ? args.find_text : null,
    type: typeof args.find_type === "string" && args.find_type ? args.find_type.toUpperCase() : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30,
    check: args.check && typeof args.check === "object" ? args.check : null,
    compare: typeof args.compare === "string" && args.compare ? args.compare.replace(/-/g, ":") : null,
    // No depth: the plugin picks the deepest outline that fits the reply.
    autoBytes: Math.max(600, outputBudgetInfo(args).bytes - 500)
  };
  const literal = JSON.stringify(spec); // ES2019+: U+2028/2029 are legal in string literals
  return [
    `const a = ${literal};`,
    "const out = {};",
    "let targets = a.ids;",
    "const query = a.findText || a.find;", // find_text (names AND text content) wins over find
    "let hits = [];",
    "if (query) {",
    "  let more = [];",
    "  for (const root of (a.ids.length ? a.ids : [null])) {",
    "    const opts = { limit: a.limit };",
    "    if (root) opts.root = root;",
    "    if (a.type) opts.type = a.type;",
    "    if (a.findText) opts.text = true;",
    "    for (const f of bridge.find(query, opts)) (typeof f === 'string' ? more : hits).push(f);",
    "  }",
    "  targets = hits.map(f => f.id);",
    "  if (!targets.length) out.found = 'no matches';",
    "  if (more.length) out.found_more = more;",
    "}",
    "const wantsRead = a.props || query || a.ids.length || a.view || a.context || !a.check;",
    "if (a.compare && targets.length) out.compare = bridge.compare(a.compare, targets);",
    "if (wantsRead && (targets.length || !query)) {",
    "  const refs = targets.length ? targets : [figma.currentPage];",
    "  if (a.compare) {}",
    "  else if (a.props) out.props = bridge.inspect(refs, a.props);",
    "  else if (a.findText && !a.view) out.found = hits.map(f => '#' + f.id + ' ' + JSON.stringify(f.name) + ' «' + f.text + '» in ' + f.frame).join('\\n');",
    "  else {",
    "    const so = { maxChildren: 200 };",
    "    if (a.depth !== null) so.depth = a.depth; else if (query || a.view === 'map') so.depth = query ? 0 : 1; else so.autoBytes = a.autoBytes;",
    "    if (a.view === 'map') so.view = 'map';",
    "    if (a.view === 'table') so.view = 'table';",
    "    out[query ? 'found' : 'outline'] = bridge.summarize(refs, so);",
    "  }",
    "  if (a.context) {",
    "    out.context = {};",
    // One-line strings: nested {w,n} objects came back as \"{object with 2 keys}\" once shrunk.
    "    const ws = l => (l || []).map(x => x.w + '×' + x.n).join(', ');",
    "    for (const r of refs) {",
    "      const id = typeof r === 'string' ? r : r.id;",
    "      const c = bridge.context(id);",
    "      out.context[id] = { node: c.node.type + ' ' + JSON.stringify(c.node.name) + ' #' + c.node.id + ' ' + c.node.w + 'x' + c.node.h, ancestors: c.ancestors.join(' › '), siblings: ws(c.siblings), pageWidths: ws(c.pageWidths),",
    "        components: c.components.map(x => x.set + ' ×' + x.used + (x.props ? ' ' + Object.keys(x.props).map(k => k + '=' + (Array.isArray(x.props[k]) ? x.props[k].join('|') : x.props[k])).join('; ') : '')), conventions: c.conventions };",
    "    }",
    "  }",
    "}",
    "if (a.check) out.check = bridge.check(a.check);",
    "return out;"
  ].join("\n");
}

const SLOW_CALL_HINT = "Slow call: if it searched the whole page (findAll / find without root), scope it to a section next time.";

// ------------------------------------------------------------------
// Read nudge. Antigravity/Gemini Flash never sees server instructions and
// rarely opens figma_inspect's schema, but it always reads a tool response.
// 4.2.1 showed a generic one-time tip; in session e6524905 the model got it on
// the very first read, ignored it, and wrote ~69 more read scripts (+15 calls
// slicing bridge.state.lastResult, because the truncation note told it to).
// What a model does act on is a concrete next call. So every hand-written read
// of figma_execute_code gets, as the FIRST field of the reply, the
// figma_inspect call that reads the same nodes — ids, find query and props
// lifted from the script itself — plus a running count of wasted turns.
// ------------------------------------------------------------------
const TREE_WALK_RE = /\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b|function\s+walk\b|const\s+walk\s*=/;
const NODE_READ_RE = /getNodeById(Async)?\s*\(|currentPage\b|\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b|\.parent\b/;
const STASH_RE = /bridge\s*\.\s*state\s*\.\s*lastResult/;
// Reads through the bridge's own helpers are already cheap — not nagged.
const CHEAP_READ_RE = /bridge\s*\.\s*(summarize|inspect|find|check|context)\s*\(/;
const WRITE_PROPS = [
  "x", "y", "characters", "fills", "strokes", "strokeWeight", "strokeAlign", "visible", "opacity", "name",
  "layoutMode", "layoutWrap", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "horizontalPadding", "verticalPadding", "layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutAlign",
  "layoutPositioning", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "fontName", "fontSize",
  "lineHeight", "letterSpacing", "textAutoResize", "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration",
  "constraints", "rotation", "effects", "clipsContent", "locked", "selection", "mainComponent", "reactions", "itemReverseZIndex",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "isMask",
  "blendMode", "currentPage", "expanded", "description", "relativeTransform"
];
const CANVAS_WRITE_RE = new RegExp(
  "figma\\s*\\.\\s*(create|group|ungroup|flatten|union|subtract|intersect|exclude|combineAsVariants|setCurrentPageAsync)|" +
  "\\.(remove|appendChild|insertChild|resize|resizeWithoutConstraints|rescale|swapComponent|createInstance|clone|detachInstance|" +
  "resetOverrides|insertCharacters|deleteCharacters|scrollAndZoomIntoView)\\s*\\(|\\.set[A-Z]\\w*\\s*\\(|" +
  "bridge\\s*\\.\\s*(replaceWithInstance|setProps|setText|shift|moveInto|fitSection|componentize|setPosition|define|snapshot|checkpoint)\\s*\\(|" +
  "\\.(" + WRITE_PROPS.join("|") + ")\\s*(=(?!=)|\\+=|-=)"
);
const CAPS_NOTE = 'figma_inspect also does: find / find_text (search names / text under node_ids), props:[...] (exact values: ' +
  '"font", "text", "layout", "padding", "props" = componentProperties, "variant", "main", "reactions", or any raw property), ' +
  'context:true (parent sections, breakpoints, component variants), view:"map" (canvas map), view:"table" (per table: headers, widths, ' +
  'cell contents and variant counts per column, row/cell ids), check (pass/fail).';
// Script property -> figma_inspect props name. Geometry, names, types, text,
// fonts, layout, fills and instance variants are already on every outline
// line, so only these make a props read worth suggesting.
const PROP_HINTS = [
  [/\bcomponentProperties\b/, "props"], [/\bvariantProperties\b/, "variant"], [/\bmainComponent\b/, "main"],
  [/\b(fontName|fontSize|getStyledTextSegments|getRange\w+)\b/, "font"], [/\bcharacters\b/, "text"],
  [/\b(layoutMode|itemSpacing|primaryAxis\w*|counterAxis\w*)\b/, "layout"], [/\bpadding(Top|Right|Bottom|Left)\b/, "padding"],
  [/\breactions\b/, "reactions"], [/\babsolute(BoundingBox|Transform|RenderBounds)\b/, "absolute"],
  [/\blayoutSizingHorizontal\b/, "layoutSizingHorizontal"], [/\blayoutSizingVertical\b/, "layoutSizingVertical"],
  [/\blayoutGrow\b/, "layoutGrow"], [/\blayoutAlign\b/, "layoutAlign"], [/\bconstraints\b/, "constraints"],
  [/\bfills\b/, "fill"], [/\bstrokes\b/, "stroke"], [/\bcornerRadius\b/, "cornerRadius"], [/\bvisible\b/, "visible"]
];
const TABLE_HINT_RE = /\b(table|tables|row|rows|header|headers|cell|cells|column|columns)\b|таблиц|строк|заголов|ячейк|колонк|столб/i;
const OUTLINE_COVERS =["font", "text", "layout", "fill", "stroke", "cornerRadius", "visible", "variant", "main"];
const WHAT_YOU_GET = {
  outline: 'one line per node: TYPE "name" #id WxH @x,y [layout] fill font "text" →component variant',
  table: "per table: header, each column's title, width, sizing, cell texts and component variant counts, row/cell ids",
  map: "canvas map: sections, frames, breakpoints",
  props: "{ id: { prop: value } } for each node"
};
const READ_STATE = { streak: 0, total: 0, lastIds: [], lastArgs: null, capsShown: false };

// -> "write" | "read" | "stash" | "cheap" | null
function classifyScript(code, response) {
  if (typeof code !== "string") return null;
  if (response && ((Array.isArray(response.created) && response.created.length) ||
                   (Array.isArray(response.modified) && response.modified.length))) return "write";
  if (CANVAS_WRITE_RE.test(code)) return "write";
  const touchesNodes = NODE_READ_RE.test(code);
  // lastResult is plain data: `.children` on it is not a node read.
  if (STASH_RE.test(code) && !/getNodeById(Async)?\s*\(|currentPage\b/.test(code)) return "stash";
  if (CHEAP_READ_RE.test(code) && !TREE_WALK_RE.test(code)) return "cheap";
  return touchesNodes ? "read" : null;
}

// figma_inspect arguments that read what the script read.
function suggestInspect(code, fallbackIds) {
  const ids = [];
  const idRe = /["'`](I?\d+[:-]\d+(?:;\d+[:-]\d+)*)["'`]/g;
  let m;
  while ((m = idRe.exec(code)) && ids.length < 8) {
    const id = m[1].indexOf(";") === -1 ? m[1].replace("-", ":") : m[1];
    if (ids.indexOf(id) === -1) ids.push(id);
  }
  const args = {};
  if (ids.length) args.node_ids = ids;
  else if (fallbackIds && fallbackIds.length) args.node_ids = fallbackIds.slice(0, 8);

  const nameRes = [
    /\.name\s*===?\s*["'`]([^"'`\n]{2,60})["'`]/,
    /["'`]([^"'`\n]{2,60})["'`]\s*===?\s*[\w$.]*\.name\b/,
    /\.name\s*(?:\.\s*toLowerCase\s*\(\s*\))?\s*\.\s*(?:includes|startsWith|endsWith|indexOf)\s*\(\s*["'`]([^"'`\n]{2,60})["'`]/
  ];
  let nameAt = -1;
  for (const re of nameRes) {
    const hit = re.exec(code);
    if (hit) { args.find = hit[1]; nameAt = hit.index; break; }
  }
  // The type filter only counts when it sits in the SAME predicate as the
  // name (`n => n.name === 'checkbox' && n.type === 'INSTANCE'`); a TEXT test
  // elsewhere in the script would make find return nothing.
  if (args.find) {
    const near = code.slice(Math.max(0, nameAt - 60), nameAt + 90).split(/=>|;|\n/).filter(s => s.indexOf(args.find) !== -1).join(" ");
    const typeHit = /\.type\s*===?\s*["'`]([A-Z_]+)["'`]|["'`]([A-Z_]+)["'`]\s*===?\s*[\w$.]*\.type\b/.exec(near);
    if (typeHit) args.find_type = typeHit[1] || typeHit[2];
  }

  // Only props an outline line does NOT carry earn a props read: every line
  // already has geometry, layout, fill, stroke, radius, font, text, visibility
  // and an instance's component + variant.
  const props = [];
  for (const [re, prop] of PROP_HINTS) {
    if (re.test(code) && OUTLINE_COVERS.indexOf(prop) === -1 && props.indexOf(prop) === -1) props.push(prop);
  }
  // props are read off the listed / found nodes themselves, so they fit a
  // script that read them there — not one that walked further down.
  const walks = (code.match(/\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b/g) || []).length;
  if (props.length && (args.find ? walks <= 1 : walks === 0)) {
    args.props = props.slice(0, 6);
    return args;
  }
  if (!args.node_ids) return args.find ? args : { view: "map" };
  // A walk into rows / headers / cells: view:"table" gives headers, widths and
  // per-column contents (variant counts) for every listed screen at once —
  // in session e6524905 that was ~45 read scripts.
  if (walks && TABLE_HINT_RE.test(code)) return { node_ids: args.node_ids, view: "table" };
  let depth = walks >= 4 ? 3 : walks >= 2 ? 2 : 1;
  if (/\.(findAll|findAllWithCriteria|findOne)\s*\(/.test(code) && !args.find) depth = 3;
  if (args.find) depth = Math.max(1, Math.min(depth, 2));
  if (args.node_ids.length > 2) depth = Math.min(depth, 2);
  if (props.length === 0 && walks === 0 && !args.find) {
    // A flat read of the ids' own facts (font, text, layout...): their lines.
    args.depth = 0;
    return args;
  }
  args.depth = depth;
  return args;
}

// The `use_instead` field for a hand-written read, or null.
function readNudge(code, response) {
  const kind = classifyScript(code, response);
  if (kind !== "read" && kind !== "stash") {
    if (kind === "write") READ_STATE.streak = 0;
    return null;
  }
  READ_STATE.streak += 1;
  READ_STATE.total += 1;
  // Slicing lastResult re-reads what the previous walk returned: suggest the
  // call that replaces THAT walk.
  const args = kind === "stash" && READ_STATE.lastArgs
    ? READ_STATE.lastArgs
    : suggestInspect(code, READ_STATE.lastIds);
  if (kind === "read" && args.node_ids) { READ_STATE.lastIds = args.node_ids; READ_STATE.lastArgs = args; }
  const call = "figma_inspect " + JSON.stringify(args);
  const n = READ_STATE.streak;
  let text = kind === "stash"
    ? `${call} — slicing bridge.state.lastResult costs a model turn per slice; this returns the tree as an outline, paged with offset=K.`
    : `${call} — reads the same nodes in ONE call (${WHAT_YOU_GET[args.view || (args.props ? "props" : "outline")]}), every id at once; a long reply pages with offset=K.`;
  text += ` Hand-written read #${n} in a row: each is a full model turn that re-sends the whole conversation.`;
  if (n >= 3) text += " Next: one figma_inspect for everything still unknown, then ONE figma_execute_code that makes the whole change and returns only ids/flags.";
  if (!READ_STATE.capsShown) {
    READ_STATE.capsShown = true;
    text += " " + CAPS_NOTE;
  }
  return text;
}

function resetReadStreak() {
  READ_STATE.streak = 0;
}

async function handleCallTool(name, args = {}) {
  try {
    switch (name) {
      case "figma_execute_code": {
        const desc = args.description || "Execute JS Code";
        const capture = args.capture === true;
        const wantsAsync = args.async === true;
        const normalizedCaptureIds = normalizeNodeIds(args.capture_node_ids);

        // A syntax error costs a plugin round trip and comes back without a
        // line number: catch it here (throws SCRIPT_SYNTAX_ERROR + line/at).
        checkAgentSyntax(args.code);

        const response = await sendCommandToPlugin({
          code: args.code,
          description: desc,
          capture: capture,
          capture_node_ids: normalizedCaptureIds ? normalizedCaptureIds.split(",") : null,
          diff: args.diff === true,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.heavy, { escalateMs: wantsAsync ? 50 : TIMEOUTS.escalate });

        if (response.__escalated) {
          return {
            content: [{
              type: "text",
              text: toJson({
                ok: true,
                status: "running",
                job_id: response.job_id,
                note: `Still running in Figma after ${Math.round(response.elapsed_ms / 1000)}s. Call figma_job_status({ job_id: "${response.job_id}" }) once — it waits for the result.`,
                hint: SLOW_CALL_HINT
              })
            }]
          };
        }

        const nudge = response && response.success !== false ? readNudge(args.code, response) : null;
        return renderPluginResponse(response, null, {
          ...budgetOptions(args),
          lead: nudge ? { use_instead: nudge } : null
        });
      }

      case "figma_inspect": {
        resetReadStreak();
        const response = await sendCommandToPlugin({
          code: buildInspectCode(args),
          description: "Inspect",
          target: args.target
        }, TIMEOUTS.normal);
        // A read has nothing to roll back or lint — keep only what was read.
        return renderPluginResponse(
          { result: applyLineOffset(response.result, args.offset), resultStashed: response.resultStashed },
          null,
          budgetOptions(args)
        );
      }

      case "figma_job_status": {
        const waitMs = args.wait_ms != null && Number.isFinite(Number(args.wait_ms)) ? Number(args.wait_ms) : ECONOMY.jobWaitMs;
        const snap = isBridgeMaster
          ? await readJobSnapshot(args.job_id, waitMs)
          : await proxyToMaster(`/job?id=${encodeURIComponent(args.job_id || "")}&wait_ms=${Math.round(waitMs)}`, {
              timeoutMs: Math.min(waitMs, ECONOMY.jobWaitMaxMs) + 10000
            });

        if (snap.status === "done") {
          return renderPluginResponse(snap.response, { status: "done", job_id: snap.job_id }, budgetOptions(args));
        }
        if (snap.ok === false) {
          return {
            isError: true,
            content: [{ type: "text", text: toJson(snap.code === "JOB_NOT_FOUND" ? snap : { ...buildErrorEnvelope({ message: snap.error, code: snap.code, ...errorLocation(snap) }), job_id: snap.job_id }) }]
          };
        }
        return { content: [{ type: "text", text: toJson(snap) }] };
      }

      case "figma_read_canvas": {
        const nodeIds = normalizeNodeIds(args.node_ids || args.node_id || args.nodeIds || args.nodeId || args.ids);
        const format = args.format || "jsx";
        const requestedDepth = Number.isFinite(args.depth) ? args.depth : 6;
        const includeHidden = args.include_hidden === true;
        const budgetBytes = budgetBytesFromTokens(args.budget_tokens);

        const response = await sendCommandToPlugin({
          type: "READ_CANVAS",
          node_ids: nodeIds,
          depth: requestedDepth,
          include_hidden: includeHidden,
          target: args.target
        }, TIMEOUTS.normal);

        const rawData = response.result;
        let output = applyTokenBudget(rawData, { format, includeHidden, maxDepth: requestedDepth, budgetBytes });
        if (rawData && rawData.truncatedTop) {
          output += `\n\n<!-- canvas traversal capped at 4000 nodes; some siblings were not sent. Narrow with node_ids. -->`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "figma_rollback": {
        const response = await sendCommandToPlugin({
          type: "ROLLBACK",
          checkpoint_id: args.checkpoint_id || "last",
          target: args.target
        }, TIMEOUTS.normal);
        return { content: [{ type: "text", text: toJson({ ok: true, ...response.result }) }] };
      }

      case "figma_list_targets": {
        // A proxy has no plugin sockets of its own — the master does.
        let targets = listTargets();
        if (!isBridgeMaster) {
          try {
            const status = await proxyToMaster("/status", { timeoutMs: 5000 });
            if (status && Array.isArray(status.targets)) targets = status.targets;
          } catch (e) {}
        }
        // Session 9672b93e: an empty list sent the model grepping the server
        // source for 8 turns. Nothing is broken — the plugin just isn't running.
        const body = { ok: true, targets };
        if (!targets.length) body.hint = "No Figma file is connected. Ask the user to open the file in Figma DESKTOP and run the Antigravity Bridge plugin (Ctrl+Alt+P / Cmd+Option+P) until it shows CONNECTED, then call figma_list_targets again. Nothing to debug in the server.";
        return { content: [{ type: "text", text: toJson(body) }] };
      }

      case "figma_screenshot": {
        const desc = args.description || "Figma Screenshot";
        // Models reach for node_id / nodeId often enough; ignoring the alias
        // silently captured the SELECTION instead — a wasted image and turn.
        const nodeIds = normalizeNodeIds(args.node_ids || args.node_id || args.nodeIds || args.nodeId || args.ids);
        const response = await sendCommandToPlugin({
          type: "SCREENSHOT",
          nodeIds,
          ...captureOptions(args),
          description: desc,
          target: args.target
        }, TIMEOUTS.normal);

        const images = collectImages(response);
        const body = { ok: true, result: response.result || "Captured", images: images.meta };
        if (images.skipped) body.images_skipped = `${images.skipped} more image(s) not sent (max ${ECONOMY.maxImages} per call).`;
        if (images.errors.length) body.image_errors = images.errors;
        return { content: [{ type: "text", text: toJson(body) }, ...images.parts] };
      }


      case "figma_get_selection": {
        // Runs as plugin-sandbox JS (not Node), so it inlines its own compact
        // fill formatter rather than reaching for figma/optimizer/styles.js —
        // that module only exists on the server side of the WebSocket.
        // Compact by design: a solid fill becomes one hex string instead of
        // the full paint object (gradient stops, boundVariables, matrices),
        // and text is previewed rather than dumped in full. Parent/page and
        // AutoLayout context are included since "what is this inside of" is
        // usually the actual question behind checking a selection.
        const code = `
          function hex(c) {
            const b = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0').toUpperCase();
            return '#' + b(c.r) + b(c.g) + b(c.b);
          }
          function fillsSummary(fills) {
            if (!fills || fills === figma.mixed || !Array.isArray(fills) || fills.length === 0) return null;
            return fills.filter(f => f.visible !== false).map(f => f.type === 'SOLID' ? hex(f.color) : f.type).join('; ') || null;
          }
          const selection = figma.currentPage.selection;
          return selection.map(node => ({
            id: node.id,
            name: node.name,
            type: node.type,
            width: Math.round(node.width || 0),
            height: Math.round(node.height || 0),
            x: Math.round(node.x || 0),
            y: Math.round(node.y || 0),
            page: figma.currentPage.name,
            parentId: node.parent ? node.parent.id : null,
            parentName: node.parent ? node.parent.name : null,
            layoutMode: ('layoutMode' in node && node.layoutMode !== 'NONE') ? node.layoutMode : undefined,
            fills: fillsSummary(node.fills),
            characters: node.type === 'TEXT' ? String(node.characters || '').slice(0, 200) : undefined
          }));
        `;
        const response = await sendCommandToPlugin({ code, description: "Get Selected Nodes", target: args.target }, TIMEOUTS.normal);
        return jsonResult(response.result, args);
      }

      case "figma_create_ui_card": {
        // Every user-supplied string below is spliced into generated JS source.
        // Escaping only double quotes let a backslash ("C:\Users\x") or a newline
        // produce a SyntaxError — and a trailing backslash escape the closing
        // quote. JSON.stringify emits a complete, correctly escaped JS literal.
        const jsStr = (value) => JSON.stringify(String(value == null ? "" : value));

        const hexToRgb = (hex) => {
          let c = String(hex || "").trim().replace("#", "");
          if (c.length === 3) c = c.split("").map(x => x + x).join("");
          if (!/^[0-9a-fA-F]{6}$/.test(c)) {
            throw new Error(`Invalid hex color "${hex}". Use a 3- or 6-digit hex value such as "#F5F0FF".`);
          }
          const num = parseInt(c, 16);
          return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
        };

        const title = args.title || "Figma AI Bridge";
        const subtitle = args.subtitle || "Real-time two-way bridge between AI assistants and Figma canvas.";
        const badgeText = args.badge_text || "✨ Live Bridge";
        const buttonText = args.button_text || "Explore Features →";
        const bgColor = args.bg_color || "#F5F0FF";
        // Numbers are interpolated bare into the generated source, so coerce
        // rather than trusting the client to have honoured the schema.
        const width = Number.isFinite(Number(args.width)) && Number(args.width) > 0
          ? Math.round(Number(args.width))
          : 400;

        const rgb = hexToRgb(bgColor);

        const code = `
          const card = figma.createFrame();
          card.name = "UI Card - " + ${jsStr(title)};
          card.layoutMode = "VERTICAL";
          card.primaryAxisSizingMode = "AUTO";
          card.counterAxisSizingMode = "FIXED";
          card.resize(${width}, 100);
          card.paddingTop = 28;
          card.paddingBottom = 28;
          card.paddingLeft = 28;
          card.paddingRight = 28;
          card.itemSpacing = 16;
          card.cornerRadius = 20;
          card.clipsContent = true;
          card.fills = [{ type: 'SOLID', color: { r: ${rgb.r}, g: ${rgb.g}, b: ${rgb.b} } }];
          card.effects = [{
            type: 'DROP_SHADOW',
            color: { r: 0.1, g: 0.05, b: 0.2, a: 0.08 },
            offset: { x: 0, y: 10 },
            radius: 24,
            spread: 0,
            visible: true,
            blendMode: 'NORMAL'
          }];

          ${badgeText ? `
          const badge = figma.createFrame();
          badge.name = "Badge";
          badge.layoutMode = "HORIZONTAL";
          badge.primaryAxisSizingMode = "AUTO";
          badge.counterAxisSizingMode = "AUTO";
          badge.paddingTop = 4;
          badge.paddingBottom = 4;
          badge.paddingLeft = 10;
          badge.paddingRight = 10;
          badge.cornerRadius = 100;
          badge.clipsContent = true;
          badge.fills = [{ type: 'SOLID', color: { r: 0.90, g: 0.84, b: 0.98 } }];

          const badgeTextNode = figma.createText();
          badgeTextNode.characters = ${jsStr(badgeText)};
          badgeTextNode.fontSize = 11;
          badgeTextNode.fontName = { family: "Inter", style: "Medium" };
          badgeTextNode.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.25, b: 0.75 } }];
          badge.appendChild(badgeTextNode);
          card.appendChild(badge);
          ` : ""}

          const titleText = figma.createText();
          titleText.characters = ${jsStr(title)};
          titleText.fontSize = 22;
          titleText.fontName = { family: "Inter", style: "Bold" };
          titleText.fills = [{ type: 'SOLID', color: { r: 0.15, g: 0.12, b: 0.25 } }];
          card.appendChild(titleText);

          ${subtitle ? `
          const subText = figma.createText();
          subText.characters = ${jsStr(subtitle)};
          subText.fontSize = 14;
          subText.fontName = { family: "Inter", style: "Regular" };
          subText.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.42, b: 0.55 } }];
          subText.layoutAlign = "STRETCH";
          card.appendChild(subText);
          ` : ""}

          ${buttonText ? `
          const btn = figma.createFrame();
          btn.name = "Action Button";
          btn.layoutMode = "HORIZONTAL";
          btn.primaryAxisSizingMode = "FIXED";
          btn.counterAxisSizingMode = "AUTO";
          btn.primaryAxisAlignItems = "CENTER";
          btn.counterAxisAlignItems = "CENTER";
          btn.layoutAlign = "STRETCH";
          btn.paddingTop = 12;
          btn.paddingBottom = 12;
          btn.paddingLeft = 0;
          btn.paddingRight = 0;
          btn.cornerRadius = 12;
          btn.clipsContent = true;
          btn.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.40, b: 0.95 } }];

          const btnText = figma.createText();
          btnText.characters = ${jsStr(buttonText)};
          btnText.fontSize = 14;
          btnText.fontName = { family: "Inter", style: "Medium" };
          btnText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
          btn.appendChild(btnText);
          card.appendChild(btn);
          ` : ""}

          figma.currentPage.appendChild(card);
          const freePos = getFreePosition(${width}, 200, { gap: 80 });
          card.x = freePos.x;
          card.y = freePos.y;
          figma.currentPage.selection = [card];
          figma.viewport.scrollAndZoomIntoView([card]);
          return "Created UI Card with ID: " + card.id;
        `;

        const response = await sendCommandToPlugin({
          code,
          description: `Create card "${title}"`,
          capture: true,
          ...captureOptions(args)
        });

        const content = [];
        content.push({ type: "text", text: String(response.result) });
        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      // Design System Tools
      case "figma_find_components": {
        const response = await sendCommandToPlugin({
          type: "FIND_COMPONENTS",
          query: args.query || "",
          page_name: args.page_name,
          include_variants: args.include_variants !== false,
          limit: args.limit || 30,
          refresh_index: args.refresh_index === true,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      case "figma_insert_component_instance": {
        // Capture is opt-in: the auto-lint `warnings` catch the mechanical
        // defects, and an image per inserted instance adds up fast.
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "INSERT_COMPONENT_INSTANCE",
          component_name: args.component_name,
          component_id: args.component_id,
          properties: args.properties || {},
          text_overrides: args.text_overrides || {},
          target_parent_id: args.target_parent_id,
          position: args.position,
          capture: capture,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_get_variables": {
        const response = await sendCommandToPlugin({
          type: "GET_VARIABLES",
          collection_name: args.collection_name,
          limit: args.limit || 300,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      case "figma_set_variables_mode": {
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "SET_VARIABLES_MODE",
          collection_name: args.collection_name,
          mode_name: args.mode_name,
          target_id: args.target_id,
          capture: capture,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_insert_svg": {
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "INSERT_SVG",
          svg_code: args.svg_code,
          name: args.name,
          width: args.width,
          height: args.height,
          fill_override: args.fill_override,
          stroke_override: args.stroke_override,
          color_override: args.color_override,
          target_parent_id: args.target_parent_id,
          position: args.position,
          as_component: args.as_component === true,
          capture: capture,
          // Icons are tiny, so they keep a 2x default; max_px still bounds it.
          ...captureOptions(args, 2),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_get_canvas_layout": {
        const response = await sendCommandToPlugin({
          type: "GET_CANVAS_LAYOUT",
          direction: args.direction || "RIGHT",
          gap: args.gap || 80,
          limit: args.limit || 200,
          layout: args.layout,
          columns: args.columns,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      // REST API
      case "get_me": {
        const data = await figmaApiRequest("/me");
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_file": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const depth = args.depth || 2;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}?depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const maxDepth = args.max_depth || 25;
        const includeHidden = args.include_hidden === true;
        const output = (simplify && format !== "raw" && Number.isFinite(args.budget_tokens))
          ? applyTokenBudget(data, { format, includeHidden, maxDepth, budgetBytes: budgetBytesFromTokens(args.budget_tokens) })
          : optimizeFigmaData(data, { format, simplify, maxDepth, includeHidden });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_node": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const nodeIds = normalizeNodeIds(args.node_ids) || normalizeNodeIds(parsed.nodeId);
        if (!nodeIds) throw new Error("No node_ids provided.");
        const depth = args.depth || 3;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeIds)}&depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const maxDepth = args.max_depth || 25;
        const includeHidden = args.include_hidden === true;
        const output = (simplify && format !== "raw" && Number.isFinite(args.budget_tokens))
          ? applyTokenBudget(data, { format, includeHidden, maxDepth, budgetBytes: budgetBytesFromTokens(args.budget_tokens) })
          : optimizeFigmaData(data, { format, simplify, maxDepth, includeHidden });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_image": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const nodeIds = normalizeNodeIds(args.node_ids) || normalizeNodeIds(parsed.nodeId);
        if (!nodeIds) throw new Error("No node_ids provided.");
        const format = args.format || "png";
        const scale = args.scale || 2;
        const data = await figmaApiRequest(`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeIds)}&format=${format}&scale=${scale}`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_image_fills": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/images`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_styles": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/styles`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_components": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/components`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_comments": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "post_comment": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const body = { message: args.message };
        if (args.node_id) body.client_meta = { node_id: args.node_id.replace(/-/g, ":") };
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: toJson(buildErrorEnvelope(error)) }]
    };
  }
}

// ==========================================
// MCP SDK Loader & Universal Stdio Loop
// ==========================================
function startOfficialSdkServer() {
  // Only locations that belong to THIS package. The list previously reached into
  // a sibling "google-tasks" project from the author's machine, which on any
  // other install could load an unrelated (and possibly incompatible) SDK build.
  const sdkLocations = [
    "@modelcontextprotocol/sdk",
    path.resolve(__dirname, "node_modules/@modelcontextprotocol/sdk/dist/cjs")
  ];

  for (const loc of sdkLocations) {
    try {
      const serverModule = require(path.join(loc, "server/index.js"));
      const Server = serverModule.Server;
      const StdioServerTransport = require(path.join(loc, "server/stdio.js")).StdioServerTransport;
      const types = require(path.join(loc, "types.js"));

      const server = new Server({
        name: "figma-mcp",
        version: SERVER_VERSION
      }, {
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS
      });

      server.setRequestHandler(types.ListToolsRequestSchema, async () => {
        return { tools: getActiveTools() };
      });

      server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
        return await handleCallTool(request.params.name, request.params.arguments);
      });

      const transport = new StdioServerTransport();
      server.connect(transport).catch(err => {
        console.error("MCP connection error:", err);
        process.exit(1);
      });
      return true;
    } catch (e) {}
  }
  return false;
}

function startUniversalStdioServer() {
  let buffer = Buffer.alloc(0);

  const sendResponse = (response) => {
    process.stdout.write(JSON.stringify(response) + "\n");
  };

  const processMessage = async (msg) => {
    if (!msg || typeof msg !== "object") return;
    const { id, method, params } = msg;

    if (method === "initialize") {
      const info = params && params.clientInfo;
      MCP_CLIENT.name = info && typeof info.name === "string" ? info.name : null;
      console.error(`[figma-mcp] client: ${MCP_CLIENT.name || "unknown"} — output ceiling ${activeOutputCeiling() || "off"}`);
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "figma-mcp", version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS
        }
      });
      return;
    }

    if (method === "notifications/initialized") {
      return; // No response needed
    }

    if (method === "ping") {
      sendResponse({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      sendResponse({ jsonrpc: "2.0", id, result: { tools: getActiveTools() } });
      return;
    }

    if (method === "tools/call") {
      const toolName = params ? params.name : "";
      const toolArgs = params ? params.arguments : {};
      const result = await handleCallTool(toolName, toolArgs);
      sendResponse({ jsonrpc: "2.0", id, result });
      return;
    }

    if (id !== undefined) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  };

  // Framing is done on a Buffer, never a string. Content-Length counts BYTES,
  // but the previous implementation sliced a decoded JS string by CHARACTER
  // index: one Cyrillic description made the two disagree, the body was
  // over-sliced, JSON.parse threw, and the read cursor was left mid-message —
  // so every subsequent request was corrupt too and the server went silent.
  // processMessage is async; an unhandled rejection here would take the whole
  // server down instead of failing one request.
  const dispatch = (msg) => {
    Promise.resolve()
      .then(() => processMessage(msg))
      .catch((err) => {
        if (msg && msg.id !== undefined) {
          sendResponse({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : String(err)}` }
          });
        }
      });
  };

  process.stdin.on("data", (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");

      // Content-Length framing (LSP style)
      if (headerEnd !== -1) {
        const header = buffer.slice(0, headerEnd).toString("ascii");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          if (buffer.length - bodyStart < contentLength) break; // wait for the rest
          const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
          buffer = buffer.slice(bodyStart + contentLength);
          try {
            dispatch(JSON.parse(body));
          } catch (e) {}
          continue;
        }
      }

      // Newline-delimited JSON (what MCP stdio actually uses).
      const lineEnd = buffer.indexOf(0x0a);
      if (lineEnd === -1) break;

      // A \r\n\r\n further ahead in the stream belongs to a LATER framed
      // message; only skip line parsing when the header is at the very start,
      // otherwise a stray blank line stalled the loop forever.
      if (headerEnd !== -1 && headerEnd < lineEnd) break;

      const line = buffer.slice(0, lineEnd).toString("utf8").trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line.length > 0) {
        try {
          dispatch(JSON.parse(line));
        } catch (e) {}
      }
    }
  });
}

// ------------------------------------------------------------------
// Startup update check. Non-blocking and opt-out — this project's whole
// pitch is running on a machine with no registry access, so a slow/failed
// network call here must never delay startup or print anything scarier
// than nothing at all.
//
// The INSTALLED copy (~/.figma-mcp-bridge/mcp/, etc.) is a plain file copy,
// not a git checkout, so it can't ask git what commit it's at. install.mjs
// captures that at copy time into version.json, sitting next to this
// figma/ directory. No marker at all — a source-tree run via
// `node figma/index.js` straight from a git clone, or an install.mjs run
// where `git rev-parse` itself failed (no .git, no git binary, downloaded
// as a zip) — means there is nothing to compare against, so skip silently
// rather than guess.
// ------------------------------------------------------------------
const UPDATE_REPO = "kolganovr/figma-mcp-bridge";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

async function checkForUpdates() {
  try {
    if (process.env.FIGMA_MCP_NO_UPDATE_CHECK) return;

    const versionInfo = readJsonSafe(path.join(__dirname, "..", "version.json"));
    const localCommit = versionInfo && versionInfo.commit;
    if (!localCommit) return;

    const cacheDir = path.join(os.homedir(), ".figma-mcp-bridge");
    const cachePath = path.join(cacheDir, "update-check.json");
    const cache = readJsonSafe(cachePath);

    let remoteSha = cache && cache.remoteSha;
    const fresh = cache && typeof cache.lastCheckedAt === "number" &&
      (Date.now() - cache.lastCheckedAt) < UPDATE_CHECK_INTERVAL_MS;

    if (!fresh) {
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits/main`, {
        headers: { "User-Agent": "figma-mcp-bridge", "Accept": "application/vnd.github+json" },
        signal: AbortSignal.timeout(4000)
      });
      // Rate-limited, repo moved, offline resolver returning a captive
      // portal page, whatever — try again next launch rather than guessing.
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data.sha !== "string") return;
      remoteSha = data.sha;
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), remoteSha }), "utf8");
      } catch (e) {
        // Cache write failing just means we ask again next launch instead
        // of waiting out the full interval — not worth surfacing.
      }
    }

    if (remoteSha && remoteSha !== localCommit) {
      console.error(
        `[Figma MCP Bridge] Update available on main (installed ${localCommit.slice(0, 7)}, ` +
        `latest ${remoteSha.slice(0, 7)}). Run "node install.mjs --update" from your cloned repo to update.`
      );
    }
  } catch (e) {
    // Offline, DNS failure, corporate proxy, a bug in this function itself —
    // never let a version check take the server down or print anything
    // alarming on a machine that's deliberately air-gapped.
  }
}

if (require.main === module) {
  startBridge();
  checkForUpdates();

  // Start either official SDK server or universal stdio engine
  if (!startOfficialSdkServer()) {
    startUniversalStdioServer();
  }
} else {
  // Pure helpers for tests (tests/token-economy.test.js); nothing is bound.
  module.exports = {
    TOOLS, SERVER_INSTRUCTIONS, ECONOMY, TIMEOUTS,
    shrinkToBudget, pngSize, collectImages, buildStructuredResult, captureOptions, getActiveTools,
    buildInspectCode, applyTokenBudget, byteLength, outputBudgetInfo, truncationNote, readNudge, classifyScript, suggestInspect, READ_STATE, resetReadStreak, MCP_CLIENT, activeOutputCeiling, applyLineOffset, checkAgentSyntax, buildErrorEnvelope
  };
}
