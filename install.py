# -*- coding: utf-8 -*-
"""
Figma MCP Bridge & Live Canvas Multi-Tool Installer & Updater
Author: Roman Kolganov
License: MIT
"""

import os
import re
import sys
import json
import shutil
import secrets
import subprocess
import argparse
import tempfile
from pathlib import Path

# ==========================================================================
# Every physical copy of the server/plugin this installer can create, and
# which MCP config file(s) should point at each one. Earlier versions copied
# figma/ + figma-plugin/ into ~/.gemini/antigravity-ide/mcp/ but then wrote
# EVERY config — including antigravity-ide's own — with the path to the
# antigravity/ copy. The antigravity-ide copy was never referenced by
# anything: pure disk cost, and a trap if someone edited "the wrong" copy
# while debugging. Each install location now owns exactly the config(s) that
# should reference it.
# ==========================================================================
CANONICAL_KEY = "canonical"


def install_locations(home: Path):
    """Maps an install location key -> the directory its server+plugin copy
    lives in. `canonical` is the shared copy used by every MCP client that
    doesn't have its own dedicated Gemini/Antigravity subfolder convention."""
    return {
        "antigravity": home / ".gemini" / "antigravity" / "mcp",
        "antigravity-ide": home / ".gemini" / "antigravity-ide" / "mcp",
        CANONICAL_KEY: home / ".figma-mcp-bridge" / "mcp",
    }


def check_environment():
    """Verify Node.js is installed and accessible, and new enough for the
    global `fetch` the server relies on (Node < 18 doesn't have it)."""
    try:
        res = subprocess.run(["node", "-v"], capture_output=True, text=True, check=True)
        node_ver = res.stdout.strip()
        match = re.match(r"v(\d+)", node_ver)
        major = int(match.group(1)) if match else 0
        if major and major < 18:
            print(f"[!] Warning: Node.js {node_ver} detected, but this server needs Node 18+ (uses global fetch).")
            print("    Upgrade from https://nodejs.org before running the MCP server.")
            return False
        print(f"[✓] Node.js runtime detected: {node_ver}")
        return True
    except Exception:
        print("[!] Warning: Node.js was not found in PATH.")
        print("    Please install Node.js (v18+) from https://nodejs.org to run the MCP server.")
        return False


def get_config_targets(home: Path, appdata: str = None):
    """Finds every supported AI assistant MCP config file that already looks
    installed, and which server copy each one should reference.

    Returns a list of dicts: {"path": Path, "location": str}. A config is
    only included when the *application's own* directory already exists —
    we don't want to scatter mcp_config.json files for tools the user has
    never run. The one exception is the Gemini fallback, added later if
    nothing else was detected at all.

    `home` and `appdata` are explicit parameters rather than read from
    Path.home()/os.environ internally, specifically so tests can point this
    at a throwaway directory without any risk of touching the real machine's
    actual MCP configs — a real install once got clobbered during manual
    testing precisely because Path.home() and os.environ reach past whatever
    a caller thinks it patched.
    """
    targets = []

    gemini_root = home / ".gemini"
    if (gemini_root / "antigravity").exists():
        targets.append({"path": gemini_root / "antigravity" / "mcp_config.json", "location": "antigravity"})
    if (gemini_root / "antigravity-ide").exists():
        targets.append({"path": gemini_root / "antigravity-ide" / "mcp_config.json", "location": "antigravity-ide"})
    if (gemini_root / "antigravity-cli").exists():
        targets.append({"path": gemini_root / "antigravity-cli" / "mcp_config.json", "location": CANONICAL_KEY})
    if (gemini_root / "config").exists():
        targets.append({"path": gemini_root / "config" / "mcp_config.json", "location": CANONICAL_KEY})

    # Claude Desktop
    if sys.platform == "win32":
        if appdata:
            claude_dir = Path(appdata) / "Claude"
            if claude_dir.exists():
                targets.append({"path": claude_dir / "claude_desktop_config.json", "location": CANONICAL_KEY})
    elif sys.platform == "darwin":
        claude_dir = home / "Library" / "Application Support" / "Claude"
        if claude_dir.exists():
            targets.append({"path": claude_dir / "claude_desktop_config.json", "location": CANONICAL_KEY})
    else:
        claude_dir = home / ".config" / "Claude"
        if claude_dir.exists():
            targets.append({"path": claude_dir / "claude_desktop_config.json", "location": CANONICAL_KEY})

    # Claude Code CLI. Its settings file lives directly at ~/.claude.json with
    # no dedicated directory, so existence of the FILE (not just $HOME) is
    # what tells us the tool has actually been run before.
    claude_code_config = home / ".claude.json"
    if claude_code_config.exists():
        targets.append({"path": claude_code_config, "location": CANONICAL_KEY})

    # Cursor
    if (home / ".cursor").exists():
        targets.append({"path": home / ".cursor" / "mcp.json", "location": CANONICAL_KEY})

    # Windsurf
    if (home / ".codeium" / "windsurf").exists():
        targets.append({"path": home / ".codeium" / "windsurf" / "mcp_config.json", "location": CANONICAL_KEY})

    return targets


def get_or_create_bridge_token(home: Path, existing_targets):
    """The WebSocket/HTTP bridge on :8765 is shared by every agent's copy of
    this server, but only one process ever binds the port; the rest proxy to
    it. All of them — and the plugin copies baked with install.py — must
    agree on the SAME token, or the owning process rejects everyone else's
    requests. Reuse whatever token is already configured anywhere (so an
    --update doesn't invalidate a plugin the user already has open) before
    generating a new one.
    """
    for target in existing_targets:
        cfg_path = target["path"]
        if not cfg_path.exists():
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            token = data.get("mcpServers", {}).get("figma", {}).get("env", {}).get("FIGMA_BRIDGE_TOKEN", "")
            if token:
                return token
        except Exception:
            continue

    token_file = home / ".figma-mcp-bridge" / "bridge_token.txt"
    if token_file.exists():
        try:
            saved = token_file.read_text(encoding="utf-8").strip()
            if saved:
                return saved
        except Exception:
            pass

    token = secrets.token_hex(24)
    try:
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(token, encoding="utf-8")
    except Exception as e:
        print(f"[!] Warning: could not persist bridge token to {token_file}: {e}")
    return token


def copy_tree_clean(src: Path, dst: Path):
    """Copies src over dst AND removes anything left behind by a previous
    version (an old optimizer module, a retired schema) that could otherwise
    still be `require()`-d by whatever else is in the directory.

    This deliberately never rmtree's the destination wholesale. An earlier
    version did `rmtree(dst)` then `copytree(src, dst)`, and on Windows that
    routinely raises a transient PermissionError/WinError 5 mid-delete — a
    search indexer or antivirus holds a handle open for a moment right after
    a file's content is gone but before its directory entry can be removed.
    This is not hypothetical: it reproduced on the very first real test of
    this function, deleting index.js and every schema out of a live install
    before failing partway through the rmtree. Copying new/changed files
    first (via dirs_exist_ok, which never needs to remove anything) and only
    then best-effort-deleting the files that genuinely don't exist upstream
    anymore means the common case — nothing removed upstream — never touches
    rmtree at all, and the rare case degrades to "a stale file survives one
    more update" instead of "the live install is missing files".
    """
    shutil.copytree(src, dst, dirs_exist_ok=True)

    src_files = {p.relative_to(src) for p in src.rglob("*") if p.is_file()}
    dst_files = {p.relative_to(dst) for p in dst.rglob("*") if p.is_file()}
    stale = dst_files - src_files

    for rel in stale:
        try:
            (dst / rel).unlink()
        except OSError as e:
            print(f"[!] Warning: could not remove stale file {dst / rel}: {e}")

    # Clean up any directories that are now empty because their only
    # contents were stale files, deepest first so parents empty out in turn.
    for d in sorted((p for p in dst.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            if not any(d.iterdir()):
                d.rmdir()
        except OSError:
            pass


def inject_bridge_token(plugin_dir: Path, token: str):
    """Bakes the shared bridge token into the installed copy of ui.html. The
    plugin runs inside Figma's sandboxed iframe with no access to environment
    variables, so this is the only way it learns the token the server expects."""
    ui_path = plugin_dir / "ui.html"
    if not ui_path.exists():
        return
    text = ui_path.read_text(encoding="utf-8")
    marker = 'const BRIDGE_TOKEN = "";'
    if marker not in text:
        # Already patched by a previous install, or the source changed shape —
        # don't silently fail to secure the bridge.
        if re.search(r'const BRIDGE_TOKEN = "[0-9a-f]{10,}";', text):
            return
        print(f"[!] Warning: could not find the BRIDGE_TOKEN placeholder in {ui_path}; plugin will run without a token.")
        return
    text = text.replace(marker, f'const BRIDGE_TOKEN = "{token}";', 1)
    ui_path.write_text(text, encoding="utf-8")


def atomic_write_json(path: Path, data: dict):
    """Writes JSON via a temp file + rename so a crash mid-write can never
    leave the config half-written or truncated."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def install_or_update(token="", is_update=False, home: Path = None, appdata: str = None):
    home = home if home is not None else Path.home()
    appdata = appdata if appdata is not None else os.environ.get("APPDATA")
    pkg_root = Path(__file__).parent.resolve()
    action_str = "updated" if is_update else "installed"

    # 1. Figure out which config targets exist BEFORE writing anything, so we
    # can look up any already-configured bridge token from them.
    targets = get_config_targets(home, appdata)
    if not targets:
        fallback = home / ".gemini" / "config" / "mcp_config.json"
        targets.append({"path": fallback, "location": CANONICAL_KEY})

    bridge_token = get_or_create_bridge_token(home, targets)

    # 2. Copy the server + plugin into every location referenced by at least
    # one detected config, always including the canonical shared copy.
    locations = install_locations(home)
    needed_locations = {t["location"] for t in targets} | {CANONICAL_KEY}

    index_js_paths = {}
    for loc_key in needed_locations:
        mcp_dir = locations[loc_key]
        target_figma = mcp_dir / "figma"
        target_plugin = mcp_dir / "figma-plugin"

        copy_tree_clean(pkg_root / "figma", target_figma)
        copy_tree_clean(pkg_root / "figma-plugin", target_plugin)
        inject_bridge_token(target_plugin, bridge_token)

        index_js_paths[loc_key] = str(target_figma / "index.js").replace("\\", "/")
        print(f"[✓] MCP Server + Plugin {action_str} ({loc_key}): {mcp_dir}")

    # 3. Update MCP config files, each pointing at its own server copy.
    cli_token = token.strip()

    for target in targets:
        config_file = target["path"]
        index_js_path = index_js_paths[target["location"]]

        config_data = {"mcpServers": {}}
        if config_file.exists():
            try:
                with open(config_file, "r", encoding="utf-8") as f:
                    config_data = json.load(f)
            except Exception as e:
                # A config we cannot parse must NOT be blindly overwritten —
                # earlier this printed a warning and then wrote a fresh
                # {"mcpServers": {"figma": ...}} over the file, silently
                # destroying every other MCP server (and any other settings)
                # the user had configured there.
                print(f"[!] Skipping {config_file}: could not read it ({e}). "
                      f"Fix or remove the file, then re-run install.py to add the figma server.")
                continue

        if not isinstance(config_data, dict):
            print(f"[!] Skipping {config_file}: root of the file is not a JSON object.")
            continue

        if "mcpServers" not in config_data or not isinstance(config_data.get("mcpServers"), dict):
            config_data["mcpServers"] = {}

        # Preserve existing Figma personal-access-token if a new one wasn't given
        final_token = cli_token
        existing_figma = config_data["mcpServers"].get("figma", {})
        if not final_token and isinstance(existing_figma, dict):
            final_token = existing_figma.get("env", {}).get("FIGMA_PERSONAL_ACCESS_TOKEN", "")

        config_data["mcpServers"]["figma"] = {
            "command": "node",
            "args": [index_js_path],
            "env": {
                "FIGMA_PERSONAL_ACCESS_TOKEN": final_token,
                "FIGMA_BRIDGE_TOKEN": bridge_token
            }
        }

        try:
            # Back up whatever was there before touching it — this file may
            # hold unrelated settings and other MCP servers.
            if config_file.exists():
                backup_path = config_file.with_suffix(config_file.suffix + ".bak")
                shutil.copyfile(config_file, backup_path)
            atomic_write_json(config_file, config_data)
            print(f"[✓] MCP Config updated: {config_file}")
        except Exception as e:
            print(f"[!] Failed to write {config_file}: {e}")

    canonical_plugin = locations[CANONICAL_KEY] / "figma-plugin"
    manifest_path = str(canonical_plugin / "manifest.json")

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
        print("2. Restart your AI IDE / editor to load the new MCP tools.")
        print("   Detected: " + ", ".join(sorted({t['location'] for t in targets})) if targets else "")
    print("==================================================")


def run_doctor(home: Path = None, appdata: str = None):
    print("==================================================")
    print("🩺 Figma MCP Bridge Diagnostic Report")
    print("==================================================")
    check_environment()
    home = home if home is not None else Path.home()
    appdata = appdata if appdata is not None else os.environ.get("APPDATA")
    locations = install_locations(home)

    for loc_key, mcp_dir in locations.items():
        target_figma = mcp_dir / "figma"
        target_plugin = mcp_dir / "figma-plugin"
        print(f"[*] [{loc_key}] Server Path: {target_figma} {'[EXISTS]' if target_figma.exists() else '[NOT INSTALLED]'}")
        print(f"[*] [{loc_key}] Plugin Path: {target_plugin} {'[EXISTS]' if target_plugin.exists() else '[NOT INSTALLED]'}")

    configs = get_config_targets(home, appdata)
    print("\n[*] Detected MCP Config Targets:")
    if not configs:
        print("  (none detected — run install.py to create one)")
    for target in configs:
        cfg = target["path"]
        if cfg.exists():
            try:
                with open(cfg, "r", encoding="utf-8") as f:
                    d = json.load(f)
                    figma_entry = d.get("mcpServers", {}).get("figma", {})
                    has_figma = bool(figma_entry)
                    pat = figma_entry.get("env", {}).get("FIGMA_PERSONAL_ACCESS_TOKEN", "")
                    bridge_tok = figma_entry.get("env", {}).get("FIGMA_BRIDGE_TOKEN", "")
                    tok_status = "PAT configured" if pat else "no PAT (Live canvas only)"
                    bridge_status = "bridge token set" if bridge_tok else "NO bridge token (insecure)"
                    print(f"  - {cfg} [{target['location']}] (figma entry: {'YES' if has_figma else 'NO'}, {tok_status}, {bridge_status})")
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
