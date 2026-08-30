// Smoke test for the MCP stdio protocol layer (figma/index.js). Run:
// node tests/mcp-protocol.test.js
//
// Spawns the real server as a child process and talks NDJSON to it over
// stdio — the same transport an MCP client uses — rather than importing
// index.js directly. index.js binds :8765 as a side effect of module load
// (the WebSocket bridge), so importing it in-process would either fail or
// silently fight a real running instance; spawning a child process is the
// only way to exercise the stdio protocol in isolation. This also means the
// child's own :8765 bind is expected to no-op if something else already
// owns the port on this machine (see tryBecomeMaster in index.js) — the
// tests below never depend on that succeeding.
const path = require("path");
const { spawn } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "figma", "index.js");

function startServer(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {}); // startup warnings (e.g. no FIGMA_BRIDGE_TOKEN) are expected noise here

  let buffer = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (waiters.length > 0) waiters.shift()(msg);
    }
  });

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function nextMessage(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a server response")), timeoutMs);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  }

  async function call(method, params) {
    const id = Math.floor(Math.random() * 1e9);
    send({ jsonrpc: "2.0", id, method, params });
    const res = await nextMessage();
    if (res.id !== id) throw new Error(`response id mismatch: expected ${id}, got ${res.id}`);
    return res;
  }

  // index.js listens for `process.stdin.on("close", cleanup)` as its graceful
  // shutdown path (the same one a real MCP client disconnecting triggers) —
  // ending stdin exercises that path. child.kill() alone was observed to
  // leave the child running and still bound to :8765 in this environment, so
  // it's kept only as a timed fallback, and stop() waits for actual exit so
  // the next spawned server in this suite doesn't race it for the port.
  const stop = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", finish);
    try { child.stdin.end(); } catch (e) {}
    const fallback = setTimeout(() => { try { child.kill(); } catch (e) {} }, 500);
    child.once("exit", () => clearTimeout(fallback));
    setTimeout(finish, 3000); // last resort so a stuck child can't hang the suite
  });

  return { child, send, call, stop };
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

async function main() {
  console.log("\n== initialize / tools/list (no FIGMA_PERSONAL_ACCESS_TOKEN) ==");
  const server = startServer({ FIGMA_PERSONAL_ACCESS_TOKEN: "", FIGMA_API_KEY: "", FIGMA_MCP_LEGACY_TOOLS: "" });
  try {
    const init = await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    check("initialize responds with serverInfo.name", init.result && init.result.serverInfo && init.result.serverInfo.name === "figma-mcp", init);
    check("initialize advertises tools capability", init.result && init.result.capabilities && "tools" in init.result.capabilities, init);
    check("initialize instructions mention figma_read_canvas", /figma_read_canvas/.test(init.result.instructions || ""), init.result && init.result.instructions);

    const list = await server.call("tools/list", {});
    const names = (list.result.tools || []).map(t => t.name);
    check("core LIVE tools are present", names.includes("figma_execute_code") && names.includes("figma_read_canvas") && names.includes("figma_rollback"), names);
    check("REST tools are HIDDEN without a token (tool-tiering, §4.7)", !names.includes("get_file") && !names.includes("get_styles"), names);
    check("legacy tools are hidden by default", !names.includes("figma_create_ui_card") && !names.includes("get_me"), names);
    check("no duplicate tool names", new Set(names).size === names.length, names);
    for (const t of list.result.tools) {
      check(`tool "${t.name}" has a non-empty description`, typeof t.description === "string" && t.description.length > 10);
      check(`tool "${t.name}" declares an object inputSchema`, t.inputSchema && t.inputSchema.type === "object");
    }

    console.log("\n== figma_list_targets (pure server state, no plugin needed) ==");
    const targets = await server.call("tools/call", { name: "figma_list_targets", arguments: {} });
    const targetsBody = JSON.parse(targets.result.content[0].text);
    check("figma_list_targets returns ok:true with an empty list (no plugin connected)", targetsBody.ok === true && Array.isArray(targetsBody.targets) && targetsBody.targets.length === 0, targetsBody);

    console.log("\n== unknown tool produces a structured error envelope (§4.7) ==");
    const unknown = await server.call("tools/call", { name: "not_a_real_tool", arguments: {} });
    const unknownBody = JSON.parse(unknown.result.content[0].text);
    check("unknown tool call is flagged isError", unknown.result.isError === true, unknown.result);
    check("unknown tool error carries a machine-readable code", unknownBody.ok === false && unknownBody.code === "UNKNOWN_TOOL", unknownBody);

    // A figma_execute_code call with no plugin connected is NOT exercised here:
    // by design (§4.3 Job Ledger) it now takes at least TIMEOUTS.escalate
    // (30s) before resolving into anything, which is a bad trade for a smoke
    // test that should run in a couple of seconds. That path is covered
    // functionally by sendCommandToPlugin's own timer logic and by manual
    // testing against a real plugin.
  } finally {
    await server.stop();
  }

  console.log("\n== tool tiering WITH a REST token set ==");
  const serverWithToken = startServer({ FIGMA_PERSONAL_ACCESS_TOKEN: "test-token-not-real", FIGMA_MCP_LEGACY_TOOLS: "" });
  try {
    const list2 = await serverWithToken.call("tools/list", {});
    const names2 = (list2.result.tools || []).map(t => t.name);
    check("REST tools appear once a token is configured", names2.includes("get_file") && names2.includes("get_styles"), names2);
    check("legacy tools stay hidden even with a token (needs FIGMA_MCP_LEGACY_TOOLS=1)", !names2.includes("get_me"), names2);
  } finally {
    await serverWithToken.stop();
  }

  console.log("\n== legacy tools opt-in via FIGMA_MCP_LEGACY_TOOLS=1 ==");
  const serverLegacy = startServer({ FIGMA_PERSONAL_ACCESS_TOKEN: "", FIGMA_MCP_LEGACY_TOOLS: "1" });
  try {
    const list3 = await serverLegacy.call("tools/list", {});
    const names3 = (list3.result.tools || []).map(t => t.name);
    check("legacy tools appear with the opt-in flag", names3.includes("figma_create_ui_card") && names3.includes("get_me"), names3);
  } finally {
    await serverLegacy.stop();
  }

  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
