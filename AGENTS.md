# 🤖 AI Agent Protocol & Installation Guide

This document provides explicit, deterministic instructions for **AI Agents** (Google Antigravity, Claude Code, Cursor, Windsurf, Roo Code, etc.) on how to autonomously install, update, and operate this MCP server.

---

## ⚡ Agent Setup & Update Protocol

When the user asks you to **"Install Figma MCP"**, **"Update Figma MCP"**, or passes a link to this repository, follow these steps:

### 1. Run the Automated Installer
Execute `install.py` in the repository root directory:
```bash
# New installation (with optional token):
python install.py --token "<USER_TOKEN_OR_EMPTY>"

# In-place update:
python install.py --update
```

> [!IMPORTANT]
> **CRITICAL RULE:** Do NOT merely download or extract the repository files. You **MUST** run `python install.py` / `python install.py --update`. This command copies the server and plugin files into the system directories (`~/.gemini/antigravity/mcp/` and `~/.gemini/antigravity-ide/mcp/`) and registers the server in all active `mcp_config.json` configuration files.

### 2. Guide the User to Activate / Reload the Plugin
Instruct the user:
1. Open **Figma Desktop** (must be the Desktop app, not a web browser).
2. Go to **Plugins** → **Development** → **Import plugin from manifest...** and select `manifest.json` from `~/.gemini/antigravity/mcp/figma-plugin/manifest.json`.
3. Press **`Ctrl + Alt + P`** (macOS: **`Cmd + Option + P`**) to launch/reload **Antigravity Bridge**.
4. The plugin status indicator will turn green: **`CONNECTED`** (`ws://127.0.0.1:8765`).

### 3. Verify Connection with Doctor
Run the diagnostic check:
```bash
python install.py --doctor
```

---

## 🎨 Agent Usage Best Practices (Visual Feedback Loop)

When interacting with the Figma canvas:
1. **Always close the visual loop:** When creating or editing UI elements (frames, text, cards, buttons, vector icons), set `capture: true` in `figma_execute_code`, `figma_insert_component_instance`, or `figma_insert_svg`, or call `figma_screenshot`.
2. **Inspect returned images:** Use the returned PNG image to visually audit typography, contrast, layout alignment, AutoLayout padding, and hierarchy.
3. **AutoLayout first:** Always construct layouts using `layoutMode = "VERTICAL"` or `"HORIZONTAL"`, `primaryAxisSizingMode = "AUTO"` (hug) or `"FIXED"`, and `counterAxisSizingMode`.
4. **Smart Placement:** Use `getFreePosition(width, height, { gap: 80, direction: "RIGHT" })` or let the automatic collision engine place new artboards safely without overlapping existing work.
5. **Color normalization:** Colors in Figma API are floats from `0` to `1` (e.g. `{ r: 0.1, g: 0.5, b: 0.9 }`), not `0-255`.
6. **Font safety:** Always load fonts before setting text via `await ensureFont("Inter", "Regular")` or `await ensureFont("Inter", "Bold")`.

---

## 🩺 Troubleshooting for Agents

- **If tool calls time out:**
  1. Ask the user to make sure Figma Desktop is open and the **Antigravity Bridge** plugin window is active.
  2. If the plugin shows **`OFFLINE`**, run `python install.py --doctor` to verify port `8765` availability.
  3. If there are zombie Node processes holding port 8765, terminate them (`Stop-Process -Name node -Force` on Windows or `killall node` on macOS) and reload the plugin with `Ctrl + Alt + P`.
- **Figma Web vs Desktop:** Plugins interacting with local WebSocket bridges (`ws://127.0.0.1:8765`) require **Figma Desktop**. Web browser versions of Figma block loopback sockets due to Mixed Content policies.

