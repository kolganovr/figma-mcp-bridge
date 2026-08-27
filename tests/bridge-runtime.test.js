// Contract test for the Bridge Runtime. Run: node tests/bridge-runtime.test.js
// Extracts the Bridge Runtime block out of the plugin and
// exercises it against a stub `figma`, so the logic is verified before the
// plugin is reinstalled into Figma.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "figma-plugin", "code.js"), "utf8");

const start = src.indexOf("// ==========================================================================\n// Bridge Runtime");
const endMarker = "async function exportNodeToPngBase64";
const end = src.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error("runtime block not found");
const runtime = src.slice(start, end);

// --- stub Figma sandbox ----------------------------------------------------
const pluginData = {};
function makeNode(type, name, extra) {
  return Object.assign({
    type, name, id: "n" + Math.random().toString(36).slice(2, 8),
    parent: null, children: [], width: 100, height: 100,
    resize(w, h) { this.width = w; this.height = h; },
    appendChild(c) { c.parent = this; this.children.push(c); }
  }, extra || {});
}
const figma = {
  editorType: "figma",
  root: {
    setPluginData: (k, v) => { pluginData[k] = v; },
    getPluginData: (k) => pluginData[k] || ""
  },
  createComponentFromNode(node) {
    // emulate the documented worst case: everything forced to FIXED, new ids
    const clone = (n) => {
      const c = makeNode(n === node ? "COMPONENT" : n.type, n.name, {
        layoutMode: n.layoutMode,
        primaryAxisSizingMode: n.layoutMode && n.layoutMode !== "NONE" ? "FIXED" : undefined,
        counterAxisSizingMode: n.layoutMode && n.layoutMode !== "NONE" ? "FIXED" : undefined,
        width: 10, height: 10
      });
      c.children = n.children.map(ch => { const cc = clone(ch); cc.parent = c; return cc; });
      return c;
    };
    return clone(node);
  }
};
async function ensureFont() {}

// --- load the runtime ------------------------------------------------------
const load = new Function("figma", "ensureFont", runtime + "\n;return { createBridgeApi, enrichBridgeError, bridgeWrite, bridgeRead };");
const { createBridgeApi, enrichBridgeError } = load(figma, ensureFont);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

console.log("\n== modules ==");
let bridge = createBridgeApi();
const KIT = [
  "function mk(name) { return 'made:' + name; }",
  "const VERSION = '1.0.0';",
  "class Box { constructor(w) { this.w = w; } }",
  "module.exports = { mk, VERSION, Box };"
].join("\n");

const kit = bridge.define("kit", KIT);
check("function declaration survives", kit.mk("card") === "made:card", kit.mk("card"));
check("const declaration survives", kit.VERSION === "1.0.0");
check("class declaration survives", new kit.Box(7).w === 7);
check("listed", bridge.list().join() === "kit", bridge.list());

// simulate a plugin reload: brand new api, in-memory cache gone, doc data kept
bridge = createBridgeApi();
const reloaded = bridge.require("kit");
check("reload from document", reloaded.mk("x") === "made:x");
check("source readable", bridge.source("kit").indexOf("module.exports") > 0);

let threw = "";
try { bridge.require("nope"); } catch (e) { threw = e.message; }
check("missing module explains itself", /not defined/.test(threw) && /bridge.define/.test(threw), threw);

threw = "";
try { bridge.define("bad", "const x = 1;"); } catch (e) { threw = e.message; }
check("module without exports explains itself", /exported nothing/.test(threw), threw);

threw = "";
try { bridge.define("bad2", "await something();"); } catch (e) { threw = e.message; }
check("top-level await explains itself", /synchronous|SYNCHRONOUS/.test(threw), threw);

console.log("\n== chunking (>60KB source) ==");
const big = "const BLOB = '" + "x".repeat(150000) + "'; module.exports = { size: BLOB.length };";
bridge.define("big", big);
const bridge2 = createBridgeApi();
check("big module round-trips", bridge2.require("big").size === 150000, bridge2.require("big").size);
check("chunk count recorded", pluginData["abridge:mod:big:n"] === "3", pluginData["abridge:mod:big:n"]);
// rewrite smaller: stale chunks must be cleared
bridge2.define("big", "module.exports = { size: 1 };");
check("shrink clears stale chunks", createBridgeApi().require("big").size === 1);

console.log("\n== store ==");
bridge.store.set("tokens", { brand: "#6366F1", n: 2 });
check("store round-trip", createBridgeApi().store.get("tokens").brand === "#6366F1");
check("store keys", createBridgeApi().store.keys().join() === "tokens", bridge.store.keys());
check("store fallback", bridge.store.get("missing", "dflt") === "dflt");
bridge.store.remove("tokens");
check("store remove", createBridgeApi().store.keys().length === 0);

console.log("\n== componentize (worst case: figma forces FIXED) ==");
const outer = makeNode("FRAME", "Card", { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
const inner = makeNode("FRAME", "Row", { layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
const leaf = makeNode("RECTANGLE", "Rect");
inner.appendChild(leaf);
outer.appendChild(inner);
const comp = bridge.componentize(outer);
check("root sizing restored", comp.primaryAxisSizingMode === "AUTO" && comp.counterAxisSizingMode === "AUTO",
  comp.primaryAxisSizingMode + "/" + comp.counterAxisSizingMode);
check("nested sizing restored", comp.children[0].primaryAxisSizingMode === "AUTO" && comp.children[0].counterAxisSizingMode === "FIXED",
  comp.children[0].primaryAxisSizingMode + "/" + comp.children[0].counterAxisSizingMode);

console.log("\n== setPosition guard ==");
const instance = makeNode("INSTANCE", "Button");
const child = makeNode("TEXT", "Label");
instance.appendChild(child);
threw = "";
try { bridge.setPosition(child, 10, 10); } catch (e) { threw = e.message; }
check("blocks x/y inside INSTANCE with remedy", /AutoLayout/.test(threw) && /MASTER COMPONENT/.test(threw), threw);
const free = makeNode("FRAME", "Free");
bridge.setPosition(free, 5, 6);
check("allows x/y outside instance", free.x === 5 && free.y === 6);

console.log("\n== info ==");
const info = bridge.info();
check("info mentions fresh scope", /fresh async function/.test(info.executionModel));
check("info warns about eval", /INDIRECT eval/.test(info.evalWarning));
check("info lists injected globals", info.injected.indexOf("bridge") >= 0);

console.log("\n== error hints ==");
const cases = [
  ["in set_y: This property cannot be overridden in an instance: relative-transform", /AutoLayout/],
  ["Error: Cannot write to node with unloaded font \"Inter Bold\"", /ensureFont/],
  ["ReferenceError: mk is not defined", /bridge.define/],
  ["SyntaxError: Unexpected token '}'", /async function body/],
  ["Error: The node with id \"1:2\" does not exist", /new ids/],
  ["Error: something completely unknown", null]
];
for (const [msg, re] of cases) {
  const out = enrichBridgeError(new Error(msg));
  if (re) check("hint for: " + msg.slice(0, 42), out.hint && re.test(out.hint), out.hint);
  else check("no hint for unknown error", out.hint === null, out.hint);
}

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures ? 1 : 0);
