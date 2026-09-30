// Smoke test for the MCP stdio protocol layer (figma/index.js). Run:
// node tests/mcp-protocol.test.js
//
// Spawns the real server as a child process and talks NDJSON to it over
// stdio — the same transport an MCP client uses. index.js binds :8765 (the
// WebSocket bridge) when run as a program; require()-ing it only exposes pure
// helpers (see tests/token-economy.test.js). Servers that could reach a live
// bridge get their own FIGMA_BRIDGE_PORT; the rest never call a LIVE tool.
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
  // Own port: figma_list_targets on a PROXY now reports the master's plugins,
  // so on a machine with a live bridge on 8765 this would not be empty.
  const server = startServer({ FIGMA_PERSONAL_ACCESS_TOKEN: "", FIGMA_API_KEY: "", FIGMA_MCP_LEGACY_TOOLS: "", FIGMA_BRIDGE_PORT: "18764" });
  try {
    const init = await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    check("initialize responds with serverInfo.name", init.result && init.result.serverInfo && init.result.serverInfo.name === "figma-mcp", init);
    check("initialize advertises tools capability", init.result && init.result.capabilities && "tools" in init.result.capabilities, init);
    check("serverInfo.version is 4.2.1", init.result.serverInfo.version === "4.2.1", init.result.serverInfo);
    check("initialize instructions mention figma_read_canvas", /figma_read_canvas/.test(init.result.instructions || ""), init.result && init.result.instructions);

    const list = await server.call("tools/list", {});
    const names = (list.result.tools || []).map(t => t.name);
    check("core LIVE tools are present", names.includes("figma_execute_code") && names.includes("figma_read_canvas") && names.includes("figma_rollback"), names);
    check("REST tools are HIDDEN without a token (tool-tiering, §4.7)", !names.includes("get_file") && !names.includes("get_styles"), names);
    check("legacy tools are hidden by default", !names.includes("figma_create_ui_card") && !names.includes("get_me"), names);
    check("no duplicate tool names", new Set(names).size === names.length, names);
    const byName = Object.fromEntries(list.result.tools.map(t => [t.name, t]));
    const inspectProps = (byName.figma_inspect && byName.figma_inspect.inputSchema.properties) || {};
    check("figma_inspect declares view (outline|map), context, find_text and offset",
      inspectProps.view && inspectProps.view.enum.join() === "outline,map" && inspectProps.context.type === "boolean" &&
      inspectProps.find_text.type === "string" && inspectProps.offset.type === "number", Object.keys(inspectProps));
    check("figma_inspect props description mentions reactions and connector", /reactions/.test(inspectProps.props.description) && /connector/.test(inspectProps.props.description));
    check("figma_execute_code description lists the bridge macros",
      /replaceWithInstance/.test(byName.figma_execute_code.description) && /fitSection/.test(byName.figma_execute_code.description) && /bridge\.context/.test(byName.figma_execute_code.description));
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

    console.log("\n== figma_execute_code Fail-Fast with no plugin connected (BUG_REPORT_PORT_PROXY_RECONNECT.md §C) ==");
    // Used to hang until TIMEOUTS.escalate (30s) — sendCommandToPlugin now
    // rejects immediately with NO_CONNECTED_CLIENTS when there are zero WS
    // clients and no recent /poll heartbeat, so this must resolve in well
    // under a second, not 30s. Runs in its own server on a dedicated port
    // (not the shared 8765 the rest of this file deliberately avoids relying
    // on) so this assertion always exercises the master code path, even on a
    // machine where a real bridge instance already owns 8765.
    const masterServer = startServer({ FIGMA_PERSONAL_ACCESS_TOKEN: "", FIGMA_MCP_LEGACY_TOOLS: "", FIGMA_BRIDGE_PORT: "18765" });
    try {
      const execStart = Date.now();
      const exec = await masterServer.call("tools/call", { name: "figma_execute_code", arguments: { code: "1+1" } });
      const execElapsed = Date.now() - execStart;
      const execBody = JSON.parse(exec.result.content[0].text);
      check("figma_execute_code fails fast (< 5s) with no plugin connected", execElapsed < 5000, execElapsed);
      check("figma_execute_code with no plugin connected is flagged isError", exec.result.isError === true, exec.result);
      check("figma_execute_code with no plugin connected carries NO_CONNECTED_CLIENTS", execBody.ok === false && execBody.code === "NO_CONNECTED_CLIENTS", execBody);

      // A syntax error must be caught BEFORE the plugin is involved: with no
      // plugin connected it would otherwise come back as NO_CONNECTED_CLIENTS.
      const bad = await masterServer.call("tools/call", { name: "figma_execute_code", arguments: { code: "const a = 1;\nconst b = 2;\nconst c = ;\nreturn a;" } });
      const badBody = JSON.parse(bad.result.content[0].text);
      check("a syntax error is reported as SCRIPT_SYNTAX_ERROR without reaching the plugin", bad.result.isError === true && badBody.code === "SCRIPT_SYNTAX_ERROR", badBody);
      check("...with the line of the agent's code (3) and that line", badBody.line === 3 && badBody.at === "const c = ;", badBody);
      check("...and the async-function-body hint", /async function body/.test(badBody.error) && /import\/export/.test(badBody.error), badBody);
    } finally {
      await masterServer.stop();
    }
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
