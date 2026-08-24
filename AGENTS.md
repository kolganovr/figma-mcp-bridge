# 🤖 AI Agent Onboarding & Installation Guide

This document provides explicit instructions for **AI Agents** (Google Antigravity, Claude Code, Cursor, Windsurf, Roo Code, etc.) on how to autonomously install and configure this MCP server on the user's system.

---

## ⚡ Agent Installation Workflow

When the user asks you to **"Install this MCP"**, **"Setup Figma MCP"**, or passes a link to this repository, follow this 3-step protocol:

### Step 1: Prompt the User for their Figma Token
Ask the user if they want to configure the Figma Cloud REST API:
> *"To enable full Figma Cloud API access (reading files, styles, components from URLs), I need your Figma Personal Access Token. You can generate one in [Figma Settings → Account → Personal access tokens](https://www.figma.com/settings). If you only want live canvas manipulation, you can press Enter / skip this."*

### Step 2: Run the Installer Command
Execute the automated installer in the terminal:
```bash
python install.py --token "<USER_TOKEN_OR_EMPTY>"
```
*Note: The installer automatically detects Antigravity, Claude Desktop, and active OS paths (Windows, macOS, Linux) and updates `mcp_config.json` without requiring `npm install` or manual file moves.*

### Step 3: Guide the User to Activate the Figma Plugin
Provide the user with these exact instructions:
1. Open **Figma Desktop**.
2. Go to **Plugins** → **Development** → **Import plugin from manifest...**
3. Select `manifest.json` located at `~/.gemini/antigravity/mcp/figma-plugin/manifest.json` (or inside this repo's `figma-plugin/manifest.json`).
4. Run the plugin: **Plugins** → **Development** → **Antigravity Bridge** (or press `Ctrl + Alt + P` / `Cmd + Option + P`).
5. Restart your AI Assistant / IDE to reload the MCP configuration.

---

## 🎨 Agent Usage Best Practices (Visual Feedback Loop)

When interacting with the Figma canvas:
- **Always close the loop:** Whenever generating or editing UI elements (frames, text, cards, buttons), set `capture: true` in `figma_execute_code` or call `figma_screenshot`.
- **Inspect returned images:** Use the returned PNG image to visually audit typography, contrast, layout alignment, AutoLayout padding, and hierarchy.
- **AutoLayout first:** Always construct layouts using `layoutMode = "VERTICAL"` or `"HORIZONTAL"`, `primaryAxisSizingMode`, and `counterAxisSizingMode`.
