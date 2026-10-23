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
const SERVER_VERSION = "4.2.7";

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
    const startedAt = touchJob(id, { clientId, kind: cmdPayload.type || "EXECUTE", description: cmdPayload.description || null,
      script: typeof cmdPayload.code === "string" && cmdPayload.code.length < 60000 ? stripFontMemoCode(cmdPayload.code) : null }).createdAt;

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
  // A job already reported as stalled is not waited on again: the model polled
  // 4-5 more times after "ask the user" (pack 15.10), a blocking wait each time.
  const earlier = jobs.get(id);
  const repeat = !!(earlier && earlier.status === "running" && earlier.stalledReports > 0);
  await waitForJob(id, repeat ? 0 : Math.min(Math.max(0, waitMs || 0), ECONOMY.jobWaitMaxMs));
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
      job.stalledReports = (job.stalledReports || 0) + 1;
      snap.stalled = true;
      snap.stop = true;
      snap.hint = job.stalledReports === 1
        ? `STOP. No result or progress for ${Math.round(quietMs / 1000)}s: the Figma plugin is frozen on a heavy operation (usually a page-wide scan). Do not call figma_job_status again and do not rerun the script. Reply to the user now: ask them to look at Figma (close or reload the plugin, Ctrl+Alt+P) and tell you when it is back; then continue with a smaller, section-scoped step.`
        : "Already reported as stalled. Do not poll again: write your reply to the user (check Figma, reload the plugin) and wait for their answer.";
    }
    return snap;
  }
  jobs.delete(job.id);
  if (job.status === "error") return { ok: false, status: "error", job_id: job.id, code: job.code, error: job.error, ...errorLocation(job) };
  return { ok: true, status: "done", job_id: job.id, response: job.result, script: job.script || null };
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
    description: "WRITE tool: run JavaScript in the open Figma document (Figma Desktop + 'Antigravity Bridge' plugin) to create, edit, move, style or delete nodes. To READ (explore a section, list children, find layers, check texts / fonts / variants / table columns) call figma_inspect instead: every id in one call, one line per node, view:\"table\" for tables; a read script here costs a model turn per question and its reply names the figma_inspect call to use (use_instead). Every call is a full model turn, so make the whole change in ONE call — all screens / breakpoints, verified in the same code with bridge.check — and put capture_node_ids on that same call instead of a separate figma_screenshot. Globals: `figma`, `await ensureFont(family, style)`, `getFreePosition(w, h)`, `bridge`: bridge.check({ '1:2': { width: 320, fill: '#FFFFFF' } }) -> pass/fail list; bridge.define(name, src) + bridge.require(name) keep helpers between calls (each call is a fresh function body — never eval); `return bridge.info()` lists the rest. Macros: bridge.replaceWithInstance(target, comp, {props, text}), bridge.setProps(inst, {Status: 'Dropdown'}), bridge.setText(root, {layer: '…'}) or bridge.setText(textNode, 'new text') (keeps mixed font styles by words: THE way to replace the text of a label with several font styles — never `characters =`, which flattens them, and never a per-character getRangeFontName/setRangeFontName loop), bridge.shift(ids, {dx, dy}), bridge.moveInto(ids, section, {layout, gap}), bridge.fitSection(s), bridge.context(id), bridge.componentize(nodeObject) -> new COMPONENT, same name/size/look, NEW id (never raw createComponentFromNode), prototype links: await bridge.openOverlay(triggerId, overlayFrameId, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }) (the overlay look is read-only in the Plugin API: the reply names the MANUAL STEP for the user), bridge.closeOverlay(id), bridge.setReaction(id, { to: frameId, nav: 'NAVIGATE' }); read links with figma_inspect view:\"flow\". Call macros directly, don't read their source. Never findAll the whole page — scope to a section. Return only the ids/flags you need: responses over max_output_bytes (3500) are shrunk, the full value stays in bridge.state.lastResult.",
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
          description: "Currently ignored (the \"before\" screenshot stalls the plugin); the reply has the after image only."
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
    description: "READ the live Figma document in ONE call — the tool for any read (not figma_execute_code); pass every node id you need at once instead of one call per node. Default: a compact outline, one line per node (TYPE \"name\" #id WxH @x,y [V gap8 pad16 fill/hug a:start/center] size:fill/hug fill:#FFF stroke:#E8EAF0/0,1,1,1 r0,0,3,3 shadow:… font \"text…\"; non-defaults only; a TEXT named after its text drops the name; `a:P/C` = primaryAxisAlignItems/counterAxisAlignItems, start = MIN, center = CENTER, end = MAX, between = SPACE_BETWEEN, absent = MIN/MIN), as deep as fits the reply unless `depth` is given; `children:N` marks a node with more below. `like: \"<ref id>\"` (or several) FINDS every copy of the reference under node_ids (screens/sections; default: its section) — instances of the same component, or same name — and diffs each against it: the call for \"redo these like the reference\" when you don't know where the copies are. `compare: \"<ref id>\"` lists, per node_id, every difference from that reference (layout, sizing, stroke, radius, effects, clip, font, variant; children matched by name) and ends with REF lines, the reference's exact values to copy into the write (no props read needed) — one call for \"make these like that one\", and the check after the write. `props` returns exact values instead: { id: { prop: value } } (also fill, stroke, text, font, layout, padding, parent, children, main, variant, props, absolute, reactions, connector). `find` searches node names under node_ids (or the current page); `find_text` searches text content. `view: \"map\"` = canvas map (sections, breakpoints). `view: \"flow\"` = the prototype links under node_ids (a section or screens): per screen, source, trigger, action, target, transition, plus the overlay settings of overlay targets — never scan the page for `reactions`. `context: true` adds ancestor sections, breakpoints and component variants. `offset` skips the first N outline lines when a reply ends with `pass offset=K`. `check` returns only mismatches. Combine them freely. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "array",
          items: { type: "string" },
          description: "Node ids to read (\"12:34\" or \"12-34\"). Omit to use the current page."
        },
        node_id: { type: "string", description: "Alias of node_ids for one id." },
        ids: { type: "array", items: { type: "string" }, description: "Alias of node_ids." },
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
          enum: ["outline", "map", "table", "flow"],
          description: "\"outline\" (default) = one line per node; \"map\" = canvas map: sections, frames, breakpoints and component sets in a few lines; \"table\" = per table (found by structure) the columns: header, width, sizing, cell contents, plus row and cell ids; \"flow\" = prototype links (screen, source, trigger, action, target, transition, overlay settings) under node_ids (without node_ids: every top-level screen of the current page)."
        },
        context: {
          type: "boolean",
          description: "Also return, per node: ancestor sections, breakpoint siblings and component variants ({ id: context })."
        },
        like: {
          type: "string",
          description: "Reference node id (several: comma-separated): find its copies under node_ids (default: the reference's top section) and list, per copy, its frame and how it differs (missing children come with the reference's own line, and REF lines at the end give the reference's exact values, so no extra read is needed). Copies that already match are listed as identical."
        },
        compare: {
          type: "string",
          description: "Reference node id: instead of an outline, list how each node_id differs from it (x/y/width and text content are skipped; height, stroke sides/align are compared). Ends with REF lines: the exact values of the differing reference nodes, to copy in figma_execute_code without a props read. 'identical' = nothing to fix."
        },
        find_text: {
          type: "string",
          description: "Case-insensitive substring of TEXT content to search for under node_ids (or the current page). One line per match: #id \"layer\" «text» in <parent layer #id>, screen \"<top frame>\" (the parent is the frame to click or edit)."
        },
        offset: {
          type: "number",
          description: "Skip the first N lines of the outline / found list (use the K from a '… pass offset=K' line to read the next page)."
        },
        find: {
          type: "string",
          description: "Case-insensitive substring of node names to search for under node_ids (or the current page). Up to 8 matches come back with their subtree outline (as deep as fits, no extra read needed); more matches as one line each."
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
    description: "Wait for a figma_execute_code call that came back as { status: 'running', job_id } (it ran past 45s, or was called with async: true). BLOCKS until the job finishes or wait_ms passes, then returns the same result/screenshot the synchronous call would have — so call it once, not in a polling loop. `stalled: true` means the plugin looks frozen: STOP, ask the user to check Figma; a second figma_job_status for that job returns at once with the same advice. A finished job is forgotten after being read once.",
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

// MCP tool annotations (spec 2025-03-26+): behaviour hints clients use for
// permission prompts and registries (Glama TDQS) use to judge safety. Kept
// apart from the descriptions so the text the model reads doesn't grow.
// Live tools never leave the machine (openWorldHint false); REST tools call
// api.figma.com. execute_code / rollback can delete nodes, hence destructive.
const READ_LIVE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_LIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READ_REST = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TOOL_ANNOTATIONS = {
  figma_execute_code: { ...WRITE_LIVE, destructiveHint: true },
  figma_inspect: READ_LIVE,
  figma_read_canvas: READ_LIVE,
  figma_screenshot: READ_LIVE,
  figma_find_components: READ_LIVE,
  figma_insert_component_instance: WRITE_LIVE,
  figma_insert_svg: WRITE_LIVE,
  figma_get_variables: READ_LIVE,
  figma_rollback: { ...WRITE_LIVE, destructiveHint: true },

  figma_get_selection: READ_LIVE,
  figma_get_canvas_layout: READ_LIVE,
  figma_set_variables_mode: { ...WRITE_LIVE, idempotentHint: true },
  figma_job_status: { ...READ_LIVE, idempotentHint: false },
  figma_list_targets: READ_LIVE,

  get_file: READ_REST,
  get_node: READ_REST,
  get_image: READ_REST,
  get_styles: READ_REST,
  get_components: READ_REST,
  get_comments: READ_REST,
  post_comment: { ...READ_REST, readOnlyHint: false, idempotentHint: false },

  figma_create_ui_card: WRITE_LIVE,
  get_me: READ_REST,
  get_image_fills: READ_REST
};

function getActiveTools() {
  const hasRestToken = !!FIGMA_TOKEN;
  const legacyEnabled = process.env.FIGMA_MCP_LEGACY_TOOLS === "1";
  return TOOLS.filter(t => {
    const tier = TOOL_TIERS[t.name] || "extended";
    if (tier === "rest") return hasRestToken;
    if (tier === "legacy") return legacyEnabled;
    return true;
  }).map(t => TOOL_ANNOTATIONS[t.name] ? { ...t, annotations: TOOL_ANNOTATIONS[t.name] } : t);
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
  "Figma MCP Bridge: LIVE read/write of the open Figma Desktop file (Antigravity Bridge plugin); REST tools optional.",
  "",
  "TOKEN ECONOMY — every call re-reads the whole conversation, and what it returns stays there:",
  "1. READ with figma_inspect: every id in ONE call; find / props / context; like:'<ref id>' = find its copies + diff each; compare:'<ref id>' = diff given ids; view:'map'/'table'/'flow' (prototype links); figma_read_canvas = page tree. No read scripts in figma_execute_code (use_instead).",
  "2. WRITE the whole change in ONE figma_execute_code call (all breakpoints; verify inside: bridge.check / compare). Return only ids/flags.",
  "3. Replies over max_output_bytes (3500 B, max 3900) are shrunk: page with offset=K, don't slice bridge.state.lastResult.",
  "4. A screenshot ≈1k tokens, a turn re-sends the whole chat: to orient, one shot of all ids beats a series of reads; to verify, trust `warnings` / bridge.check.",
  "5. Past 45s a call returns { status: \"running\", job_id }: call figma_job_status once, it blocks until done. PLUGIN_BUSY: wait for that job, never retry blindly. `stalled`: stop, ask the user.",
  "",
  "Execution model: each call is a FRESH async function body (top-level await/return work, import/export don't, declarations don't survive). Never eval. Persist code with bridge.define(name, src ending in module.exports = {...}) + bridge.require(name); data with bridge.store.set/get (in the file) or bridge.state. `return bridge.info()` lists all helpers; macros: bridge.replaceWithInstance/setProps/setText/shift/moveInto/fitSection/context/setReaction/openOverlay.",
  "",
  "Figma limits: no x/y inside an INSTANCE (use AutoLayout; bridge.setPosition explains), bridge.componentize(node) instead of createComponentFromNode, await ensureFont(family, style) before text edits, colors are 0..1 floats.",
  "",
  "Write calls return checkpoint_id (figma_rollback undoes creations and snapshotted edits, not deletions), ids and lint warnings. Several files open: figma_list_targets, then target: \"<fileName>\"."
].join("\n");

const SERVER_ERROR_HINTS = [
  {
    // Not a bare "bridge": "bridge.foo is not a function" is a script error, not an
    // offline plugin (Argon audit 16.10, #15).
    test: /timeout|not connected|8765|bridge (?:is )?(?:offline|not running|unreachable)|no figma plugin/i,
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

// Copies of one element (a dropdown on three breakpoints) look alike in an
// outline but the model does not connect them: bench T1 (15.10) went
// outline -> depth 4 -> depth 5 -> props -> a dump script before writing,
// 8-13 turns. When an outline holds 3+ nodes of the same structure whose
// style differs, say so and name the one call that diffs them.
const SIMILAR_LINE_RE = /^(\s*)(FRAME|INSTANCE|COMPONENT|GROUP) "((?:[^"\\]|\\.)*)" #(\S+) [\d.]+x([\d.]+) @\S+(.*)$/;
const DEEPER_RE = /^\s*… \+(\d+) deeper/;

function outlineStyle(rest, h) {
  const s = { h: h };
  const br = /\[([^\]]*)\]/.exec(rest);
  const inner = br ? br[1] : "";
  s.layout = (/^[HVW]\b/.exec(inner) || [""])[0];
  s.gap = (/\bgap\S+/.exec(inner) || [""])[0];
  s.pad = (/\bpad\S+/.exec(inner) || [""])[0];
  s.align = (/\ba:\S+/.exec(inner) || [""])[0];
  const after = br ? rest.slice(br.index + br[0].length) : rest;
  s.fill = (/\bfill:\S+/.exec(after) || [""])[0];
  s.stroke = (/\bstroke:\S+/.exec(after) || [""])[0];
  s.r = (/(?:^|\s)(r[\d.,]+)(?=\s|$)/.exec(after) || ["", ""])[1];
  s.shadow = (/\bshadow:\S+(?: #\S+)?/.exec(after) || [""])[0];
  return s;
}

// Frames named like a finished example ("… (эталон)", "reference") are shown,
// not grouped with the targets (h7 T1 offered the reference as a 4th copy).
const REFERENCE_NAME_RE = /эталон|reference|\bref\b/i;

function similarHint(outline) {
  if (typeof outline !== "string") return null;
  const lines = outline.split(/\r?\n/);
  const nodes = [];
  const refs = [];
  const anc = []; // [{ indent, ref }] of the lines above the current one
  lines.forEach((line, i) => {
    const m = SIMILAR_LINE_RE.exec(line);
    const indentNow = line.length - line.trimStart().length;
    while (anc.length && anc[anc.length - 1].indent >= indentNow) anc.pop();
    if (!m) { anc.push({ indent: indentNow, ref: false }); return; }
    const inRef = anc.some(a => a.ref) || REFERENCE_NAME_RE.test(m[3]);
    anc.push({ indent: indentNow, ref: inRef });
    if (m[1].length === 0) return;
    // inside an instance (#I<id>;<id>) every layer belongs to the master: not a node to align
    if (m[4].charAt(0) === "I") return;
    const indent = m[1].length;
    // direct children: printed lines one level down, or the children:N marker when the depth cut them
    let kids = 0, childIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const ind = lines[j].length - lines[j].trimStart().length;
      if (ind <= indent) break;
      if (DEEPER_RE.test(lines[j])) continue;
      if (childIndent === -1) childIndent = ind;
      if (ind === childIndent) kids++;
    }
    const cut = /\schildren:(\d+)$/.exec(m[6]);
    if (!kids && cut) kids = Number(cut[1]);
    if (kids < 2) return;
    const st = outlineStyle(m[6], m[5]);
    // a bare layout container (a row of fields) is not a styled copy of anything
    if (!st.fill && !st.stroke && !st.r && !st.shadow) return;
    if (inRef) { refs.push(m[4]); return; }
    // instances of different variants differ on purpose (Size=Desktop / Mobile): never one group
    const variant = m[2] === "INSTANCE" ? (/→.*?(?=\schildren:\d+$|$)/.exec(m[6]) || [""])[0] : "";
    nodes.push({ id: m[4], sig: m[2] + "|" + st.layout + "|" + kids + "|" + variant, st: st });
  });
  const groups = {};
  nodes.forEach(n => { (groups[n.sig] = groups[n.sig] || []).push(n); });
  const keys = ["stroke", "r", "shadow", "pad", "gap", "fill", "h", "align"];
  const out = [];
  Object.values(groups).sort((a, b) => b.length - a.length).forEach(g => {
    if (g.length < 3 || out.length >= 2) return;
    const differ = keys.filter(k => g.some(n => n.st[k] !== g[0].st[k]));
    if (!differ.length) return;
    const ids = g.slice(0, 8).map(n => "#" + n.id).join(" ") + (g.length > 8 ? " …" : "");
    out.push(g.length + " nodes of the same structure differ in " + differ.join(", ") + ": " + ids);
  });
  if (!out.length) return null;
  const refNote = refs.length ? " (frames named as a reference, not in the group: " + refs.slice(0, 3).map(x => "#" + x).join(" ") + ")" : "";
  return out.join("; ") + refNote + ". If they should match one of them: figma_inspect compare:\"<that id>\" node_ids:[the others] lists every difference in ONE call, then fix them all in ONE write.";
}

// Tells the model the cheapest next step. Raising max_output_bytes is only
// offered where it cannot push the reply past a client's spill limit.
function truncationNote(truncated, stashed, readNudged, kind) {
  // An outline cut by depth: re-reading it level by level (depth 4, then 5)
  // or slicing lastResult with a script is a turn per step (bench T1 15.10).
  // props / compare / like / flow / check replies are lists, not an outline: nothing
  // "deeper" was collapsed (bench p2 T1 cc37aea8 got the outline note on props).
  if (kind === "inspect-list") {
    return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
      "Don't re-read with scripts: pass fewer node_ids or props, or offset=K for the next lines.";
  }
  if (kind === "inspect") {
    return `outline shrunk ${truncated.from}→${truncated.to} bytes: deeper levels collapsed (… +N deeper). ` +
      "Don't re-read level by level or with scripts: pass only the ids you need deeper, compare:\"<ref id>\" or props for exact values; offset=K pages.";
  }
  // A cut hand-written read: slicing lastResult would cost a turn per slice
  // (15 such calls in session e6524905) — point at the paged outline instead.
  if (readNudged) {
    return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
      "Don't slice bridge.state.lastResult turn by turn: the use_instead call reads these nodes in one call and pages with offset (figma_inspect offset=K).";
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
  const readNote = !!(lead && (lead.use_instead || lead.redirected));
  const noteBytes = byteLength(toJson(truncationNote({ from: 9999999, to: 9999999 }, stashed, readNote, options.kind))) + 16;
  const shrunk = shrinkToBudget(
    response && response.result !== undefined ? compressValidationDeep(response.result) : null,
    resultBudget(budget, lead ? Object.assign({}, lead, rest) : rest, noteBytes)
  );
  const envelope = Object.assign({ ok: true }, lead || {}, { result: shrunk.value });
  if (shrunk.truncated) envelope.truncated = truncationNote(shrunk.truncated, stashed, readNote, options.kind);
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

// ------------------------------------------------------------------
// Figma's reactions validator answers a wrong action with a union error of
// 3-6 KB: one block per action type, most of them irrelevant. In the Ula pack
// ~14 of them were read in full and followed by 12 web searches. Keep the
// branch whose `type` matched (else the one with the fewest issues) and
// say what is wrong with it.
// ------------------------------------------------------------------
const UNION_HEAD_RE = /^Expected (.+?) to be one of the following, but none matched:$/;
const OVERLAY_KEY_RE = /'overlay(?:PositionType|Background|BackgroundInteraction)'/;

function parseIndented(lines) {
  const root = { text: "", indent: -1, kids: [] };
  const stack = [root];
  lines.forEach(line => {
    if (!line.trim()) return;
    const indent = line.length - line.replace(/^ +/, "").length;
    const node = { text: line.trim(), indent, kids: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].kids.push(node);
    stack.push(node);
  });
  return root;
}

function leafTexts(node, out) {
  if (!node.kids.length) { if (!/^… \+\d+ deeper/.test(node.text)) out.push(node.text); return out; }
  node.kids.forEach(k => leafTexts(k, out));
  return out;
}

function branchIssues(branch) {
  const issues = [];
  const items = /^Multiple issues at /.test(branch.text) ? branch.kids : [branch];
  items.forEach(it => {
    if (UNION_HEAD_RE.test(it.text)) {
      const path = UNION_HEAD_RE.exec(it.text)[1];
      const leaves = Array.from(new Set(leafTexts(it, []).map(t => t.replace(/ at \S+$/, ""))));
      issues.push(leaves.length ? `${path}: ${leaves.join(" / ")}` : `${path}: no variant matched`);
    } else if (!/^… \+\d+ deeper/.test(it.text)) {
      issues.push(it.text);
    }
  });
  return issues;
}

function collectBranches(node, path, out) {
  node.kids.forEach(k => {
    const m = UNION_HEAD_RE.exec(k.text);
    if (m && m[1] === path) collectBranches(k, path, out); else out.push(k);
  });
  return out;
}

function compressValidationError(message) {
  if (typeof message !== "string" || message.indexOf("failed validation") === -1) return message;
  let out = message;
  if (message.length > 500 && message.indexOf("to be one of the following") !== -1) {
    const lines = message.split("\n");
    const headAt = lines.findIndex(l => /Expected .+ to be one of the following, but none matched:$/.test(l));
    if (headAt !== -1) {
      const tailAt = lines.findIndex((l, i) => i > headAt && /^\s*(at line \d+|HINT:)/.test(l));
      const treeLines = lines.slice(headAt + 1, tailAt === -1 ? lines.length : tailAt);
      const lead = lines[headAt].replace(/Expected .+ to be one of the following, but none matched:$/, "");
      const path = /Expected (.+) to be one of the following, but none matched:$/.exec(lines[headAt])[1];
      const tree = parseIndented(treeLines);
      const branches = collectBranches(tree, path, []).map(b => ({ b, issues: branchIssues(b) })).filter(x => x.issues.length);
      if (branches.length > 1) {
        const typeMiss = /^Invalid (?:literal|enum) value.* at \S+\.type$/;
        const scored = branches.map(x => ({ ...x, typeOk: !x.issues.some(i => typeMiss.test(i)) }));
        scored.sort((a, c) => (c.typeOk - a.typeOk) || (a.issues.length - c.issues.length));
        const best = scored[0];
        out = `${lead}${path} matches no variant. Closest (${best.typeOk ? "its type is right" : "no type matched"}): ${best.issues.join("; ")}. ` +
          `${branches.length - 1} other variants skipped. Valid shapes: bridge.info().reactions, or bridge.setReaction / openOverlay / closeOverlay.` +
          (tailAt === -1 ? "" : "\n" + lines.slice(tailAt).join("\n"));
      }
    }
  }
  if (/\.transition/.test(out) && /Required value missing|no variant matched/.test(out) && !/null = instant/.test(out)) {
    out += (/[.!]$/.test(out) ? " " : ". ") + "A NODE action needs the key `transition` (null = instant).";
  }
  if (OVERLAY_KEY_RE.test(out) && !/READ-ONLY FRAME propert/.test(out)) {
    out += (/[.!]$/.test(out) ? " " : ". ") + "overlayPositionType / overlayBackground / overlayBackgroundInteraction are not action keys but READ-ONLY FRAME properties: link with bridge.openOverlay, tell the user to set the overlay look in the Prototype panel.";
  }
  return out;
}

// Same for validation errors a script caught and returned inside its result.
function compressValidationDeep(value, depth = 0) {
  if (typeof value === "string") return compressValidationError(value);
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => compressValidationDeep(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = compressValidationDeep(value[k], depth + 1);
  return out;
}

// Mirrors buildStructuredResult for the failure path, used by handleCallTool's
// outer catch — every tool failure comes back with the same { ok:false, code,
// error } shape instead of a single opaque line of text.
function buildErrorEnvelope(error) {
  const rawMessage = compressValidationError(error && error.message ? error.message : String(error));
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
  for (const key of ["outline", "found", "compare", "like", "flow"]) {
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
const AUTO_DEPTH_RESERVE = 300;

function buildInspectCode(args = {}) {
  const ids = normalizeNodeIds(args.node_ids || args.node_id || args.ids);
  const depth = Number(args.depth);
  const limit = Number(args.limit);
  const spec = {
    ids: ids ? ids.split(",") : [],
    depth: Number.isFinite(depth) ? Math.max(0, Math.min(6, Math.floor(depth))) : null,
    props: Array.isArray(args.props) && args.props.length ? args.props.map(String) : null,
    view: args.view === "map" || args.view === "table" || args.view === "flow" ? args.view : null,
    context: args.context === true,
    find: typeof args.find === "string" && args.find ? args.find : null,
    findText: typeof args.find_text === "string" && args.find_text ? args.find_text : null,
    type: typeof args.find_type === "string" && args.find_type ? args.find_type.toUpperCase() : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30,
    check: args.check && typeof args.check === "object" ? args.check : null,
    compare: typeof args.compare === "string" && args.compare ? args.compare.replace(/-/g, ":") : null,
    like: normalizeNodeIds(args.like) ? normalizeNodeIds(args.like).split(",") : null,
    // No depth: the plugin picks the deepest outline that fits the reply. The
    // envelope around the outline ({"ok":true,"result":{"outline":…},"duration_ms":…}
    // plus the reserved truncation note) measured 295 B (bench/tools/autodepth_check.js),
    // so the outline may take the budget minus AUTO_DEPTH_RESERVE (was a guessed 500).
    autoBytes: Math.max(600, outputBudgetInfo(args).bytes - AUTO_DEPTH_RESERVE),
    screens: args.screens === true,
    notes: args.notes === true,
    findTreeMax: 8,
    findTreeBytes: Math.max(600, outputBudgetInfo(args).bytes - AUTO_DEPTH_RESERVE)
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
    // No ids: every top-level node of the page (a capped walk that says what it scanned),
    // not a refusal that costs a turn (h13: 3 empty flow calls).
    "if (a.view === 'flow' && !targets.length && !query) {",
    "  targets = figma.currentPage.children.map(n => n.id);",
    "  if (!targets.length) out.flow = 'the page is empty';",
    "}",
    // flow of whole screens: each id -> the top-level frame it sits in (under the page or a section)
    "if (a.view === 'flow' && a.screens && targets.length) {",
    "  const tops = [];",
    "  for (const id of targets) {",
    "    let n = figma.getNodeById(id);",
    "    if (!n) continue;",
    "    while (n.parent && n.parent.type !== 'PAGE' && n.parent.type !== 'SECTION' && n.parent.type !== 'DOCUMENT') n = n.parent;",
    "    if (tops.indexOf(n.id) === -1) tops.push(n.id);",
    "  }",
    "  if (tops.length) targets = tops;",
    "}",
    "if (a.like) out.like = bridge.like(a.like, a.ids);",
    "const wantsRead = !a.like && (a.props || query || a.ids.length || a.view || a.context || !a.check);",
    "if (a.compare && targets.length) out.compare = bridge.compare(a.compare, targets);",
    "if (wantsRead && !out.flow && (targets.length || !query)) {",
    "  const refs = targets.length ? targets : [figma.currentPage];",
    "  if (a.compare) {}",
    "  else if (a.props) out.props = bridge.inspect(refs, a.props);",
    "  else if (a.findText && !a.view) out.found = hits.map(f => '#' + f.id + ' ' + JSON.stringify(f.name) + ' «' + f.text + '» in ' + (f.parent ? f.parent + ', screen ' + JSON.stringify(String(f.frame).replace(/ #\\S+$/, '')) : f.frame)).join('\\n');",
    "  else {",
    "    const so = { maxChildren: 200 };",
    // H6: a few hits come with their subtree (the next call was an outline of the same ids in 16 of 24 finds).
    "    const findTree = query && !a.view && a.depth === null && hits.length > 0 && hits.length <= a.findTreeMax;",
    "    if (a.depth !== null) so.depth = a.depth; else if (findTree) so.autoBytes = a.findTreeBytes; else if (query || a.view === 'map') so.depth = query ? 0 : 1; else so.autoBytes = a.autoBytes;",
    "    if (a.view === 'map') so.view = 'map';",
    "    if (a.view === 'table') so.view = 'table';",
    "    if (a.view === 'flow') so.view = 'flow';",
    // Hits nested in another hit are shown inside its tree, not counted as roots; one extra line only if the depth did not reach them.
    "    let s;",
    "    if (findTree) {",
    "      const hitSet = new Set(targets);",
    "      const inHit = id => { let p = figma.getNodeById(id); p = p && p.parent; while (p) { if (hitSet.has(p.id)) return true; p = p.parent; } return false; };",
    "      const tops = targets.filter(id => !inHit(id));",
    "      s = bridge.summarize(tops, so);",
    "      const lost = targets.filter(id => tops.indexOf(id) === -1 && s.indexOf('#' + id + ' ') === -1);",
    "      if (lost.length) s += '\\n' + bridge.summarize(lost, { depth: 0 });",
    // depth 1 that does not fit comes back uncapped (up to 200 children): keep the one-line hits then
    "      if (JSON.stringify(s).length > a.findTreeBytes) s = bridge.summarize(refs, { maxChildren: 200, depth: 0 });",
    "    } else s = bridge.summarize(refs, so);",
    "    out[query ? 'found' : a.view === 'flow' ? 'flow' : 'outline'] = s;",
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
    // ids of layers inside an instance (I<inst>;<layer>): is the master, and every other instance of it, really untouched?
    "if (a.notes) {",
    "  const notes = [];",
    "  for (const id of a.ids) {",
    "    if (id.charAt(0) !== 'I' || id.indexOf(';') === -1) continue;",
    "    const parts = id.slice(1).split(';');",
    "    const inst = figma.getNodeById(parts[0]);",
    "    const layer = figma.getNodeById(parts[parts.length - 1]);",
    "    if (!inst || inst.type !== 'INSTANCE' || !layer || !figma.getNodeById(id)) continue;",
    "    const main = inst.mainComponent;",
    "    if (!main) continue;",
    "    const all = typeof main.getInstancesAsync === 'function' ? await main.getInstancesAsync() : (main.instances || []);",
    "    const others = all.filter(i => i.id !== inst.id);",
    "    const differ = [];",
    "    for (const o of others) {",
    "      const cid = 'I' + o.id + ';' + parts.slice(1).join(';');",
    "      if (!figma.getNodeById(cid)) continue;",
    "      if (!/: identical$/.test(bridge.compare(layer.id, [cid]).split('\\n')[0])) differ.push(o.id);",
    "    }",
    "    notes.push('NOTE ' + id + ': an override inside instance #' + inst.id + '; main COMPONENT ' + JSON.stringify(main.name) + ' #' + main.id + ' and ' + (others.length - differ.length) + ' other instance' + (others.length - differ.length === 1 ? '' : 's') + ' untouched' + (differ.length ? ' (' + differ.length + ' differ from the master: ' + differ.slice(0, 4).map(x => '#' + x).join(' ') + ')' : ''));",
    "  }",
    "  if (notes.length) out.notes = notes;",
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
  "bridge\\s*\\.\\s*(replaceWithInstance|setProps|setText|shift|moveInto|fitSection|componentize|setReaction|openOverlay|closeOverlay|setPosition|define|snapshot|checkpoint)\\s*\\(|" +
  "\\.(" + WRITE_PROPS.join("|") + ")\\s*(=(?!=)|\\+=|-=)"
);
const WHAT_YOU_GET = {
  outline: 'one line per node: TYPE "name" #id WxH @x,y [layout] fill font "text" →component variant',
  table: "per table: header, each column's title, width, sizing, cell texts and component variant counts, row/cell ids",
  map: "canvas map: sections, frames, breakpoints",
  props: "{ id: { prop: value } } for each node",
  like: "like:'<ref id>' finds the copies of a correct node under node_ids and lists how each differs, then REF lines with the reference's exact values",
  compare: "compare:'<ref id>' lists how each node_id differs from the reference, then REF lines with its exact values to copy into the write"
};
const CAPS_NOTE = 'figma_inspect also does: find / find_text (search names / text under node_ids), props:[...] (exact values: ' +
  '"font", "text", "layout", "padding", "props" = componentProperties, "variant", "main", "reactions", or any raw property), ' +
  'context:true (parent sections, breakpoints, component variants), view:"map" (canvas map), view:"table" (per table: headers, widths, ' +
  'cell contents and variant counts per column, row/cell ids), check (pass/fail), ' + WHAT_YOU_GET.like + ', ' + WHAT_YOU_GET.compare + '.';
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
// "header" / "заголов" alone is a page header, not a table one (T7 `const header = ...` got view:"table"):
// only row / cell / column words, which a table walk cannot do without, count.
const TABLE_HINT_RE = /\b(table|tables|row|rows|cell|cells|column|columns)\b|таблиц|строк|ячейк|колонк|столб/i;
const OUTLINE_COVERS =["font", "text", "layout", "fill", "stroke", "cornerRadius", "visible", "variant", "main"];
const READ_STATE = { streak: 0, redirects: 0, total: 0, lastIds: [], lastArgs: null, capsShown: false };

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

// After a write the agent spends a turn re-reading what it changed (every T1
// run in bench 15.10 ended with an inspect props/compare of the same ids).
// Answer that read in the write's own reply: one outline line per node the
// code named by id, as they are now. Best-effort: any failure = no `after`.
const AFTER_WRITE_MAX_IDS = 12;
const AFTER_WRITE_BYTES = 1400;
const AFTER_WRITE_DEEP_IDS = 8; // up to this many nodes the after-write outline goes one level down

async function afterWriteOutline(code, response, target) {
  if (classifyScript(code, response) !== "write") return null;
  const codeIds = suggestInspect(code).node_ids || [];
  // A prototype link is checked with view:"flow" (bench H3: every T3 run
  // re-read it that way after the write), so show that instead of outlines.
  const flow = REACTION_MACRO_RE.test(code);
  // componentize / flatten / clone return NEW ids the code never named (bench
  // H4: T4 re-read the six new components after the write): those first.
  let fresh = [];
  try { fresh = (resultIds(response && response.result)).filter(id => codeIds.indexOf(id) === -1); } catch (e) {}
  let ids = fresh.concat(codeIds).slice(0, AFTER_WRITE_MAX_IDS);
  if (flow) {
    // ids kept in variables never reach the code text: the macro's own result has them
    const ov = overlayIds(code, response);
    const modified = response && Array.isArray(response.modified) ? response.modified.map(String) : [];
    ids = (ov || (codeIds.length ? codeIds : modified)).slice(0, AFTER_WRITE_MAX_IDS);
  }
  if (!ids.length) return null;
  try {
    // flow: the whole screen of the trigger (and of the overlay), not the two nodes: every link on it
    const r = await sendCommandToPlugin({
      code: buildInspectCode(flow ? { node_ids: ids, view: "flow", screens: true } : { node_ids: ids, depth: ids.length <= AFTER_WRITE_DEEP_IDS ? 1 : 0, notes: true }),
      description: "Inspect (after write)",
      target: target
    }, TIMEOUTS.fast);
    let outline = r && r.result && (flow ? r.result.flow : r.result.outline);
    if (typeof outline !== "string") return null;
    // a layer inside an instance: say the master and the other instances are intact (compared for real in the plugin)
    if (!flow && Array.isArray(r.result.notes) && r.result.notes.length) outline = r.result.notes.join("\n") + "\n" + outline;
    // Ids the write replaced (componentize) read as MISSING: noise, not news.
    outline = outline.split("\n").filter(l => !/^\s*MISSING\b/.test(l)).join("\n");
    if (!outline) return null;
    return fitLines(outline, AFTER_WRITE_BYTES).text;
  } catch (e) {
    return null;
  }
}

// Node ids in a write's result, in order, up to AFTER_WRITE_MAX_IDS.
function resultIds(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const ids = [];
  const idRe = /["'`#](I?\d+:\d+(?:;\d+:\d+)*)\b/g;
  let m;
  while (text && (m = idRe.exec(text)) && ids.length < AFTER_WRITE_MAX_IDS * 2) {
    if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  return ids;
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

// ------------------------------------------------------------------
// Read guard (4.2.5). Session packs from Antigravity/Gemini Flash showed the
// nudge above is read and ignored: the script still ran, returned its result,
// and the model went on to read #54 in a row (60-64% of the input tokens of
// two prototype sessions). So the NUDGE stays for the first read, but from the
// next consecutive hand-written read on the script is NOT run: the 2nd read
// gets the result of the figma_inspect call it should have made, the 3rd and
// later get a refusal without a result. A figma_inspect call or any write
// resets the streak. A page-wide findAll over a big file froze the plugin for
// 2-12 minutes (747 s once), so a READ that scans the whole page is refused
// up front, and the refusal names the scoped call.
// `/* run-anyway */` in the script lifts both guards (misread script, or a
// scan the user really wants).
// ------------------------------------------------------------------
const RUN_ANYWAY_RE = /\/[*/]\s*run-anyway\b/;
const PAGE_ALIAS_RE = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?figma\s*\.\s*(?:currentPage|root)\s*(?:;|,|\n|$)/g;

// "findAll" | "reactions" | null — does the script walk the whole page / file?
function pageWideScan(code) {
  if (typeof code !== "string") return null;
  const names = ["figma\\s*\\.\\s*(?:currentPage|root)"];
  PAGE_ALIAS_RE.lastIndex = 0;
  let m;
  while ((m = PAGE_ALIAS_RE.exec(code))) names.push(m[1].replace(/\$/g, "\\$"));
  const base = "(?:" + names.join("|") + ")";
  if (new RegExp(base + "\\s*\\.\\s*(?:findAll|findOne)\\s*\\(").test(code)) return "findAll";
  if (/\breactions\b/.test(code) && (
    new RegExp(base + "\\s*\\.\\s*findAllWithCriteria\\s*\\(").test(code) ||
    new RegExp("\\b(?:walk|visit|scan|traverse|recurse|collect)\\w*\\s*\\(\\s*" + base + "\\b").test(code) ||
    new RegExp("\\bof\\s+" + base + "\\s*\\.\\s*children\\b").test(code)
  )) return "reactions";
  return null;
}

const PAGE_SCAN_NOTE = "figma.currentPage.findAll / a walk of the whole page freezes the plugin for minutes on a big file (747 s seen). Scope it to a section: figma_inspect with node_ids, find / find_type (name search), or view:\"flow\" for prototype links; or findAll on a section node in a write script.";

// figma.createComponentFromNode forces every AutoLayout frame of the subtree to
// FIXED sizing; bridge.componentize restores it. Same call shape, so rewrite.
function rewriteComponentize(code) {
  if (typeof code !== "string" || !/figma\s*\.\s*createComponentFromNode\s*\(/.test(code)) return { code, lint: null };
  const n = (code.match(/figma\s*\.\s*createComponentFromNode\s*\(/g) || []).length;
  return {
    code: code.replace(/figma\s*\.\s*createComponentFromNode\s*\(/g, "bridge.componentize("),
    lint: `figma.createComponentFromNode was replaced by bridge.componentize (${n}×): the raw call turns AutoLayout frames in the subtree FIXED and breaks resizing. Write bridge.componentize(node) yourself next time.`
  };
}

// ------------------------------------------------------------------
// Macro guard (bench H3, 15.10). In bench T3 every run spent 3-4 model turns
// learning how to call bridge.openOverlay (bridge.info(), typeof, .toString()
// of the macro = 3 KB of source), and a failed run set the read-only
// overlayPositionType by hand five times. The server answers a look at a
// macro with its call shape, and refuses a hand-written overlay before it runs.
// ------------------------------------------------------------------
const MACRO_SIGNATURES = {
  openOverlay: "await bridge.openOverlay(triggerId, overlayFrameId, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }) - prototype link that opens the overlay frame (transition slides in from the edge). position: CENTER | TOP_LEFT | TOP_CENTER | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_CENTER | BOTTOM_RIGHT; dim: alpha 0..1 or '#000000@0.4'. The overlay look is read-only in the Plugin API: the reply says which part is a MANUAL STEP for the user - report it, don't look for a setter.",
  closeOverlay: "await bridge.closeOverlay(nodeId) - CLOSE action on a node inside an overlay.",
  setReaction: "await bridge.setReaction(nodeId, { trigger: 'ON_CLICK', to: frameId, nav: 'NAVIGATE', transition: 'MOVE_IN/LEFT' }) - one prototype link (replaces the one with the same trigger); action: 'BACK' | 'CLOSE' | { type: 'URL', url } instead of to/nav.",
  // bench H4: T4 read typeof + .toString() of componentize before using it.
  componentize: "bridge.componentize(node) -> the new COMPONENT (sync; pass the node object, e.g. await figma.getNodeByIdAsync(id)). Same name, size, position, look and AutoLayout sizing; the id CHANGES. Many at once: const out = []; for (const id of ids) out.push(bridge.componentize(await figma.getNodeByIdAsync(id)).id); return out;",
  setProps: "bridge.setProps(instance, { Name: value }) - component properties by readable name ('Label' matches 'Label#12:3'); INSTANCE_SWAP takes a component node or id; returns the instance.",
  setText: "await bridge.setText(root, { layerNameOrId: 'text' }) or bridge.setText(textNodeOrId, 'text') - loads all fonts and sets TEXT layers found by id or exact name under root, KEEPING font styles by words (first word keeps its style, the tail from the first space keeps its own; more styles: word by word, extra words take the last). Replace text with it, never with `characters =` (that flattens mixed fonts) or a per-character getRangeFontName loop. Returns { set: [ids] }.",
  replaceWithInstance: "await bridge.replaceWithInstance(target, component, { props, text, keepSize: false, remove: true }) - instance of a COMPONENT / COMPONENT_SET / id in target's slot; returns the instance.",
  shift: "bridge.shift(nodesOrIds, { dx: 0, dy: 0 }) - moves nodes by an offset; returns the count.",
  moveInto: "bridge.moveInto(nodesOrIds, container, { layout: 'none' | 'row' | 'column', gap: 100, padding: 0 }) - reparents nodes; returns ids.",
  fitSection: "bridge.fitSection(section, { padding: 100 }) - resizes a SECTION/FRAME to its children + padding; returns the section.",
  setPosition: "bridge.setPosition(node, x, y) - sets x/y, or explains why not (inside an INSTANCE: use AutoLayout)."
};
const MACRO_PEEK_RE = /bridge\s*\.\s*(\w+)\s*\.\s*toString\s*\(|String\s*\(\s*bridge\s*\.\s*(\w+)\s*\)|typeof\s+bridge\s*\.\s*(\w+)|Object\s*\.\s*(?:keys|getOwnPropertyNames)\s*\(\s*bridge\s*\)/g;
const REACTION_MACRO_RE = /bridge\s*\.\s*(?:setReaction|openOverlay|closeOverlay)\s*\(/;
const MANUAL_DONE = "Done: the link is set. The overlay look is a MANUAL STEP no script can do (read-only in the Plugin API, no setter anywhere): stop here and tell the user exactly what the result says.";
const OVERLAY_LOOK_WRITE_RE =/\.overlay(?:PositionType|Background|BackgroundInteraction)\s*=(?!=)/;
const RAW_OVERLAY_RE = /(\.reactions\s*=(?!=)|setReactionsAsync\s*\()[\s\S]*["'`]OVERLAY["'`]|["'`]OVERLAY["'`][\s\S]*(\.reactions\s*=(?!=)|setReactionsAsync\s*\()/;

// Overlay frames bridge.openOverlay already linked in this server's life:
// overlay id -> trigger id. A later script that tries to set the look on that
// frame is told the task is done (bench T3: 3 of 3 h7 runs re-read and tried).
const OVERLAY_LINKED = new Map();
const OPEN_OVERLAY_IDS_RE = /bridge\s*\.\s*openOverlay\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/;
const OVERLAY_HEADER_RE = /^OVERLAY SETTINGS \(frame properties of the overlay target, not part of the action\)$/m;
const OVERLAY_HEADER_DONE = "OVERLAY SETTINGS = the frame's CURRENT look, read-only for scripts: it stays like this until the user sets it by hand (the MANUAL STEP), not a failed write";

// Trigger first, overlay frame second: destinationId or the frame whose look the
// script sets is the overlay, never the trigger (Argon audit #18: p2 T3 043ebeed).
function overlayCall(code) {
  const ids = suggestInspect(code).node_ids || [];
  let ov = (code.match(/destinationId\s*:\s*["'`]([^"'`]+)["'`]/) || [])[1] || null;
  if (!ov && OVERLAY_LOOK_WRITE_RE.test(code) && ids.length === 1) ov = ids[0];
  let trig = ids.find(id => id !== ov) || null;
  if (!ov && ids.length >= 2) { trig = ids[0]; ov = ids[1]; }
  if (ov && !trig && OVERLAY_LINKED.has(ov)) trig = OVERLAY_LINKED.get(ov);
  return `await bridge.openOverlay(${trig ? JSON.stringify(trig) : "triggerId"}, ${ov ? JSON.stringify(ov) : "overlayFrameId"}, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true })`;
}

// [trigger, overlay] of a bridge.openOverlay call: the literals in the code, else
// (ids kept in variables, h13 T3#3 08732f9d) the macro's own modified list,
// which is [trigger, overlay] (checked live on T3).
function overlayIds(code, response) {
  const m = code.match(OPEN_OVERLAY_IDS_RE);
  if (m) return [m[1], m[2]];
  if (/bridge\s*\.\s*openOverlay\s*\(/.test(code) && response && Array.isArray(response.modified) && response.modified.length >= 2) {
    return [String(response.modified[0]), String(response.modified[1])];
  }
  return null;
}

// `done` for a successful bridge.openOverlay, self-contained: the model often
// returns its own string and drops the macro's MANUAL STEP text (h7 f7d2ca3a).
function overlayDone(code, ids) {
  const m = ids ? [null, ids[0], ids[1]] : code.match(OPEN_OVERLAY_IDS_RE);
  if (!m) return MANUAL_DONE;
  const pos = (code.match(/position\s*:\s*["'`](\w+)["'`]/) || [])[1];
  const dim = (code.match(/dim\s*:\s*([\d.]+)/) || [])[1];
  const outside = /closeOnOutside\s*:\s*true/.test(code);
  const want = [pos ? "position " + pos : null, dim ? "background #000000 at " + Math.round(Number(dim) * 100) + "%" : null, outside ? "close when clicking outside" : null].filter(Boolean).join(", ");
  return `Done: #${m[1]} opens overlay #${m[2]}. The overlay look is a MANUAL STEP (read-only in the Plugin API, no setter anywhere; OVERLAY SETTINGS below show the current values, not a failed write). Don't re-check or retry: answer now and tell the user to select frame #${m[2]} > Prototype panel > Overlay and set ${want || "position, background and click-outside"}.`;
}

// -> null (run the script) | { type: "peek" | "overlay", body }
function macroGuard(code) {
  if (typeof code !== "string" || RUN_ANYWAY_RE.test(code)) return null;
  if (!/bridge\s*\.\s*openOverlay\s*\(/.test(code) && (OVERLAY_LOOK_WRITE_RE.test(code) || RAW_OVERLAY_RE.test(code))) {
    const look = OVERLAY_LOOK_WRITE_RE.test(code);
    const linked = look && (suggestInspect(code).node_ids || []).find(id => OVERLAY_LINKED.has(id));
    if (linked) {
      return {
        type: "overlay",
        body: {
          ok: false, code: "OVERLAY_ALREADY_LINKED", not_run: true,
          done: `Already done: bridge.openOverlay linked #${OVERLAY_LINKED.get(linked)} → overlay #${linked}. Its look is read-only for scripts (no setter anywhere): this is the MANUAL STEP. Answer now: tell the user to select frame #${linked} > Prototype panel > Overlay and set position, background and click-outside there.`
        }
      };
    }
    return {
      type: "overlay",
      body: {
        ok: false, code: "USE_OPEN_OVERLAY",
        error: "Not run. " + (look
          ? "overlayPositionType / overlayBackground / overlayBackgroundInteraction are READ-ONLY in the Plugin API (no setter), there is no other way to set them."
          : "A hand-built OVERLAY reaction misses the overlay look and is easy to get wrong (`actions` array, `transition` key).") +
          " If bridge.openOverlay already ran and said MANUAL STEP, the task is done: tell the user that step and stop. Otherwise one call makes the link and tries the look; its reply names what the user must set by hand (MANUAL STEP). Swap the ids if the order is wrong. A script that is not this: add /* run-anyway */.",
        use_instead: overlayCall(code)
      }
    };
  }
  // A look at a macro (its source, its type, the key list): nothing on the
  // canvas is read, so answer here with how to call it.
  if (classifyScript(code, null) === "write" || NODE_READ_RE.test(code)) return null;
  const names = [];
  let all = false, m;
  MACRO_PEEK_RE.lastIndex = 0;
  while ((m = MACRO_PEEK_RE.exec(code))) {
    const name = m[1] || m[2] || m[3];
    if (name) { if (names.indexOf(name) === -1) names.push(name); } else all = true;
  }
  const known = names.filter(n => MACRO_SIGNATURES[n]);
  if (!known.length && !(all && names.length === 0)) return null;
  const pick = known.length ? known : Object.keys(MACRO_SIGNATURES);
  const signatures = {};
  for (const n of pick) signatures[n] = MACRO_SIGNATURES[n];
  return {
    type: "peek",
    body: {
      ok: true, not_run: true,
      note: "Answered by the server without running the script: how to call " + pick.map(n => "bridge." + n).join(", ") + ". Call it directly in the write; don't read its source." + (all ? " `return bridge.info()` lists every helper." : ""),
      signatures
    }
  };
}

// ------------------------------------------------------------------
// Writes that stall the plugin (bench H5, 15.10). Measured on the live bridge:
// after an exportAsync, or after a few loads in one call, a further
// figma.loadFontAsync of an already-loaded font does not resolve for 20-150 s
// (it seems to wait for a canvas frame, rare while Figma is in the
// background). Two agent paths hit it and turned a trivial write into a job
// plus a figma_job_status turn: (1) the per-character loop
// `for (i...) await figma.loadFontAsync(t.getRangeFontName(i, i + 1))`
// (T6: 16 loads), (2) diff:true, whose "before" export runs ahead of the
// plugin's own ensureFont calls (T7, T1, even with `return 1` as the code).
// (1): `figma` is a parameter of the script body, so a one-line prefix
// rebinds it to a view whose loadFontAsync loads each family|style once
// (Proxy over {}: figma's own properties are non-configurable). Same line as
// the script, so error line numbers stay. (2): diff is not forwarded.
// ------------------------------------------------------------------
const FONT_MEMO_PRELUDE = "ensureFont = (function (real) { const m = new Map(); return function (family, style) { const k = (family || 'Inter') + '|' + (style || 'Regular'); if (!m.has(k)) m.set(k, Promise.resolve(real(family, style)).catch(e => { m.delete(k); throw e; })); return m.get(k); }; })(ensureFont); figma = (function (real) { const m = new Map(); const lf = (f) => { if (!f || !f.family) return real.loadFontAsync(f); const k = f.family + '|' + f.style; if (!m.has(k)) m.set(k, real.loadFontAsync(f).catch(e => { m.delete(k); throw e; })); return m.get(k); }; return new Proxy({}, { get(t, k) { if (k === 'loadFontAsync') return lf; const v = real[k]; return typeof v === 'function' ? v.bind(real) : v; }, set(t, k, v) { real[k] = v; return true; }, has(t, k) { return k in real; } }); })(figma); ";
const DIFF_OFF_NOTE = "diff:true was ignored: its \"before\" screenshot stalls the plugin for minutes (bench 15.10); the change ran without it.";

function withFontMemo(code) {
  return typeof code === "string" && /\b(loadFontAsync|ensureFont)\b/.test(code) ? FONT_MEMO_PRELUDE + code : code;
}

function stripFontMemoCode(code) {
  return typeof code === "string" && code.indexOf(FONT_MEMO_PRELUDE) === 0 ? code.slice(FONT_MEMO_PRELUDE.length) : code;
}

// The prelude must never show up in an error the agent reads.
function stripFontMemo(response) {
  if (!response || typeof response !== "object") return response;
  for (const k of ["error", "errorLine", "at"]) {
    if (typeof response[k] === "string" && response[k].indexOf(FONT_MEMO_PRELUDE) !== -1) response[k] = response[k].split(FONT_MEMO_PRELUDE).join("");
  }
  return response;
}

// -> null (run the script) | { type: "heavy" | "redirect" | "refuse", args, call, n }
function readGuard(code) {
  if (typeof code !== "string" || RUN_ANYWAY_RE.test(code)) return null;
  const kind = classifyScript(code, null);
  if (kind !== "read" && kind !== "stash") return null;
  const heavy = pageWideScan(code);
  if (heavy) {
    const ids = suggestInspect(code, READ_STATE.lastIds);
    const args = heavy === "reactions"
      ? (ids.node_ids ? { node_ids: ids.node_ids, view: "flow" } : { view: "flow" })
      : (ids.find || ids.node_ids ? ids : { view: "map" });
    return { type: "heavy", args, call: "figma_inspect " + JSON.stringify(args), reason: heavy, n: READ_STATE.streak };
  }
  if (!(READ_STATE.streak >= 1)) return null;
  const args = kind === "stash" ? READ_STATE.lastArgs : suggestInspect(code, READ_STATE.lastIds);
  if (!args) return null;
  READ_STATE.streak += 1;
  READ_STATE.total += 1;
  const first = !(READ_STATE.redirects > 0);
  READ_STATE.redirects = (READ_STATE.redirects || 0) + 1;
  return { type: first ? "redirect" : "refuse", args, call: "figma_inspect " + JSON.stringify(args), n: READ_STATE.streak };
}

function guardRefusal(guard) {
  const body = guard.type === "heavy"
    ? { ok: false, code: "PAGE_SCAN_BLOCKED", error: "Not run. " + PAGE_SCAN_NOTE, use_instead: guard.call + (guard.reason === "reactions" ? " — pick the section id from a view:\"map\" call if you don't have it" : "") }
    : {
        ok: false, code: "READ_REFUSED",
        error: `Not run: hand-written read #${guard.n} in a row, and no result comes back for those. Call ${guard.call} (long replies page with offset=K), or make the whole change in ONE figma_execute_code. A script that is not a read: add the comment /* run-anyway */.`,
        use_instead: guard.call
      };
  return { isError: true, content: [{ type: "text", text: toJson(body) }] };
}

// The `use_instead` field for a hand-written read, or null.
function readNudge(code, response) {
  const kind = classifyScript(code, response);
  if (kind !== "read" && kind !== "stash") {
    if (kind === "write") resetReadStreak();
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
  READ_STATE.redirects = 0;
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

        const rewrite = rewriteComponentize(args.code);
        const code = rewrite.code;
        const macro = macroGuard(code);
        if (macro) return { isError: macro.type === "overlay", content: [{ type: "text", text: toJson(macro.body) }] };
        const guard = readGuard(code);
        if (guard && guard.type === "heavy") return guardRefusal(guard);
        if (guard && guard.type === "refuse") return guardRefusal(guard);
        if (guard) {
          // 2nd read in a row: answer with what figma_inspect returns for it.
          const inspected = await sendCommandToPlugin({
            code: buildInspectCode({ ...guard.args, target: args.target }),
            description: "Inspect",
            target: args.target
          }, TIMEOUTS.normal);
          return renderPluginResponse(
            { result: applyLineOffset(inspected.result, guard.args.offset), resultStashed: inspected.resultStashed },
            null,
            {
              ...budgetOptions(args),
              lead: { redirected: `Hand-written read #${guard.n} in a row: your script was NOT run; below is ${guard.call}, which reads the same nodes. Read with figma_inspect (offset=K pages); use figma_execute_code only to change things.` }
            }
          );
        }

        const response = await sendCommandToPlugin({
          code: withFontMemo(code),
          description: desc,
          capture: capture,
          capture_node_ids: normalizedCaptureIds ? normalizedCaptureIds.split(",") : null,
          diff: false, // H5: see DIFF_OFF_NOTE
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.heavy, { escalateMs: wantsAsync ? 50 : TIMEOUTS.escalate });
        stripFontMemo(response);

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

        const ok = response && response.success !== false;
        const opened = ok ? overlayIds(code, response) : null;
        if (opened) OVERLAY_LINKED.set(opened[1], opened[0]);
        const nudge = ok ? readNudge(code, response) : null;
        const lint = [rewrite.lint, pageWideScan(code) ? "Whole-page scan: " + PAGE_SCAN_NOTE : null, args.diff === true ? DIFF_OFF_NOTE : null].filter(Boolean).join(" ");
        const lead = {};
        // done goes first: models act on the first thing they read (Argon audit #23)
        if (ok && (opened || (REACTION_MACRO_RE.test(code) && /MANUAL STEP/.test(JSON.stringify(response.result || ""))))) lead.done = overlayDone(code, opened);
        if (nudge) lead.use_instead = nudge;
        if (lint) lead.lint = lint;
        let after = ok && !nudge ? await afterWriteOutline(code, response, args.target) : null;
        if (after && lead.done) after = after.replace(OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE);
        if (after) {
          lead.after = "Already re-read for you, as they are now (no verify call needed):\n" + after;
          // "Nothing was created, modified ... no screenshot" next to a filled `after` reads as "nothing happened"
          if (typeof response.captureNote === "string" && /Nothing was created, modified/.test(response.captureNote)) response.captureNote = null;
        }
        return renderPluginResponse(response, null, {
          ...budgetOptions(args),
          lead: Object.keys(lead).length ? lead : null
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
        const plain = !args.compare && !args.like && !args.props && !args.check && (!args.view || args.view === "outline");
        const similar = plain && response.result ? similarHint(response.result.outline) : null;
        // a flow re-read after bridge.openOverlay: say the look is the manual step, not a miss
        if (response.result && typeof response.result.flow === "string" && OVERLAY_LINKED.size &&
            [...OVERLAY_LINKED.keys()].some(id => response.result.flow.indexOf("#" + id + ":") !== -1)) {
          response.result.flow = response.result.flow.replace(OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE);
        }
        return renderPluginResponse(
          { result: applyLineOffset(response.result, args.offset), resultStashed: response.resultStashed },
          null,
          { ...budgetOptions(args), kind: plain ? "inspect" : "inspect-list", lead: similar ? { similar: similar } : null }
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
          // a write that ran long gets the same re-read as one that did not (h13 T6: job_status, then a verify turn)
          let lead = null;
          try {
            const jr = snap.response;
            const ok = jr && jr.success !== false;
            const after = ok && snap.script ? await afterWriteOutline(snap.script, jr, args.target) : null;
            if (after) lead = { after: "Already re-read for you, as they are now (no verify call needed):\n" + after };
          } catch (e) { lead = null; }
          return renderPluginResponse(snap.response, { status: "done", job_id: snap.job_id }, { ...budgetOptions(args), lead });
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
    TOOLS, SERVER_INSTRUCTIONS, ECONOMY, TIMEOUTS, CAPS_NOTE, WHAT_YOU_GET,
    shrinkToBudget, pngSize, collectImages, buildStructuredResult, captureOptions, getActiveTools,
    buildInspectCode, applyTokenBudget, byteLength, outputBudgetInfo, truncationNote, similarHint, afterWriteOutline, readNudge, classifyScript, suggestInspect, READ_STATE, resetReadStreak, readGuard, guardRefusal, pageWideScan, macroGuard, overlayCall, overlayDone, OVERLAY_LINKED, resultIds, overlayIds, withFontMemo, stripFontMemo, FONT_MEMO_PRELUDE, rewriteComponentize, compressValidationError, readJobSnapshot, jobs, MCP_CLIENT, activeOutputCeiling, applyLineOffset, checkAgentSyntax, buildErrorEnvelope
  };
}
