// Contract test for install.mjs — the Node installer/updater/doctor. Run:
// node tests/install.test.js
//
// installOrUpdate always copies from the REAL figma/ + figma-plugin/ source
// next to install.mjs — pkgRoot is not test-injectable, mirroring the
// installer's own design (only home/appdata are, so a test can never risk
// touching a real machine's actual MCP configs — see the comment on
// getConfigTargets in install.mjs). Every test below points home/appdata at
// a throwaway temp directory instead.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Mirrors getConfigTargets' own per-platform Claude Desktop detection so
// this suite behaves the same on Windows, macOS, and Linux.
function seedClaudeDesktopConfigPath(home, appdata) {
  if (process.platform === "win32") {
    const dir = path.join(appdata, "Claude");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    const dir = path.join(home, "Library", "Application Support", "Claude");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "claude_desktop_config.json");
  }
  const dir = path.join(home, ".config", "Claude");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude_desktop_config.json");
}

async function main() {
  const installerPath = path.join(__dirname, "..", "install.mjs");
  const installer = await import(pathToFileURL(installerPath).href);
  const {
    getConfigTargets,
    copyTreeClean,
    injectBridgeToken,
    atomicWriteJson,
    installOrUpdate,
    installLocations,
    CANONICAL_KEY,
    figmaSettingsPath,
    checkFigmaPluginRegistration,
  } = installer;

  console.log("\n== fresh install ==");
  {
    const home = mkTempDir("figma-mcp-home-");
    const appdata = path.join(home, "AppData", "Roaming");
    const cfgPath = seedClaudeDesktopConfigPath(home, appdata);

    installOrUpdate({ token: "", isUpdate: false, home, appdata });

    check("config file was created", fs.existsSync(cfgPath));
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    check("figma server registered", !!(cfg.mcpServers && cfg.mcpServers.figma));
    check("command is node", cfg.mcpServers.figma.command === "node");
    const bridgeToken = cfg.mcpServers.figma.env.FIGMA_BRIDGE_TOKEN;
    check("bridge token generated", typeof bridgeToken === "string" && bridgeToken.length > 0);

    const canonicalMcp = installLocations(home)[CANONICAL_KEY];
    check("server copied to canonical location", fs.existsSync(path.join(canonicalMcp, "figma", "index.js")));
    check("plugin copied to canonical location", fs.existsSync(path.join(canonicalMcp, "figma-plugin", "ui.html")));
    check("version marker written", fs.existsSync(path.join(canonicalMcp, "version.json")));

    const uiHtml = fs.readFileSync(path.join(canonicalMcp, "figma-plugin", "ui.html"), "utf-8");
    check("bridge token baked into ui.html", uiHtml.includes(bridgeToken));

    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("\n== --update reuses the token and preserves unrelated config ==");
  {
    const home = mkTempDir("figma-mcp-home-");
    const appdata = path.join(home, "AppData", "Roaming");
    const cfgPath = seedClaudeDesktopConfigPath(home, appdata);

    installOrUpdate({ token: "", isUpdate: false, home, appdata });
    const firstCfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const firstToken = firstCfg.mcpServers.figma.env.FIGMA_BRIDGE_TOKEN;

    // Simulate the user already having an unrelated MCP server configured.
    firstCfg.mcpServers.other_tool = { command: "node", args: ["/somewhere/else.js"] };
    fs.writeFileSync(cfgPath, JSON.stringify(firstCfg, null, 2));

    installOrUpdate({ token: "", isUpdate: true, home, appdata });
    const secondCfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));

    check("bridge token unchanged across --update", secondCfg.mcpServers.figma.env.FIGMA_BRIDGE_TOKEN === firstToken);
    check("unrelated mcp server survives --update", !!secondCfg.mcpServers.other_tool);
    check("a .bak backup was written", fs.existsSync(`${cfgPath}.bak`));

    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("\n== unparsable existing config is skipped, not clobbered ==");
  {
    const home = mkTempDir("figma-mcp-home-");
    const appdata = path.join(home, "AppData", "Roaming");
    const cfgPath = seedClaudeDesktopConfigPath(home, appdata);
    const brokenContent = "{ not valid json ][";
    fs.writeFileSync(cfgPath, brokenContent);

    installOrUpdate({ token: "", isUpdate: false, home, appdata });

    check("broken config file left untouched", fs.readFileSync(cfgPath, "utf-8") === brokenContent);
    check("no .bak written for a config that was never touched", !fs.existsSync(`${cfgPath}.bak`));

    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("\n== copyTreeClean removes files no longer in the source ==");
  {
    const src = mkTempDir("figma-mcp-src-");
    const dst = mkTempDir("figma-mcp-dst-");
    fs.writeFileSync(path.join(src, "keep.js"), "// keep");
    fs.mkdirSync(path.join(src, "sub"));
    fs.writeFileSync(path.join(src, "sub", "keep2.js"), "// keep2");

    copyTreeClean(src, dst);
    check(
      "initial copy landed",
      fs.existsSync(path.join(dst, "keep.js")) && fs.existsSync(path.join(dst, "sub", "keep2.js"))
    );

    // Simulate files that used to ship but were since removed upstream.
    fs.writeFileSync(path.join(dst, "stale.js"), "// stale");
    fs.mkdirSync(path.join(dst, "stale-dir"));
    fs.writeFileSync(path.join(dst, "stale-dir", "stale2.js"), "// stale2");

    copyTreeClean(src, dst);
    check("stale top-level file removed", !fs.existsSync(path.join(dst, "stale.js")));
    check("stale nested file removed", !fs.existsSync(path.join(dst, "stale-dir", "stale2.js")));
    check("now-empty stale directory removed", !fs.existsSync(path.join(dst, "stale-dir")));
    check(
      "legitimate files untouched",
      fs.existsSync(path.join(dst, "keep.js")) && fs.existsSync(path.join(dst, "sub", "keep2.js"))
    );

    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }

  console.log("\n== injectBridgeToken ==");
  {
    const dir = mkTempDir("figma-mcp-plugin-");
    fs.writeFileSync(path.join(dir, "ui.html"), '<script>const BRIDGE_TOKEN = "";</script>');
    injectBridgeToken(dir, "deadbeef1234567890");
    const text = fs.readFileSync(path.join(dir, "ui.html"), "utf-8");
    check("token baked into placeholder", text.includes('const BRIDGE_TOKEN = "deadbeef1234567890";'));
    fs.rmSync(dir, { recursive: true, force: true });

    const dirNoMarker = mkTempDir("figma-mcp-plugin-");
    fs.writeFileSync(path.join(dirNoMarker, "ui.html"), "<script>// no marker here</script>");
    let threw = false;
    try {
      injectBridgeToken(dirNoMarker, "sometoken");
    } catch (e) {
      threw = true;
    }
    check("missing marker warns instead of throwing", !threw);
    fs.rmSync(dirNoMarker, { recursive: true, force: true });
  }

  console.log("\n== atomicWriteJson ==");
  {
    const dir = mkTempDir("figma-mcp-json-");
    const target = path.join(dir, "nested", "config.json");
    atomicWriteJson(target, { hello: "world" });
    check("file written through missing parent dirs", JSON.parse(fs.readFileSync(target, "utf-8")).hello === "world");
    check(
      "no leftover .tmp files",
      fs.readdirSync(path.join(dir, "nested")).every((f) => !f.endsWith(".tmp"))
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n== getConfigTargets only registers apps that already exist ==");
  {
    const home = mkTempDir("figma-mcp-home-");
    const targets = getConfigTargets(home, undefined);
    check("nothing detected on a bare home dir", targets.length === 0, targets);
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("\n== which plugin copy Figma runs ==");
  {
    const home = mkTempDir("figma-mcp-home-");
    const appdata = path.join(home, "AppData", "Roaming");
    check("no Figma settings -> unknown, not a false alarm", checkFigmaPluginRegistration(home, appdata).status === "unknown");

    const settingsPath = figmaSettingsPath(home, appdata);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const writeSettings = (manifestPaths) => fs.writeFileSync(settingsPath, JSON.stringify({
      localFileExtensions: [
        { id: 1, manifestPath: path.join(home, "other-plugin", "manifest.json") },
        ...manifestPaths.map((p, i) => ({ id: 10 + i, manifestPath: p }))
      ]
    }));
    const seedManifest = (dir, id) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id }));
      return path.join(dir, "manifest.json");
    };
    seedManifest(path.join(home, "other-plugin"), "someone-else");

    writeSettings([]);
    check("Figma without our plugin -> none", checkFigmaPluginRegistration(home, appdata).status === "none");

    const repoManifest = seedManifest(path.join(home, "src", "figma-mcp-bridge", "figma-plugin"), "antigravity-figma-bridge");
    writeSettings([repoManifest]);
    const wrong = checkFigmaPluginRegistration(home, appdata);
    check("repo checkout registered -> wrong, naming it", wrong.status === "wrong" && wrong.wrong[0] === repoManifest, wrong);
    check("...and pointing at the installed manifest", wrong.manifest === path.join(installLocations(home)[CANONICAL_KEY], "figma-plugin", "manifest.json"), wrong.manifest);

    const installedManifest = seedManifest(path.join(installLocations(home).antigravity, "figma-plugin"), "antigravity-figma-bridge");
    writeSettings([installedManifest]);
    check("any installed copy registered -> ok", checkFigmaPluginRegistration(home, appdata).status === "ok");

    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("\n== repository plugin carries no token ==");
  {
    // install.mjs bakes the token into the INSTALLED copies only. A token in
    // the source ui.html would be committed and pushed.
    const ui = fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "ui.html"), "utf-8");
    check("figma-plugin/ui.html keeps the empty BRIDGE_TOKEN placeholder", ui.includes('const BRIDGE_TOKEN = "";'));
  }

  console.log(`\n${failures === 0 ? "All install.mjs checks passed." : failures + " check(s) FAILED."}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
