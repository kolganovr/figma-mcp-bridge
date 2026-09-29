# 🤖 AI Agent Protocol & Installation Guide

This document provides explicit, deterministic instructions for **AI Agents** (Google Antigravity, Claude Code, Cursor, Windsurf, Roo Code, etc.) on how to autonomously install, update, and operate this MCP server.

---

## ⚡ Agent Setup & Update Protocol

When the user asks you to **"Install Figma MCP"**, **"Update Figma MCP"**, or passes a link to this repository, follow these steps:

### 1. Run the Automated Installer
Execute `install.mjs` in the repository root directory (needs only Node.js — no Python, no npm packages):
```bash
# New installation (with optional token):
node install.mjs --token "<USER_TOKEN_OR_EMPTY>"

# In-place update:
node install.mjs --update
```

> [!IMPORTANT]
> **CRITICAL RULE:** Do NOT merely download or extract the repository files. You **MUST** run `node install.mjs` / `node install.mjs --update`. This command copies the server and plugin files into the system directories (`~/.gemini/antigravity/mcp/` and `~/.gemini/antigravity-ide/mcp/`) and registers the server in all active `mcp_config.json` configuration files.

### 2. Guide the User to Activate / Reload the Plugin
Instruct the user:
1. Open **Figma Desktop** (must be the Desktop app, not a web browser).
2. Go to **Plugins** → **Development** → **Import plugin from manifest...** and select `manifest.json` from `~/.gemini/antigravity/mcp/figma-plugin/manifest.json`.
3. Press **`Ctrl + Alt + P`** (macOS: **`Cmd + Option + P`**) to launch/reload **Antigravity Bridge**.
4. The plugin status indicator will turn green: **`CONNECTED`** (`ws://127.0.0.1:8765`).

### 3. Verify Connection with Doctor
Run the diagnostic check:
```bash
node install.mjs --doctor
```

> [!NOTE]
> The server prints a one-line notice to stderr on startup if `main` has moved past the installed commit — it only *notifies*, it never updates anything on its own. `node install.mjs --update` is still the only thing that actually applies an update. Set `FIGMA_MCP_NO_UPDATE_CHECK=1` to disable the check entirely (e.g. on an air-gapped machine).

---

## 🎨 Agent Usage Best Practices (Visual Feedback Loop)

When interacting with the Figma canvas:
0. **Mind the token bill:** every call re-reads the whole conversation and its output stays there. Do a whole stage (read → change → verify) in ONE `figma_execute_code` call and return only the ids/flags you need. Verify with the write response's `warnings` and `bridge.check(specs)` before reaching for an image.
1. **Close the visual loop once per stage:** when a stage is done, set `capture: true` (with `capture_node_ids`) on the last write, or call `figma_screenshot`. Images default to `scale: 1`, `max_px: 1024` (~1k tokens); raise `max_px` only to read fine detail.
2. **Inspect returned images:** Use the returned PNG image to visually audit typography, contrast, layout alignment, AutoLayout padding, and hierarchy.
3. **AutoLayout first:** Always construct layouts using `layoutMode = "VERTICAL"` or `"HORIZONTAL"`, `primaryAxisSizingMode = "AUTO"` (hug) or `"FIXED"`, and `counterAxisSizingMode`.
4. **Smart Placement:** Use `getFreePosition(width, height, { gap: 80, direction: "RIGHT" })` or let the automatic collision engine place new artboards safely without overlapping existing work.
5. **Color normalization:** Colors in Figma API are floats from `0` to `1` (e.g. `{ r: 0.1, g: 0.5, b: 0.9 }`), not `0-255`.
6. **Font safety:** Always load fonts before setting text via `await ensureFont("Inter", "Regular")` or `await ensureFont("Inter", "Bold")`.
7. **Read before you screenshot:** Prefer `figma_read_canvas`, or inside code `bridge.summarize(id, { depth })`, `bridge.inspect(ids, props)`, `bridge.find(query, { root, type })`, over hand-writing a tree walk — never return raw node dumps. Results over `max_output_chars` (6000) are shrunk; the full value stays in `bridge.state.lastResult` for the next call.
8. **Every write call is undoable:** it returns a `checkpoint_id`; `figma_rollback({ checkpoint_id })` (or `"last"`) undoes it. Use this instead of asking the user to `Ctrl+Z`.
9. **Long-running code doesn't need special handling:** past 45s a call auto-escalates to `{ status: "running", job_id }`; call `figma_job_status` ONCE — it blocks until the job finishes (`wait_ms`, default 45s). `PLUGIN_BUSY` means another job still holds the single-threaded sandbox: wait for that job, don't retry. `stalled: true` means ask the user. Call `progress(step, of, note)` inside multi-step code.
10. **Multiple Figma files open:** check `figma_list_targets` and pass `target: "<fileName>"` on any LIVE tool if a call fails with `AMBIGUOUS_TARGET`.

---

## 🧠 Execution Model of `figma_execute_code` (Non-Obvious — Read Before Scripting)

Your code is compiled by the plugin as `new AsyncFunction('figma', 'ensureFont', 'notify', 'log', 'getFreePosition', 'bridge', yourCode)`. Four consequences:

1. **Every call is a fresh scope.** Top-level `const` / `let` / `var` / `function` do **not** survive into the next call. Top-level `await` and `return` do work; `import` / `export` do not.
2. **Never use `eval` to carry helpers between calls.** `eval` is a *bound* function inside the Figma sandbox, so every call to it is an **indirect eval** by spec: it cannot read your locals, and declarations inside the string reach neither the caller nor `globalThis`. The pattern "save source in `pluginData`, `eval` it next call" fails *silently* — nothing is declared and nothing is thrown.
3. **Persist code with the `bridge` module loader** (built on `new Function`, whose bodies are ordinary scopes):
   ```js
   bridge.define("kit", "function mk(){ /* ... */ }; module.exports = { mk };"); // once, saved into the .fig file
   const { mk } = bridge.require("kit");                                          // in any later call
   ```
   Persist data with `bridge.store.set/get(key, value)` (durable, lives in the document) or `bridge.state` (scratch, cleared on plugin reload).
4. **Ask instead of guessing:** `return bridge.info()` reports the live execution model, injected globals, defined modules and stored keys.

### Platform limits the bridge wraps for you
- `bridge.componentize(node)` — `figma.createComponentFromNode()` can force every nested AutoLayout frame to `FIXED` sizing and returns nodes with **new ids**; this wrapper restores the sizing modes.
- `bridge.setPosition(node, x, y)` — `x`/`y` of a node inside an `INSTANCE` cannot be set (`relative-transform` is not overridable). The wrapper fails early and names the remedy: position through AutoLayout alignment, or edit the master component.

### When failures come back
Errors carry a `HINT:` line whenever the bridge recognises the failure mode (unloaded font, instance override, stale node id, hugging AutoLayout resize, `pluginData` limits, "helper from my last call is not defined"). Read the hint before retrying.

### Changing the runtime
Four contract tests pin this behaviour; run the ones relevant to what you touched (or all of them — each finishes in well under a second, except `mcp-protocol.test.js` which spawns real server processes):
- `node tests/bridge-runtime.test.js` — module persistence, chunking, store, `componentize`, `setPosition`, error hints, checkpoint/rollback. Run after touching `figma-plugin/code.js`'s Bridge Runtime block.
- `node tests/layout-packer.test.js` — canvas placement (row/grid packing, collision grid). Run after touching `getFreeCanvasPosition*` / `autoPositionIfColliding` in `figma-plugin/code.js`.
- `node tests/optimizer.test.js` — REST/live token optimizer (jsx/tree/json, budget truncation). Run after touching `figma/optimizer/*.js`.
- `node tests/mcp-protocol.test.js` — the real server over stdio: `initialize`, `tools/list`, tool tiering by env. Run after touching `figma/index.js`'s `TOOLS` array or `TOOL_TIERS`.
- `node tests/token-economy.test.js` — real server + a fake plugin over a real WebSocket on an isolated port: output budgets, image sizing, blocking `figma_job_status`, `PLUGIN_BUSY`, disconnect/reconnect, proxy forwarding. Run after touching `sendCommandToPlugin`, the job ledger, or any tool's output rendering. After changing `TOOLS`, regenerate `figma/<tool>.json` from it (they mirror `TOOLS` for clients that read per-tool descriptors).

---

## 🩺 Troubleshooting for Agents

- **If tool calls time out:**
  1. Ask the user to make sure Figma Desktop is open and the **Antigravity Bridge** plugin window is active.
  2. If the plugin shows **`OFFLINE`**, run `node install.mjs --doctor` to verify port `8765` availability.
  3. If there are zombie Node processes holding port 8765, terminate them (`Stop-Process -Name node -Force` on Windows or `killall node` on macOS) and reload the plugin with `Ctrl + Alt + P`.
- **Figma Web vs Desktop:** Plugins interacting with local WebSocket bridges (`ws://127.0.0.1:8765`) require **Figma Desktop**. Web browser versions of Figma block loopback sockets due to Mixed Content policies.

