#!/usr/bin/env node
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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
//   2. Shared token — install.py generates one, puts it in the MCP config env
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
  return isOriginAllowed(req) && hasValidToken(req);
}

// Commands queue instead of overwriting a single slot: two tool calls issued
// while the plugin is offline used to clobber each other, and the loser only
// surfaced as a timeout 40s later.
const pendingCommands = [];
let commandResolvers = new Map();
let lastPluginPing = 0;
const wsClients = new Set();

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
    client.send(pendingCommands.shift());
  }

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
        wsClients.delete(client);
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
        wsClients.delete(client);
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
          wsClients.delete(client);
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
    wsClients.delete(client);
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

  if (data.type === "CLIENT_FOCUS" || data.type === "CLIENT_READY") {
    client.lastSeen = Date.now();
    return;
  }

  if (data.id && commandResolvers.has(data.id)) {
    const resolver = commandResolvers.get(data.id);
    resolver(data);
    commandResolvers.delete(data.id);
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
             "If you are the plugin, make sure install.py baked the matching bridge token into it."
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
        const resolver = commandResolvers.get(data.id);
        if (resolver) {
          resolver(data);
          commandResolvers.delete(data.id);
        }
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
        const result = await sendCommandToPlugin(payload, payload.timeoutMs || 45000);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    }).catch((err) => {
      if (res.writableEnded) return;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  if (pathname === "/status") {
    const isOnline = wsClients.size > 0 || (Date.now() - lastPluginPing) < 60000;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      connected: isOnline,
      wsClients: wsClients.size,
      lastPing: lastPluginPing
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
          "Only the Origin allowlist is protecting :8765 — re-run install.py to provision a token."
        );
      }
    });
  } catch (e) {
    listenAttemptInFlight = false;
  }
}

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

async function sendCommandToPlugin(payload, timeoutMs = 45000) {
  if (!isBridgeMaster) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {})
        },
        body: JSON.stringify({ ...payload, timeoutMs })
      });
      if (!res.ok) {
        const errText = await res.text();
        let detail = errText;
        try { detail = JSON.parse(errText).error || errText; } catch (e) {}
        throw new Error(`Bridge proxy error (HTTP ${res.status}): ${detail}`);
      }
      const data = await res.json();
      if (data.success) return data;
      throw new Error(data.error || "Execution failed in Figma sandbox");
    } catch (err) {
      // The owner of :8765 is gone — claim the port ourselves so the NEXT call
      // succeeds instead of failing forever.
      const cause = err && err.cause ? err.cause.code : null;
      if (cause === "ECONNREFUSED" || cause === "ECONNRESET" || /fetch failed/i.test(err.message || "")) {
        tryBecomeMaster();
        throw new Error(
          "The bridge instance that owned :8765 is no longer running. This server is taking the port over — retry the call."
        );
      }
      throw new Error(err.message || "Failed to communicate with Figma Bridge server on :8765");
    }
  }

  return new Promise((resolve, reject) => {
    const id = "cmd_" + Math.random().toString(36).substring(2, 9);
    const cmd = { id, ...payload };

    const timer = setTimeout(() => {
      commandResolvers.delete(id);
      const queuedAt = pendingCommands.findIndex(c => c.id === id);
      if (queuedAt !== -1) pendingCommands.splice(queuedAt, 1);
      reject(new Error("Timeout waiting for Figma Plugin response. Ensure Figma is active and Antigravity Bridge plugin is running."));
    }, timeoutMs);

    commandResolvers.set(id, (response) => {
      clearTimeout(timer);
      if (response.success) {
        resolve(response);
      } else {
        reject(new Error(response.error || "Execution failed in Figma sandbox"));
      }
    });

    // 1. Direct WebSocket Push (0ms latency)
    if (wsClients.size > 0) {
      const activeClient = [...wsClients].sort((a, b) => b.lastSeen - a.lastSeen)[0];
      activeClient.send(cmd);
    } else {
      // 2. Queue for incoming WebSocket connection or HTTP long-poll
      pendingCommands.push(cmd);
    }
  });
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
    // Kept deliberately short. The full execution model lives in
    // SERVER_INSTRUCTIONS, which the client receives once on `initialize`;
    // repeating it here re-sent ~1.2k tokens of identical prose on every turn.
    description: "EXECUTE LIVE JAVASCRIPT inside the open Figma document to create, edit, move, style, color or delete canvas elements (requires the 'Antigravity Bridge' plugin running in Figma Desktop). Injected globals: `figma`, `await ensureFont(family, style)`, `getFreePosition(w, h)`, `bridge`. Each call is a FRESH async function body — declarations do not survive into the next call; persist helpers with `bridge.define`/`bridge.require` and never use `eval`. Run `return bridge.info()` for the full runtime contract, or read this server's instructions. Set `capture: true` to get a PNG back for visual verification.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript to run in the Figma sandbox, compiled as an async function body (top-level await and return allowed; import/export are not). Example: const frame = figma.createFrame(); frame.resize(400, 600); frame.name = 'Card'; figma.currentPage.appendChild(frame); figma.currentPage.selection = [frame]; return 'Created frame';"
        },
        description: {
          type: "string",
          description: "Short human-readable description of the action (e.g. 'Create login modal', 'Update brand colors') shown in Figma toasts and logs."
        },
        capture: {
          type: "boolean",
          description: "Set to true to immediately take a PNG screenshot of the selected/created UI elements and return it to the model for visual verification (Visual Feedback Loop)."
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1.5)."
        }
      },
      required: ["code"]
    }
  },
  {
    name: "figma_screenshot",
    description: "Capture a visual PNG screenshot of specific nodes or the current selection in Figma. Highly recommended after UI modifications to inspect layout alignment, contrast, typography, and spacing.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
          description: "Optional comma-separated list of Figma node IDs to screenshot (e.g. '123:456, 123:457'). If omitted, captures current selection or entire page."
        },
        scale: {
          type: "number",
          description: "Export resolution scale factor (default: 1.5)."
        },
        description: {
          type: "string",
          description: "Optional action description for Figma toast and logs."
        }
      }
    }
  },
  {
    name: "figma_get_selection",
    description: "Get information and properties (dimensions, coordinates, text, fills) of the currently selected nodes on the Figma canvas.",
    inputSchema: {
      type: "object",
      properties: {}
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
        }
      }
    }
  },
  {
    name: "figma_insert_component_instance",
    description: "Create and insert an instance of a master component or component set into the canvas or target AutoLayout container. Supports selecting variants, applying text overrides with auto font loading, and returns a PNG screenshot for visual verification.",
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
          description: "Whether to automatically capture and return a PNG screenshot of the inserted instance (default: true)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1.5)"
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
          description: "Whether to capture a PNG screenshot of the target after switching mode (default: true)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1.5)"
        }
      },
      required: ["collection_name", "mode_name"]
    }
  },
  {
    name: "figma_insert_svg",
    description: "Insert raw SVG/vector code directly into Figma canvas or target AutoLayout container with automatic scale-proportional resizing, fill/stroke color overrides, optional component creation, and visual PNG screenshot return.",
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
          description: "Whether to automatically capture and return a PNG screenshot of the inserted SVG (default: true)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale factor (default: 2.0)"
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
        max_depth: { type: "number", description: "Hard cap on tree traversal depth before nodes are truncated (default: 25)" }
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
        max_depth: { type: "number", description: "Hard cap on tree traversal depth before nodes are truncated (default: 25)" }
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
// Server-level instructions handed to the MCP client on initialize, plus
// hints appended to failures that never reach the Figma sandbox.
// ==========================================================================
const SERVER_INSTRUCTIONS = [
  "Figma MCP Bridge — two modes: LIVE (read/write on the open Figma Desktop document via the Antigravity Bridge plugin) and REST (read-only cloud access to files/nodes/styles with a token optimizer).",
  "",
  "figma_execute_code execution model (read before writing any code):",
  "1. Each call is compiled as a FRESH async function body. Top-level `await` and `return` work; `import`/`export` do not.",
  "2. Top-level `const`/`let`/`var`/`function` declarations DO NOT survive into the next call.",
  "3. `eval()` is a bound function in the Figma sandbox, so every eval is an INDIRECT eval: it cannot see the caller's locals and its declarations reach neither the caller nor globalThis. Never use eval to build reusable helpers — it fails silently.",
  "4. Persist code with `bridge.define(name, source)` (source must end in `module.exports = { ... }`) and reload it in later calls with `bridge.require(name)`. Persist data with `bridge.store.set/get` (durable, lives in the .fig file) or `bridge.state` (scratch, cleared on plugin reload).",
  "5. `return bridge.info()` reports the live runtime contract, injected globals, defined modules and stored keys.",
  "",
  "Known Figma platform limits the bridge wraps for you:",
  "- x/y of a node inside an INSTANCE cannot be set (relative-transform is not overridable). Position through AutoLayout, or edit the master component. `bridge.setPosition(node, x, y)` raises this early with the remedy.",
  "- `figma.createComponentFromNode()` can freeze AutoLayout sizing modes to FIXED across the whole subtree and changes node ids. Use `bridge.componentize(node)` instead.",
  "- Fonts must be loaded before touching text: `await ensureFont(family, style)`.",
  "- Colors are floats in 0..1, not 0..255.",
  "",
  "Always close the visual loop: pass `capture: true` or call figma_screenshot after changing the canvas, and inspect the returned PNG before declaring the task done."
].join("\n");

const SERVER_ERROR_HINTS = [
  {
    test: /timeout|not connected|8765|bridge/i,
    hint: "The Figma plugin did not answer. Ask the user to open Figma DESKTOP (not the browser) and launch the Antigravity Bridge plugin (Ctrl+Alt+P / Cmd+Option+P) until the status shows CONNECTED, then retry."
  },
  {
    test: /FIGMA_PERSONAL_ACCESS_TOKEN|401|403|Unauthorized/i,
    hint: "REST tools need FIGMA_PERSONAL_ACCESS_TOKEN in the MCP server environment. Live tools (figma_execute_code, figma_screenshot, ...) work without a token — prefer them when the file is open in Figma Desktop."
  },
  {
    test: /Unknown tool/i,
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

function withServerHint(message) {
  if (/\bHINT:/.test(message)) return message; // plugin already explained it
  for (const rule of SERVER_ERROR_HINTS) {
    if (rule.test.test(message)) return message + "\n\nHINT: " + rule.hint;
  }
  return message;
}

async function handleCallTool(name, args = {}) {
  try {
    switch (name) {
      case "figma_execute_code": {
        const desc = args.description || "Execute JS Code";
        const capture = args.capture === true;
        const scale = args.scale || 1.5;
        const response = await sendCommandToPlugin({
          code: args.code,
          description: desc,
          capture: capture,
          scale: scale
        }, 40000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma Execution Result: ${resText}`
        });

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

      case "figma_screenshot": {
        const desc = args.description || "Figma Screenshot";
        const response = await sendCommandToPlugin({
          type: "SCREENSHOT",
          nodeIds: normalizeNodeIds(args.node_ids),
          scale: args.scale || 1.5,
          description: desc
        }, 40000);

        const content = [];
        content.push({
          type: "text",
          text: `Figma Screenshot: ${response.result || "Captured"}`
        });

        if (response.screenshots && Array.isArray(response.screenshots)) {
          for (const item of response.screenshots) {
            if (item.base64) {
              const cleanB64 = item.base64.replace(/^data:image\/\w+;base64,/, "");
              content.push({
                type: "image",
                data: cleanB64,
                mimeType: "image/png"
              });
            }
          }
        } else if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      case "figma_get_selection": {
        const code = `
          const selection = figma.currentPage.selection;
          return selection.map(node => ({
            id: node.id,
            name: node.name,
            type: node.type,
            width: node.width,
            height: node.height,
            x: node.x,
            y: node.y,
            fills: node.fills,
            characters: node.characters
          }));
        `;
        const response = await sendCommandToPlugin({ code, description: "Get Selected Nodes" });
        return {
          content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }]
        };
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
          capture: true
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
          limit: args.limit || 30
        }, 30000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.result, null, 2)
          }]
        };
      }

      case "figma_insert_component_instance": {
        const capture = args.capture !== false;
        const scale = args.scale || 1.5;
        const response = await sendCommandToPlugin({
          type: "INSERT_COMPONENT_INSTANCE",
          component_name: args.component_name,
          component_id: args.component_id,
          properties: args.properties || {},
          text_overrides: args.text_overrides || {},
          target_parent_id: args.target_parent_id,
          position: args.position,
          capture: capture,
          scale: scale
        }, 40000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma Component Instance Inserted: ${resText}`
        });

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

      case "figma_get_variables": {
        const response = await sendCommandToPlugin({
          type: "GET_VARIABLES",
          collection_name: args.collection_name,
          limit: args.limit || 300
        }, 30000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.result, null, 2)
          }]
        };
      }

      case "figma_set_variables_mode": {
        const capture = args.capture !== false;
        const scale = args.scale || 1.5;
        const response = await sendCommandToPlugin({
          type: "SET_VARIABLES_MODE",
          collection_name: args.collection_name,
          mode_name: args.mode_name,
          target_id: args.target_id,
          capture: capture,
          scale: scale
        }, 35000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma Variable Mode Updated: ${resText}`
        });

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

      case "figma_insert_svg": {
        const capture = args.capture !== false;
        const scale = args.scale || 2.0;
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
          scale: scale
        }, 40000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma SVG Vector Inserted: ${resText}`
        });

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

      case "figma_get_canvas_layout": {
        const response = await sendCommandToPlugin({
          type: "GET_CANVAS_LAYOUT",
          direction: args.direction || "RIGHT",
          gap: args.gap || 80,
          limit: args.limit || 200
        }, 30000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.result, null, 2)
          }]
        };
      }

      // REST API
      case "get_me": {
        const data = await figmaApiRequest("/me");
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_file": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const depth = args.depth || 2;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}?depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const output = optimizeFigmaData(data, {
          format,
          simplify,
          maxDepth: args.max_depth || 25,
          includeHidden: args.include_hidden === true
        });
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
        const output = optimizeFigmaData(data, {
          format,
          simplify,
          maxDepth: args.max_depth || 25,
          includeHidden: args.include_hidden === true
        });
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
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_image_fills": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/images`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_styles": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/styles`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_components": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/components`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_comments": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Figma Error: ${withServerHint(error.message || String(error))}` }]
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
        version: "2.2.0"
      }, {
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS
      });

      server.setRequestHandler(types.ListToolsRequestSchema, async () => {
        return { tools: TOOLS };
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
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "figma-mcp", version: "2.2.0" },
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
      sendResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
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

// Start either official SDK server or universal stdio engine
if (!startOfficialSdkServer()) {
  startUniversalStdioServer();
}
