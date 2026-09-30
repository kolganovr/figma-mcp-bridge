// Contract test for the Bridge Runtime. Run: node tests/bridge-runtime.test.js
// Extracts the Bridge Runtime block out of the plugin and
// exercises it against a stub `figma`, so the logic is verified before the
// plugin is reinstalled into Figma.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// CRLF-normalized: a Windows checkout (core.autocrlf) must not hide the markers below.
const src = fs.readFileSync(path.join(ROOT, "figma-plugin", "code.js"), "utf8").replace(/\r\n/g, "\n");

const start = src.indexOf("// ==========================================================================\n// Bridge Runtime");
const endMarker = "async function exportNodeToPngBase64";
const end = src.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error("runtime block not found");
const runtime = src.slice(start, end);

// --- stub Figma sandbox ----------------------------------------------------
const pluginData = {};
const NODE_REGISTRY = new Map();
// Every node made through makeNode() shares this single prototype, mirroring
// the real Plugin API where all nodes of comparable shape share one — this
// is exactly what patchCreationMethodsOnPrototype() in the runtime relies on
// to make clone()/createInstance() traceable by patching it once.
const nodeProto = {
  resize(w, h) { this.width = w; this.height = h; },
  appendChild(c) { c.parent = this; this.children.push(c); NODE_REGISTRY.set(c.id, c); },
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    NODE_REGISTRY.delete(this.id);
  },
  clone() {
    const c = makeNode(this.type, this.name, { width: this.width, height: this.height });
    return c;
  },
  createInstance() {
    return makeNode("INSTANCE", "Instance of " + this.name);
  },
  findAll(pred) {
    const out = [];
    (function walk(n) { for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); } })(this);
    return out;
  }
};
function makeNode(type, name, extra) {
  const node = Object.assign(Object.create(nodeProto), {
    type, name, id: "n" + Math.random().toString(36).slice(2, 8),
    parent: null, children: [], width: 100, height: 100, visible: true
  }, extra || {});
  NODE_REGISTRY.set(node.id, node);
  return node;
}
const figma = {
  editorType: "figma",
  mixed: Symbol("figma.mixed"),
  getNodeById: (id) => NODE_REGISTRY.get(id) || null,
  root: {
    setPluginData: (k, v) => { pluginData[k] = v; },
    getPluginData: (k) => pluginData[k] || ""
  },
  currentPage: makeNode("PAGE", "Page 1"),
  createFrame: () => makeNode("FRAME", "Tracked " + Math.random().toString(36).slice(2, 5)),
  createRectangle: () => makeNode("RECTANGLE", "Rect " + Math.random().toString(36).slice(2, 5)),
  createComponent: () => makeNode("COMPONENT", "Component " + Math.random().toString(36).slice(2, 5)),
  group: (nodes, parent) => {
    const g = makeNode("GROUP", "Group");
    for (const n of nodes) g.appendChild(n);
    parent.appendChild(g);
    return g;
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
const load = new Function("figma", "ensureFont", runtime + "\n;return { createBridgeApi, enrichBridgeError, bridgeWrite, bridgeRead, createTrackingFigma, computeCaptureScale };");
const { createBridgeApi, enrichBridgeError, createTrackingFigma, computeCaptureScale } = load(figma, ensureFont);

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

console.log("\n== checkpoint journal: modification tracking & rollback ==");
{
  const cp1 = bridge.checkpoint("No-op");
  const cp1Result = cp1.commit();
  check("commit with nothing tracked reports empty lists", cp1Result.created.length === 0 && cp1Result.modified.length === 0, cp1Result);

  const existing = makeNode("TEXT", "Label", { characters: "Old", opacity: 1, x: 0, y: 0 });
  const cp2 = bridge.checkpoint("Modify existing node");
  const beforeCommit = bridge.checkpoints().find(c => c.id === cp2.id);
  check("open checkpoint appears in checkpoints() before commit", !!beforeCommit && beforeCommit.committed === false, bridge.checkpoints());

  bridge.snapshot(existing);
  existing.characters = "New";
  existing.x = 40;
  const cp2Result = cp2.commit();
  check("snapshot records the modified node", cp2Result.modified.length === 1 && cp2Result.modified[0] === existing.id, cp2Result);

  const cp3 = bridge.checkpoint("Modify again");
  bridge.snapshot(existing); // second checkpoint, independent snapshot of the SAME node
  existing.characters = "Newer";
  cp3.commit();

  bridge.rollback(cp3.id);
  check("rollback restores properties from ITS OWN snapshot, not an earlier one",
    figma.getNodeById(existing.id).characters === "New", figma.getNodeById(existing.id));

  threw = "";
  try { bridge.rollback("does-not-exist"); } catch (e) { threw = e.message; }
  check("rollback of unknown checkpoint explains itself", /No rollback-eligible checkpoint/.test(threw), threw);

  threw = "";
  try { bridge.rollback(cp3.id); } catch (e) { threw = e.message; }
  check("rolling back the same checkpoint twice refuses", /already rolled back/.test(threw), threw);
}

console.log("\n== checkpoint journal: creation tracking via createTrackingFigma() ==");
{
  const cp = bridge.checkpoint("Two frames via tracking figma");
  const trackingFigma = createTrackingFigma();
  const madeA = trackingFigma.createFrame();
  const madeB = trackingFigma.createFrame();
  const cpResult = cp.commit();
  check("tracking figma recorded both creations", cpResult.created.length === 2 &&
    cpResult.created.includes(madeA.id) && cpResult.created.includes(madeB.id), cpResult);

  const untracked = figma.createFrame(); // created OUTSIDE any open checkpoint via the real figma, not the proxy
  check("creation outside an open checkpoint is not journaled",
    !cpResult.created.includes(untracked.id), cpResult);

  const rollback = bridge.rollback(cp.id);
  check("rollback removes both tracked-figma creations",
    figma.getNodeById(madeA.id) === null && figma.getNodeById(madeB.id) === null, rollback);
  check("rollback leaves an untracked node alone", figma.getNodeById(untracked.id) !== null);

  const cp2 = bridge.checkpoint("last-alias");
  trackingFigma.createFrame();
  cp2.commit();
  const lastRollback = bridge.rollback("last");
  check("rollback('last') resolves the most recently committed, not-yet-rolled-back checkpoint",
    lastRollback.checkpoint_id === cp2.id, lastRollback);
}

console.log("\n== checkpoint journal: clone()/createInstance() tracking (Undo Last AI Action bug) ==");
{
  // These go through node.clone() / component.createInstance() — methods on
  // the NODE, not on figma — which createTrackingFigma's wrapper never sees.
  // Before patchCreationMethodsOnPrototype(), a checkpoint around either
  // reported empty created[] even though a new node landed on the canvas,
  // so Undo Last AI Action ran and genuinely removed nothing.
  const template = makeNode("FRAME", "Card Template");
  const master = figma.createComponent();

  const cp = bridge.checkpoint("Clone + instantiate");
  const cloned = template.clone();
  const instance = master.createInstance();
  const cpResult = cp.commit();

  check("clone() during an open checkpoint is journaled",
    cpResult.created.includes(cloned.id), cpResult);
  check("createInstance() during an open checkpoint is journaled",
    cpResult.created.includes(instance.id), cpResult);

  const rollback = bridge.rollback(cp.id);
  check("rollback removes the cloned node", figma.getNodeById(cloned.id) === null, rollback);
  check("rollback removes the instantiated node", figma.getNodeById(instance.id) === null, rollback);

  const untrackedClone = template.clone(); // outside any open checkpoint
  check("clone() outside an open checkpoint is not journaled",
    !cpResult.created.includes(untrackedClone.id) && figma.getNodeById(untrackedClone.id) !== null);
}

console.log("\n== capture scale (max_px budget) ==");
check("small node keeps requested scale", computeCaptureScale(320, 200, 1, 1024) === 1);
check("desktop frame is capped to 1024 on the long side",
  Math.round(1440 * computeCaptureScale(1440, 900, 1.5, 1024)) === 1024, computeCaptureScale(1440, 900, 1.5, 1024));
check("tall strip is capped by height", Math.round(3000 * computeCaptureScale(375, 3000, 1, 1024)) === 1024);
check("missing max_px falls back to the 1024 default", Math.round(2048 * computeCaptureScale(2048, 100, 1)) === 1024);
check("explicit larger max_px is honoured", Math.round(2000 * computeCaptureScale(2000, 1000, 1, 2000)) === 2000);
check("pixel cap still applies above max_px", 20000 * 20000 * Math.pow(computeCaptureScale(20000, 20000, 1, 100000), 2) <= 4000001);

console.log("\n== cheap reads: summarize / inspect / find / check ==");
let inspectDone = Promise.resolve();
{
  const api = createBridgeApi();
  const card = makeNode("FRAME", "Card", {
    width: 320, height: 200, x: 10, y: 20,
    layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG",
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }], cornerRadius: 8
  });
  const title = makeNode("TEXT", "Title", {
    width: 288, height: 24, x: 16, y: 16, characters: "Submit your application form today please",
    fontName: { family: "Inter", style: "Bold" }, fontSize: 16, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }]
  });
  card.appendChild(title);
  for (let i = 0; i < 20; i++) card.appendChild(makeNode("RECTANGLE", "Row " + i, { width: 10, height: 10 }));
  figma.currentPage.appendChild(card);

  const outline = api.summarize(card.id, { depth: 1, maxChildren: 3 });
  const lines = outline.split("\n");
  check("summarize: one line for the node, capped children, and a +more marker", lines.length === 5 && /\+18 more children/.test(lines[4]), outline);
  check("summarize: layout, fill and radius in the node line",
    /FRAME "Card" #\S+ 320x200 @10,20 \[V gap8 pad16 fixed\/hug\] fill:#FFFFFF r8/.test(lines[0]), lines[0]);
  check("summarize: text line carries font and truncated text",
    /TEXT "Title" .*Inter\/Bold 16 "Submit your application form today pleas…"/.test(lines[1]), lines[1]);
  check("summarize: missing id is reported, not thrown", api.summarize(["nope:1"]) === "MISSING nope:1");

  const info = api.inspect([card.id, "0:404"], ["width", "fill", "layout", "children"]);
  check("inspect: only the requested props", JSON.stringify(info[card.id]) === JSON.stringify({ width: 320, fill: "#FFFFFF", layout: "V gap8 pad16 fixed/hug", children: 21 }), info);
  check("inspect: missing id -> MISSING", info["0:404"] === "MISSING", info);
  check("inspect: semi-transparent fill keeps opacity", api.inspect(title.id, ["fill"])[title.id].fill === "#000000@0.5");

  const found = api.find("row", { root: card.id, limit: 5 });
  check("find: capped matches plus a total marker", found.length === 6 && /\+15 more \(20 total\)/.test(found[5]), found);
  check("find: type filter", api.find("", { root: card.id, type: "TEXT" }).length === 1);

  const ok = api.check({ [card.id]: { width: 320.3, fill: "#FFFFFF", layout: "V gap8 pad16 fixed/hug" }, [title.id]: { text: /Submit/, fontStyle: "Bold" } });
  check("check: all-pass result is tiny", ok.pass === 5 && ok.fail.length === 0 && ok.missing.length === 0, ok);
  const bad = api.check([{ id: card.id, width: 300, cornerRadius: 8 }, { id: "9:9", width: 1 }]);
  check("check: failures name key, want and got", bad.fail.length === 1 && bad.fail[0].key === "width" && bad.fail[0].got === 320 && bad.pass === 1, bad);
  check("check: missing nodes are listed", bad.missing.join() === "9:9", bad);
  check("info() documents the cheap reads", Object.keys(api.info().cheapReads || {}).length >= 5);

  // figma_inspect is server-generated code over these same helpers: run what
  // the server would send, against the real runtime.
  const { buildInspectCode } = require(path.join(ROOT, "figma", "index.js"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const inspect = (args) => new AsyncFunction("figma", "bridge", buildInspectCode(args))(figma, api);
  inspectDone = (async () => {
    const two = await inspect({ node_ids: [card.id, title.id], depth: 0 });
    check("figma_inspect: several ids -> one outline, one line each", two.outline.split("\n").length === 2 && !two.props, two);
    const props = await inspect({ node_ids: [card.id], props: ["width", "fill"] });
    check("figma_inspect: props -> exact values, no outline", props.props[card.id].width === 320 && props.props[card.id].fill === "#FFFFFF" && !props.outline, props);
    const found = await inspect({ node_ids: [card.id], find: "row 1", props: ["width"] });
    check("figma_inspect: find + props reads the matches", Object.keys(found.props).length === 11, found);
    const miss = await inspect({ find: "no such layer" });
    check("figma_inspect: find with no hits says so", miss.found === "no matches" && !miss.outline, miss);
    const onlyCheck = await inspect({ check: { [card.id]: { width: 300 } } });
    check("figma_inspect: check alone reads nothing else", onlyCheck.check.fail.length === 1 && !onlyCheck.outline, onlyCheck);
    const page = await inspect({});
    check("figma_inspect: no args outlines the current page", /^PAGE "Page 1"/.test(page.outline), page);
  })();
}

inspectDone.then(() => {
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
  process.exit(failures ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
