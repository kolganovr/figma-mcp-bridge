// End-to-end contract for the token-economy behaviour of figma/index.js. Run:
// node tests/token-economy.test.js
//
// Spawns real server processes on a dedicated port (never the shared 8765,
// so a live bridge on this machine is never touched) and connects a FAKE
// plugin over a real WebSocket. The fake plugin answers commands by a tiny
// script language in `code` ("ok", "big", "slow:<ms>", "hang") and records
// what it was sent, so the tests can assert on both directions of the wire.
// Needs Node >= 22 (global WebSocket).
const path = require("path");
const { spawn } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "figma", "index.js");
const PORT = 18766;
const TOKEN = "economy-test-token";
const BASE_ENV = {
  FIGMA_BRIDGE_PORT: String(PORT),
  FIGMA_BRIDGE_TOKEN: TOKEN,
  FIGMA_PERSONAL_ACCESS_TOKEN: "",
  FIGMA_API_KEY: "",
  FIGMA_MCP_LEGACY_TOOLS: "",
  FIGMA_MCP_NO_UPDATE_CHECK: "1",
  FIGMA_MCP_ESCALATE_MS: "600",
  FIGMA_MCP_TIMEOUT_MS: "1500",
  FIGMA_MCP_RECONNECT_GRACE_MS: "4000"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...BASE_ENV, ...(env || {}) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});

  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });

  function call(method, params, timeoutMs = 20000) {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function tool(name, args) {
    const res = await call("tools/call", { name, arguments: args || {} });
    const content = res.result.content || [];
    const text = content.find(c => c.type === "text");
    let body = null;
    try { body = JSON.parse(text.text); } catch (e) {}
    return { isError: res.result.isError === true, text: text ? text.text : "", body, images: content.filter(c => c.type === "image") };
  }

  const stop = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", finish);
    try { child.stdin.end(); } catch (e) {}
    const fallback = setTimeout(() => { try { child.kill(); } catch (e) {} }, 500);
    child.once("exit", () => clearTimeout(fallback));
    setTimeout(finish, 3000);
  });

  return { call, tool, stop };
}

function fakePng(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
}

// A plugin stand-in: connects like ui.html does and answers like code.js does.
function startFakePlugin() {
  const received = [];
  let busy = false;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  const reply = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "RESULT", success: true, ...msg }));
  ws.onmessage = async (event) => {
    const cmd = JSON.parse(event.data);
    if (!cmd.id) return;
    received.push(cmd);
    const type = cmd.type || "EXECUTE";
    if (type === "EXECUTE") {
      if (cmd.code === "ok") return reply({ id: cmd.id, result: { done: true }, resultStashed: true, checkpointId: "cp_1" });
      if (cmd.code === "big") {
        const rows = Array.from({ length: 400 }, (_, i) => ({ id: "1:" + i, name: "Row " + i, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] }));
        return reply({ id: cmd.id, result: { rows }, resultStashed: true });
      }
      const slow = /^slow:(\d+)$/.exec(cmd.code || "");
      if (slow) { await sleep(Number(slow[1])); return reply({ id: cmd.id, result: { slept: Number(slow[1]) }, resultStashed: true }); }
      if (cmd.code === "hang") { busy = true; return; } // never answers, like a frozen sandbox
      return reply({ id: cmd.id, result: null });
    }
    if (busy) return; // single-threaded sandbox: nothing else gets through
    if (type === "SCREENSHOT") {
      return reply({
        id: cmd.id, result: "Captured 5 node(s)",
        screenshots: [1, 2, 3, 4, 5].map(i => ({ id: "9:" + i, name: "Frame " + i, base64: fakePng(800, 600) }))
      });
    }
    return reply({ id: cmd.id, result: "ok" });
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "CLIENT_READY", fileName: "Economy Test File", pageName: "Page 1", pluginVersion: "4.1.0" }));
      resolve();
    };
    ws.onerror = reject;
  });
  return { ws, received, opened, close: () => ws.close() };
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 600) : "")); }
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.log("SKIP: needs Node >= 22 (global WebSocket)");
    return;
  }

  const master = startServer();
  await master.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } })
    .then(init => {
      console.log("\n== instructions and schemas ==");
      const text = init.result.instructions || "";
      check("instructions fit the ~2000-char cut some clients apply", text.length <= 2000, text.length);
      check("instructions lead with the token-economy rules", text.indexOf("TOKEN ECONOMY") > -1 && text.indexOf("TOKEN ECONOMY") < 300);
    });
  const list = await master.call("tools/list", {});
  const byName = Object.fromEntries(list.result.tools.map(t => [t.name, t]));
  check("figma_job_status takes wait_ms", !!byName.figma_job_status.inputSchema.properties.wait_ms);
  check("figma_screenshot takes max_px", !!byName.figma_screenshot.inputSchema.properties.max_px);
  check("figma_execute_code takes max_output_chars and max_px",
    !!byName.figma_execute_code.inputSchema.properties.max_output_chars && !!byName.figma_execute_code.inputSchema.properties.max_px);

  await sleep(300); // let the master bind before the plugin dials in
  let plugin = startFakePlugin();
  await plugin.opened;
  await sleep(100);

  try {
    console.log("\n== compact envelope + output budget ==");
    const ok = await master.tool("figma_execute_code", { code: "ok" });
    check("small result comes back whole", ok.body && ok.body.ok === true && ok.body.result.done === true, ok.text);
    check("envelope is compact JSON (no pretty-print whitespace)", !/\n\s+"/.test(ok.text), ok.text);
    const execCmd = plugin.received[plugin.received.length - 1];
    check("plugin is sent scale 1 and max_px 1024 by default", execCmd.scale === 1 && execCmd.max_px === 1024, execCmd);

    const big = await master.tool("figma_execute_code", { code: "big" });
    check("oversized result is shrunk under the default budget", big.text.length < 6800, big.text.length);
    check("shrunk result says so and points at bridge.state.lastResult",
      big.body && /shrunk \d+→\d+/.test(big.body.truncated) && /bridge\.state\.lastResult/.test(big.body.truncated), big.body && big.body.truncated);
    check("shrunk result keeps its shape (rows array + more-marker)",
      Array.isArray(big.body.result.rows) && /more \(400 total\)/.test(big.body.result.rows[big.body.result.rows.length - 1]));
    const full = await master.tool("figma_execute_code", { code: "big", max_output_chars: 0 });
    check("max_output_chars: 0 disables the cap", full.body && full.body.result.rows.length === 400 && !full.body.truncated);

    console.log("\n== long-poll jobs ==");
    const t0 = Date.now();
    const escalated = await master.tool("figma_execute_code", { code: "slow:2000" });
    check("a call past the escalate window comes back as a job", escalated.body && escalated.body.status === "running" && /^cmd_/.test(escalated.body.job_id), escalated.text);
    const peek = await master.tool("figma_job_status", { job_id: escalated.body.job_id, wait_ms: 0 });
    check("wait_ms: 0 peeks without blocking", peek.body && peek.body.status === "running" && peek.body.elapsed_ms >= 500, peek.body);
    const done = await master.tool("figma_job_status", { job_id: escalated.body.job_id });
    check("ONE default figma_job_status call blocks until the job is done", done.body && done.body.status === "done" && done.body.result.slept === 2000, done.body);
    check("...and returns right when it finishes, not at the wait limit", Date.now() - t0 < 4500, Date.now() - t0);
    const again = await master.tool("figma_job_status", { job_id: escalated.body.job_id, wait_ms: 0 });
    check("a finished job is read once", again.isError && again.body.code === "JOB_NOT_FOUND", again.body);

    console.log("\n== PLUGIN_BUSY instead of a bare timeout ==");
    const hang = await master.tool("figma_execute_code", { code: "hang", async: true, description: "Heavy build" });
    check("async: true hands back a job immediately", hang.body && hang.body.status === "running", hang.text);
    const blocked = await master.tool("figma_screenshot", { node_ids: "1:2" });
    check("a call stuck behind a running job fails as PLUGIN_BUSY naming that job",
      blocked.isError && blocked.body.code === "PLUGIN_BUSY" && blocked.body.error.indexOf(hang.body.job_id) > -1 && /Heavy build/.test(blocked.body.error), blocked.body);

    console.log("\n== plugin disconnect settles running jobs ==");
    const waitStart = Date.now();
    const waiting = master.tool("figma_job_status", { job_id: hang.body.job_id });
    await sleep(300);
    plugin.close();
    const lost = await waiting;
    check("a blocked figma_job_status wakes up with PLUGIN_DISCONNECTED", lost.isError && lost.body.code === "PLUGIN_DISCONNECTED", lost.body);
    check("...right away, not after the wait limit", Date.now() - waitStart < 3000, Date.now() - waitStart);

    console.log("\n== reconnect grace ==");
    await sleep(200);
    const graceStart = Date.now();
    const pendingCall = master.tool("figma_execute_code", { code: "ok" });
    await sleep(1000);
    plugin = startFakePlugin();
    await plugin.opened;
    const afterReload = await pendingCall;
    check("a call made while the plugin reloads waits for it instead of failing", afterReload.body && afterReload.body.ok === true, afterReload.body);
    check("...and completes as soon as the plugin is back", Date.now() - graceStart < 3500, Date.now() - graceStart);

    console.log("\n== screenshots: aliases, image cap, sizes ==");
    const shot = await master.tool("figma_screenshot", { node_id: "1-2" });
    const shotCmd = plugin.received[plugin.received.length - 1];
    check("node_id alias reaches the plugin as nodeIds (not the selection)", shotCmd.nodeIds === "1:2", shotCmd);
    check("screenshot defaults: scale 1, max_px 1024", shotCmd.scale === 1 && shotCmd.max_px === 1024, shotCmd);
    check("at most 3 images per response", shot.images.length === 3, shot.images.length);
    check("the rest is reported, not silently dropped", /2 more image/.test(shot.body.images_skipped || ""), shot.body);
    check("each image is described with size and token cost", shot.body.images[0] === "Frame 1 800x600 ~640tok", shot.body.images);

    console.log("\n== capture is opt-in for insert/mode tools ==");
    await master.tool("figma_insert_component_instance", { component_name: "Button" });
    const insCmd = plugin.received[plugin.received.length - 1];
    check("insert_component_instance sends capture:false by default", insCmd.type === "INSERT_COMPONENT_INSTANCE" && insCmd.capture === false, insCmd);
    await master.tool("figma_insert_svg", { svg_code: "<svg/>" });
    const svgCmd = plugin.received[plugin.received.length - 1];
    check("insert_svg sends capture:false, keeps 2x for icons, still capped by max_px", svgCmd.capture === false && svgCmd.scale === 2 && svgCmd.max_px === 1024, svgCmd);

    console.log("\n== proxy (second agent on the same machine) ==");
    const proxy = startServer();
    await proxy.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy", version: "0" } });
    await sleep(500);
    try {
      const targets = await proxy.tool("figma_list_targets");
      check("list_targets through a proxy shows the master's plugins", targets.body && targets.body.targets.length === 1 && targets.body.targets[0].fileName === "Economy Test File", targets.body);
      const viaProxy = await proxy.tool("figma_execute_code", { code: "slow:1500" });
      check("a long call through a proxy escalates to a job instead of 'master stopped responding'", viaProxy.body && viaProxy.body.status === "running", viaProxy.text);
      const proxyDone = await proxy.tool("figma_job_status", { job_id: viaProxy.body.job_id });
      check("figma_job_status through a proxy reaches the master's ledger and blocks until done", proxyDone.body && proxyDone.body.status === "done" && proxyDone.body.result.slept === 1500, proxyDone.body);
      const quick = await proxy.tool("figma_execute_code", { code: "ok" });
      check("a quick call through a proxy returns normally", quick.body && quick.body.ok === true && quick.body.result.done === true, quick.body);
    } finally {
      await proxy.stop();
    }
  } finally {
    try { plugin.close(); } catch (e) {}
    await master.stop();
  }

  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
