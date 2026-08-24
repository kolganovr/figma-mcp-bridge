# -*- coding: utf-8 -*-
"""
Figma MCP Bridge & Live Canvas Multi-Tool Installer & Updater
Author: Roman Kolganov
License: MIT
"""

import os
import sys
import json
import shutil
import subprocess
import argparse
from pathlib import Path

def check_environment():
    """Verify Node.js is installed and accessible."""
    try:
        res = subprocess.run(["node", "-v"], capture_output=True, text=True, check=True)
        node_ver = res.stdout.strip()
        print(f"[✓] Node.js runtime detected: {node_ver}")
        return True
    except Exception:
        print("[!] Warning: Node.js was not found in PATH.")
        print("    Please install Node.js (v18+) from https://nodejs.org to run the MCP server.")
        return False

def get_config_targets(home: Path):
    """Find all supported AI assistant MCP config files."""
    targets = []
    
    # 1. Antigravity IDE Global Config
    antigravity_config = home / ".gemini" / "config" / "mcp_config.json"
    if antigravity_config.parent.exists():
        targets.append(antigravity_config)
        
    # 2. Antigravity Legacy Config
    antigravity_legacy = home / ".gemini" / "antigravity" / "mcp_config.json"
    if antigravity_legacy.parent.exists():
        targets.append(antigravity_legacy)

    # 3. Claude Desktop (Windows / macOS)
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            claude_config = Path(appdata) / "Claude" / "claude_desktop_config.json"
            if claude_config.parent.exists():
                targets.append(claude_config)
    elif sys.platform == "darwin":
        claude_config = home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
        if claude_config.parent.exists():
            targets.append(claude_config)
            
    return targets

def install_or_update(token="", is_update=False):
    home = Path.home()
    antigravity_mcp = home / ".gemini" / "antigravity" / "mcp"
    antigravity_mcp.mkdir(parents=True, exist_ok=True)

    pkg_root = Path(__file__).parent.resolve()

    # 1. Copy MCP Server files
    target_figma = antigravity_mcp / "figma"
    target_figma.mkdir(parents=True, exist_ok=True)
    shutil.copytree(pkg_root / "figma", target_figma, dirs_exist_ok=True)
    action_str = "updated" if is_update else "installed"
    print(f"[✓] MCP Server {action_str}: {target_figma}")

    # 2. Copy Plugin files
    target_plugin = antigravity_mcp / "figma-plugin"
    target_plugin.mkdir(parents=True, exist_ok=True)
    shutil.copytree(pkg_root / "figma-plugin", target_plugin, dirs_exist_ok=True)
    print(f"[✓] Figma Plugin {action_str}: {target_plugin}")

    index_js_path = str(target_figma / "index.js").replace("\\", "/")

    # 3. Update MCP config files
    targets = get_config_targets(home)
    if not targets:
        fallback = home / ".gemini" / "config" / "mcp_config.json"
        fallback.parent.mkdir(parents=True, exist_ok=True)
        targets.append(fallback)

    cli_token = token.strip()

    for config_file in targets:
        config_data = {"mcpServers": {}}
        if config_file.exists():
            try:
                with open(config_file, "r", encoding="utf-8") as f:
                    config_data = json.load(f)
            except Exception as e:
                print(f"[!] Warning reading {config_file}: {e}")

        if "mcpServers" not in config_data:
            config_data["mcpServers"] = {}

        # Preserve existing token if CLI token wasn't provided
        final_token = cli_token
        if not final_token and "figma" in config_data["mcpServers"]:
            final_token = config_data["mcpServers"]["figma"].get("env", {}).get("FIGMA_PERSONAL_ACCESS_TOKEN", "")

        config_data["mcpServers"]["figma"] = {
            "command": "node",
            "args": [index_js_path],
            "env": {
                "FIGMA_PERSONAL_ACCESS_TOKEN": final_token
            }
        }

        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=2, ensure_ascii=False)
        print(f"[✓] MCP Config updated: {config_file}")

    manifest_path = str(target_plugin / "manifest.json")

    print("\n==================================================")
    if is_update:
        print("🎉 Figma MCP Bridge successfully updated!")
        print("==================================================")
        print("1. In Figma: Close and re-open the plugin (or press Ctrl + Alt + P / Cmd + Option + P).")
        print("2. In your AI IDE: Restart the session to apply any server changes.")
    else:
        print("🎉 Figma MCP Bridge successfully installed!")
        print("==================================================")
        print("Next steps:")
        print("1. In Figma Desktop:")
        print("   - Menu > Plugins > Development > Import plugin from manifest...")
        print(f"   - Select: {manifest_path}")
        print("   - Press Ctrl + Alt + P to launch the 'Antigravity Bridge' plugin.")
        print("2. Restart your AI IDE (Antigravity / Claude Desktop) to load tools.")
    print("==================================================")

def run_doctor():
    print("==================================================")
    print("🩺 Figma MCP Bridge Diagnostic Report")
    print("==================================================")
    check_environment()
    home = Path.home()
    target_figma = home / ".gemini" / "antigravity" / "mcp" / "figma"
    target_plugin = home / ".gemini" / "antigravity" / "mcp" / "figma-plugin"

    print(f"[*] MCP Server Path: {target_figma} {'[EXISTS]' if target_figma.exists() else '[MISSING]'}")
    print(f"[*] Plugin Path:     {target_plugin} {'[EXISTS]' if target_plugin.exists() else '[MISSING]'}")

    configs = get_config_targets(home)
    print("\n[*] Detected MCP Config Targets:")
    for cfg in configs:
        if cfg.exists():
            try:
                with open(cfg, "r", encoding="utf-8") as f:
                    d = json.load(f)
                    has_figma = "figma" in d.get("mcpServers", {})
                    token = d.get("mcpServers", {}).get("figma", {}).get("env", {}).get("FIGMA_PERSONAL_ACCESS_TOKEN", "")
                    tok_status = "Token configured" if token else "No token (Live canvas only)"
                    print(f"  - {cfg} (figma entry: {'YES' if has_figma else 'NO'}, {tok_status})")
            except Exception as e:
                print(f"  - {cfg} (Error reading: {e})")
        else:
            print(f"  - {cfg} [NOT CREATED YET]")
    print("==================================================")

def main():
    parser = argparse.ArgumentParser(description="Figma MCP Bridge & Live Canvas Multi-Tool Installer")
    parser.add_argument("--token", type=str, default="", help="Figma Personal Access Token (optional for cloud REST API)")
    parser.add_argument("--update", action="store_true", help="Perform in-place update of MCP server and plugin")
    parser.add_argument("--doctor", action="store_true", help="Run system diagnostics and verify configuration")
    args = parser.parse_args()

    if args.doctor:
        run_doctor()
        return

    print("==================================================")
    mode_label = "Updating" if args.update else "Installing"
    print(f"⚡ {mode_label} Figma MCP Bridge + Visual Feedback Loop")
    print("==================================================")

    check_environment()
    install_or_update(token=args.token, is_update=args.update)

if __name__ == "__main__":
    main()
