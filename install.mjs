#!/usr/bin/env node
// Figma MCP Bridge & Live Canvas Multi-Tool Installer & Updater
// Author: Roman Kolganov
// License: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================================================
// Every physical copy of the server/plugin this installer can create, and
// which MCP config file(s) should point at each one. Earlier versions copied
// figma/ + figma-plugin/ into ~/.gemini/antigravity-ide/mcp/ but then wrote
// EVERY config — including antigravity-ide's own — with the path to the
// antigravity/ copy. The antigravity-ide copy was never referenced by
// anything: pure disk cost, and a trap if someone edited "the wrong" copy
// while debugging. Each install location now owns exactly the config(s) that
// should reference it.
// ==========================================================================
const CANONICAL_KEY = "canonical";

/** Maps an install location key -> the directory its server+plugin copy
 * lives in. `canonical` is the shared copy used by every MCP client that
 * doesn't have its own dedicated Gemini/Antigravity subfolder convention. */
function installLocations(home) {
  return {
    antigravity: path.join(home, ".gemini", "antigravity", "mcp"),
    "antigravity-ide": path.join(home, ".gemini", "antigravity-ide", "mcp"),
    [CANONICAL_KEY]: path.join(home, ".figma-mcp-bridge", "mcp"),
  };
}

/** Warn if the Node running this script is too old for the server's global
 * `fetch` (Node < 18 doesn't have it). No subprocess needed — this script
 * already runs inside the exact runtime that will run the server. */
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    console.log(`[!] Warning: Node.js v${process.versions.node} detected, but this server needs Node 18+ (uses global fetch).`);
    console.log("    Upgrade from https://nodejs.org before running the MCP server.");
    return false;
  }
  console.log(`[✓] Node.js runtime detected: v${process.versions.node}`);
  return true;
}

/** Finds every supported AI assistant MCP config file that already looks
 * installed, and which server copy each one should reference.
 *
 * Returns a list of {path, location} objects. A config is only included
 * when the *application's own* directory already exists — we don't want to
 * scatter mcp_config.json files for tools the user has never run. The one
 * exception is the Gemini fallback, added later if nothing else was
 * detected at all.
 *
 * `home` and `appdata` are explicit parameters rather than read from
 * os.homedir()/process.env internally, specifically so tests can point this
 * at a throwaway directory without any risk of touching the real machine's
 * actual MCP configs — a real install once got clobbered during manual
 * testing precisely because reaching for the real home dir/env inside a
 * helper defeats whatever a caller thinks it patched. */
function getConfigTargets(home, appdata) {
  const targets = [];

  const geminiRoot = path.join(home, ".gemini");
  if (fs.existsSync(path.join(geminiRoot, "antigravity"))) {
    targets.push({ path: path.join(geminiRoot, "antigravity", "mcp_config.json"), location: "antigravity" });
  }
  if (fs.existsSync(path.join(geminiRoot, "antigravity-ide"))) {
    targets.push({ path: path.join(geminiRoot, "antigravity-ide", "mcp_config.json"), location: "antigravity-ide" });
  }
  if (fs.existsSync(path.join(geminiRoot, "antigravity-cli"))) {
    targets.push({ path: path.join(geminiRoot, "antigravity-cli", "mcp_config.json"), location: CANONICAL_KEY });
  }
  if (fs.existsSync(path.join(geminiRoot, "config"))) {
    targets.push({ path: path.join(geminiRoot, "config", "mcp_config.json"), location: CANONICAL_KEY });
  }

  // Claude Desktop
  if (process.platform === "win32") {
    if (appdata) {
      const claudeDir = path.join(appdata, "Claude");
      if (fs.existsSync(claudeDir)) {
        targets.push({ path: path.join(claudeDir, "claude_desktop_config.json"), location: CANONICAL_KEY });
      }
    }
  } else if (process.platform === "darwin") {
    const claudeDir = path.join(home, "Library", "Application Support", "Claude");
    if (fs.existsSync(claudeDir)) {
      targets.push({ path: path.join(claudeDir, "claude_desktop_config.json"), location: CANONICAL_KEY });
    }
  } else {
    const claudeDir = path.join(home, ".config", "Claude");
    if (fs.existsSync(claudeDir)) {
      targets.push({ path: path.join(claudeDir, "claude_desktop_config.json"), location: CANONICAL_KEY });
    }
  }

  // Claude Code CLI. Its settings file lives directly at ~/.claude.json with
  // no dedicated directory, so existence of the FILE (not just $HOME) is
  // what tells us the tool has actually been run before.
  const claudeCodeConfig = path.join(home, ".claude.json");
  if (fs.existsSync(claudeCodeConfig)) {
    targets.push({ path: claudeCodeConfig, location: CANONICAL_KEY });
  }

  // Cursor
  if (fs.existsSync(path.join(home, ".cursor"))) {
    targets.push({ path: path.join(home, ".cursor", "mcp.json"), location: CANONICAL_KEY });
  }

  // Windsurf
  if (fs.existsSync(path.join(home, ".codeium", "windsurf"))) {
    targets.push({ path: path.join(home, ".codeium", "windsurf", "mcp_config.json"), location: CANONICAL_KEY });
  }

  return targets;
}

/** The WebSocket/HTTP bridge on :8765 is shared by every agent's copy of
 * this server, but only one process ever binds the port; the rest proxy to
 * it. All of them — and the plugin copies install.mjs bakes a token into —
 * must agree on the SAME token, or the owning process rejects everyone
 * else's requests. Reuse whatever token is already configured anywhere (so
 * an --update doesn't invalidate a plugin the user already has open) before
 * generating a new one. */
function getOrCreateBridgeToken(home, existingTargets) {
  for (const target of existingTargets) {
    const cfgPath = target.path;
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const token = data?.mcpServers?.figma?.env?.FIGMA_BRIDGE_TOKEN || "";
      if (token) return token;
    } catch {
      continue;
    }
  }

  const tokenFile = path.join(home, ".figma-mcp-bridge", "bridge_token.txt");
  if (fs.existsSync(tokenFile)) {
    try {
      const saved = fs.readFileSync(tokenFile, "utf-8").trim();
      if (saved) return saved;
    } catch {
      // fall through to generating a new one
    }
  }

  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token, "utf-8");
  } catch (e) {
    console.log(`[!] Warning: could not persist bridge token to ${tokenFile}: ${e.message}`);
  }
  return token;
}

function listFilesRelative(root) {
  const result = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.add(path.relative(root, full));
    }
  }
  if (fs.existsSync(root)) walk(root);
  return result;
}

/** Copies src over dst AND removes anything left behind by a previous
 * version (an old optimizer module, a retired schema) that could otherwise
 * still be `require()`-d by whatever else is in the directory.
 *
 * This deliberately never wipes the destination wholesale before copying.
 * An earlier version (in the Python predecessor of this script) did
 * rmtree(dst) then copytree(src, dst), and on Windows that routinely raised
 * a transient permission error mid-delete — a search indexer or antivirus
 * holds a handle open for a moment right after a file's content is gone but
 * before its directory entry can be removed. This is not hypothetical: it
 * reproduced on the very first real test, deleting index.js and every schema
 * out of a live install before failing partway through. Copying new/changed
 * files first (fs.cpSync never needs to remove anything) and only then
 * best-effort-deleting files that genuinely don't exist upstream anymore
 * means the common case — nothing removed upstream — never deletes the
 * destination wholesale, and the rare case degrades to "a stale file
 * survives one more update" instead of "the live install is missing files". */
function copyTreeClean(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });

  const srcFiles = listFilesRelative(src);
  const dstFiles = listFilesRelative(dst);

  for (const rel of dstFiles) {
    if (srcFiles.has(rel)) continue;
    try {
      fs.unlinkSync(path.join(dst, rel));
    } catch (e) {
      console.log(`[!] Warning: could not remove stale file ${path.join(dst, rel)}: ${e.message}`);
    }
  }

  // Clean up any directories that are now empty because their only contents
  // were stale files, deepest first so parents empty out in turn.
  const dirs = [];
  (function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        collect(full);
        dirs.push(full);
      }
    }
  })(dst);
  dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const d of dirs) {
    try {
      if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    } catch {
      // not empty (race with something else) or already gone — fine either way
    }
  }
}

/** Bakes the shared bridge token into the installed copy of ui.html. The
 * plugin runs inside Figma's sandboxed iframe with no access to environment
 * variables, so this is the only way it learns the token the server
 * expects. */
function injectBridgeToken(pluginDir, token) {
  const uiPath = path.join(pluginDir, "ui.html");
  if (!fs.existsSync(uiPath)) return;
  let text = fs.readFileSync(uiPath, "utf-8");
  const marker = 'const BRIDGE_TOKEN = "";';
  if (!text.includes(marker)) {
    // Already patched by a previous install, or the source changed shape —
    // don't silently fail to secure the bridge.
    if (/const BRIDGE_TOKEN = "[0-9a-f]{10,}";/.test(text)) return;
    console.log(`[!] Warning: could not find the BRIDGE_TOKEN placeholder in ${uiPath}; plugin will run without a token.`);
    return;
  }
  text = text.replace(marker, `const BRIDGE_TOKEN = "${token}";`);
  fs.writeFileSync(uiPath, text, "utf-8");
}

/** Writes JSON via a temp file + rename so a crash mid-write can never leave
 * the file half-written or truncated. */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file never got created — nothing to clean up
    }
    throw e;
  }
}

/** Best-effort commit hash of the cloned repo this installer is running
 * from. Returns null if it isn't a git checkout (e.g. downloaded as a zip)
 * or git isn't installed — callers must treat null as "unknown", not as a
 * commit that differs from everything. */
function getRepoCommit(pkgRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: pkgRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Records which commit an installed copy came from, so the server can
 * later notice when main has moved on. Lives beside figma/ and
 * figma-plugin/, not inside either — it's install metadata, not source. */
function writeVersionMarker(mcpDir, commit) {
  try {
    atomicWriteJson(path.join(mcpDir, "version.json"), { commit, installedAt: new Date().toISOString() });
  } catch (e) {
    console.log(`[!] Warning: could not write version marker in ${mcpDir}: ${e.message}`);
  }
}

function installOrUpdate({ token = "", isUpdate = false, home, appdata } = {}) {
  home = home ?? os.homedir();
  appdata = appdata !== undefined ? appdata : process.env.APPDATA;
  const pkgRoot = __dirname;
  const actionStr = isUpdate ? "updated" : "installed";

  // 1. Figure out which config targets exist BEFORE writing anything, so we
  // can look up any already-configured bridge token from them.
  const targets = getConfigTargets(home, appdata);
  if (targets.length === 0) {
    targets.push({ path: path.join(home, ".gemini", "config", "mcp_config.json"), location: CANONICAL_KEY });
  }

  const bridgeToken = getOrCreateBridgeToken(home, targets);

  // 2. Copy the server + plugin into every location referenced by at least
  // one detected config, always including the canonical shared copy.
  const locations = installLocations(home);
  const neededLocations = new Set([...targets.map((t) => t.location), CANONICAL_KEY]);
  const repoCommit = getRepoCommit(pkgRoot);

  const indexJsPaths = {};
  for (const locKey of neededLocations) {
    const mcpDir = locations[locKey];
    const targetFigma = path.join(mcpDir, "figma");
    const targetPlugin = path.join(mcpDir, "figma-plugin");

    copyTreeClean(path.join(pkgRoot, "figma"), targetFigma);
    copyTreeClean(path.join(pkgRoot, "figma-plugin"), targetPlugin);
    injectBridgeToken(targetPlugin, bridgeToken);
    writeVersionMarker(mcpDir, repoCommit);

    indexJsPaths[locKey] = path.join(targetFigma, "index.js").split(path.sep).join("/");
    console.log(`[✓] MCP Server + Plugin ${actionStr} (${locKey}): ${mcpDir}`);
  }

  // 3. Update MCP config files, each pointing at its own server copy.
  const cliToken = token.trim();

  for (const target of targets) {
    const configFile = target.path;
    const indexJsPath = indexJsPaths[target.location];

    let configData = { mcpServers: {} };
    if (fs.existsSync(configFile)) {
      try {
        configData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      } catch (e) {
        // A config we cannot parse must NOT be blindly overwritten — writing
        // a fresh {"mcpServers": {"figma": ...}} over it would silently
        // destroy every other MCP server (and any other settings) the user
        // had configured there.
        console.log(
          `[!] Skipping ${configFile}: could not read it (${e.message}). ` +
            `Fix or remove the file, then re-run install.mjs to add the figma server.`
        );
        continue;
      }
    }

    if (typeof configData !== "object" || configData === null || Array.isArray(configData)) {
      console.log(`[!] Skipping ${configFile}: root of the file is not a JSON object.`);
      continue;
    }

    if (typeof configData.mcpServers !== "object" || configData.mcpServers === null || Array.isArray(configData.mcpServers)) {
      configData.mcpServers = {};
    }

    // Preserve existing Figma personal-access-token if a new one wasn't given.
    let finalToken = cliToken;
    const existingFigma = configData.mcpServers.figma;
    if (!finalToken && existingFigma && typeof existingFigma === "object") {
      finalToken = existingFigma.env?.FIGMA_PERSONAL_ACCESS_TOKEN || "";
    }

    configData.mcpServers.figma = {
      command: "node",
      args: [indexJsPath],
      env: {
        FIGMA_PERSONAL_ACCESS_TOKEN: finalToken,
        FIGMA_BRIDGE_TOKEN: bridgeToken,
      },
    };

    try {
      // Back up whatever was there before touching it — this file may hold
      // unrelated settings and other MCP servers.
      if (fs.existsSync(configFile)) {
        fs.copyFileSync(configFile, `${configFile}.bak`);
      }
      atomicWriteJson(configFile, configData);
      console.log(`[✓] MCP Config updated: ${configFile}`);
    } catch (e) {
      console.log(`[!] Failed to write ${configFile}: ${e.message}`);
    }
  }

  const canonicalPlugin = path.join(locations[CANONICAL_KEY], "figma-plugin");
  const manifestPath = path.join(canonicalPlugin, "manifest.json");

  console.log("\n==================================================");
  if (isUpdate) {
    console.log("\u{1F389} Figma MCP Bridge successfully updated!");
    console.log("==================================================");
    console.log("1. In Figma: Close and re-open the plugin (or press Ctrl + Alt + P / Cmd + Option + P).");
    console.log("2. In your AI IDE: Restart the session to apply any server changes.");
  } else {
    console.log("\u{1F389} Figma MCP Bridge successfully installed!");
    console.log("==================================================");
    console.log("Next steps:");
    console.log("1. In Figma Desktop:");
    console.log("   - Menu > Plugins > Development > Import plugin from manifest...");
    console.log(`   - Select: ${manifestPath}`);
    console.log("   - Press Ctrl + Alt + P to launch the 'Antigravity Bridge' plugin.");
    console.log("2. Restart your AI IDE / editor to load the new MCP tools.");
    if (targets.length) {
      console.log("   Detected: " + [...new Set(targets.map((t) => t.location))].sort().join(", "));
    }
  }
  console.log("==================================================");
}

function runDoctor(home, appdata) {
  console.log("==================================================");
  console.log("\u{1FA7A} Figma MCP Bridge Diagnostic Report");
  console.log("==================================================");
  checkNodeVersion();
  home = home ?? os.homedir();
  appdata = appdata !== undefined ? appdata : process.env.APPDATA;
  const locations = installLocations(home);

  for (const [locKey, mcpDir] of Object.entries(locations)) {
    const targetFigma = path.join(mcpDir, "figma");
    const targetPlugin = path.join(mcpDir, "figma-plugin");
    console.log(`[*] [${locKey}] Server Path: ${targetFigma} ${fs.existsSync(targetFigma) ? "[EXISTS]" : "[NOT INSTALLED]"}`);
    console.log(`[*] [${locKey}] Plugin Path: ${targetPlugin} ${fs.existsSync(targetPlugin) ? "[EXISTS]" : "[NOT INSTALLED]"}`);
  }

  const configs = getConfigTargets(home, appdata);
  console.log("\n[*] Detected MCP Config Targets:");
  if (configs.length === 0) {
    console.log("  (none detected — run install.mjs to create one)");
  }
  for (const target of configs) {
    const cfg = target.path;
    if (fs.existsSync(cfg)) {
      try {
        const d = JSON.parse(fs.readFileSync(cfg, "utf-8"));
        const figmaEntry = d?.mcpServers?.figma || {};
        const hasFigma = Object.keys(figmaEntry).length > 0;
        const pat = figmaEntry.env?.FIGMA_PERSONAL_ACCESS_TOKEN || "";
        const bridgeTok = figmaEntry.env?.FIGMA_BRIDGE_TOKEN || "";
        const tokStatus = pat ? "PAT configured" : "no PAT (Live canvas only)";
        const bridgeStatus = bridgeTok ? "bridge token set" : "NO bridge token (insecure)";
        console.log(`  - ${cfg} [${target.location}] (figma entry: ${hasFigma ? "YES" : "NO"}, ${tokStatus}, ${bridgeStatus})`);
      } catch (e) {
        console.log(`  - ${cfg} (Error reading: ${e.message})`);
      }
    } else {
      console.log(`  - ${cfg} [NOT CREATED YET]`);
    }
  }
  console.log("==================================================");
}

function parseArgs(argv) {
  const args = { token: "", update: false, doctor: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") {
      args.token = argv[++i] || "";
    } else if (a.startsWith("--token=")) {
      args.token = a.slice("--token=".length);
    } else if (a === "--update") {
      args.update = true;
    } else if (a === "--doctor") {
      args.doctor = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.doctor) {
    runDoctor();
    return;
  }

  console.log("==================================================");
  console.log(`⚡ ${args.update ? "Updating" : "Installing"} Figma MCP Bridge + Visual Feedback Loop`);
  console.log("==================================================");

  checkNodeVersion();
  installOrUpdate({ token: args.token, isUpdate: args.update });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}

export {
  CANONICAL_KEY,
  installLocations,
  checkNodeVersion,
  getConfigTargets,
  getOrCreateBridgeToken,
  copyTreeClean,
  injectBridgeToken,
  atomicWriteJson,
  getRepoCommit,
  writeVersionMarker,
  installOrUpdate,
  runDoctor,
  parseArgs,
};
