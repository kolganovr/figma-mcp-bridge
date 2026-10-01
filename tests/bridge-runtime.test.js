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
  appendChild(c) {
    if (c.parent) c.parent.children = c.parent.children.filter(x => x !== c);
    c.parent = this; this.children.push(c); NODE_REGISTRY.set(c.id, c);
  },
  insertChild(i, c) {
    if (c.parent) c.parent.children = c.parent.children.filter(x => x !== c);
    c.parent = this; this.children.splice(i, 0, c); NODE_REGISTRY.set(c.id, c);
  },
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    NODE_REGISTRY.delete(this.id);
  },
  resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
  setProperties(map) {
    for (const k of Object.keys(map)) {
      if (!this.componentProperties || !(k in this.componentProperties)) throw new Error("stub: unknown property " + k);
    }
    for (const k of Object.keys(map)) this.componentProperties[k].value = map[k];
  },
  get absoluteTransform() {
    let x = this.x || 0, y = this.y || 0;
    for (let p = this.parent; p; p = p.parent) { x += p.x || 0; y += p.y || 0; }
    return [[1, 0, x], [0, 1, y]];
  },
  clone() {
    const c = makeNode(this.type, this.name, { width: this.width, height: this.height });
    return c;
  },
  createInstance() {
    const inst = makeNode("INSTANCE", "Instance of " + this.name, {
      mainComponent: this, width: this.width, height: this.height,
      componentProperties: JSON.parse(JSON.stringify(this.baseProps || {})),
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO"
    });
    this.children.forEach(ch => {
      if (ch.type === "TEXT") inst.appendChild(makeNode("TEXT", ch.name, { characters: ch.characters, fontName: ch.fontName }));
    });
    return inst;
  },
  findAll(pred) {
    const out = [];
    (function walk(n) { for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); } })(this);
    return out;
  },
  findAllWithCriteria(criteria) {
    findAllWithCriteriaCalls.push({ id: this.id, criteria, skip: figma.skipInvisibleInstanceChildren });
    return this.findAll(n => !criteria.types || criteria.types.includes(n.type));
  }
};
const findAllWithCriteriaCalls = [];
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
  skipInvisibleInstanceChildren: false,
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
const fontCalls = [];
async function ensureFont(family, style) { fontCalls.push(family + "/" + style); }

// --- load the runtime ------------------------------------------------------
const load = new Function("figma", "ensureFont", runtime + "\n;return { createBridgeApi, enrichBridgeError, bridgeWrite, bridgeRead, createTrackingFigma, computeCaptureScale, parseStackFrames, calibrateFromProbeStack, locateErrorInCode, getAnonCalibration, sanitizeForTransfer, EXECUTE_PARAM_NAMES };");
const {
  createBridgeApi, enrichBridgeError, createTrackingFigma, computeCaptureScale,
  parseStackFrames, calibrateFromProbeStack, locateErrorInCode, getAnonCalibration, sanitizeForTransfer, EXECUTE_PARAM_NAMES
} = load(figma, ensureFont);

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

  const cpWrite = bridge.checkpoint("write before reads");
  trackingFigma.createFrame();
  cpWrite.commit();
  const before = bridge.checkpoints().length;
  let readResult = null;
  for (let i = 0; i < 60; i++) readResult = bridge.checkpoint("read " + i).commit(); // 60 reads > the 50-slot ring
  check("a read (nothing journaled) gets no checkpoint id and leaves the ring untouched",
    readResult.checkpoint_id === null && bridge.checkpoints().length === before, { readResult, before, after: bridge.checkpoints().length });
  check("...so rollback('last') after many reads still undoes the write",
    bridge.rollback("last").checkpoint_id === cpWrite.id);
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
    const map = await inspect({ node_ids: [card.id], view: "map" });
    check("figma_inspect: view map -> geometry + child count only", /children:21/.test(map.outline.split("\n")[0]) && !/fill:/.test(map.outline), map);
    const ft = await inspect({ node_ids: [card.id], find_text: "application" });
    check("figma_inspect: find_text returns id, text and frame per hit", typeof ft.found === "string" && ft.found.indexOf("#" + title.id) === 0 && /«Submit your application/.test(ft.found) && / in /.test(ft.found), ft);
    const ctx = await inspect({ node_ids: [card.id], context: true });
    check("figma_inspect: context keyed by id, next to the outline", ctx.context && ctx.context[card.id] && ctx.context[card.id].node.id === card.id && typeof ctx.outline === "string", ctx);
    const reac = await inspect({ node_ids: [card.id], props: ["reactions"] });
    check("figma_inspect: props reactions reads without error", reac.props[card.id] && !/^ERR/.test(String(reac.props[card.id].reactions)), reac);
  })();
}

// ===== v4.2.1 additions ======================================================
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const rejects = async (fn) => { try { await fn(); } catch (e) { return e.message; } return ""; };
const newPage = (name) => makeNode("PAGE", name || "Design");

// a component set "Button" with a Status variant, and a plain "Badge"
function makeButtonKit() {
  const set = makeNode("COMPONENT_SET", "Button", {
    componentPropertyDefinitions: {
      "Status": { type: "VARIANT", variantOptions: ["Default", "Dropdown"], defaultValue: "Default" },
      "Show icon#1:2": { type: "BOOLEAN", defaultValue: false },
      "Label#1:3": { type: "TEXT", defaultValue: "Hi" },
      "Icon#1:4": { type: "INSTANCE_SWAP", defaultValue: "9:9" }
    }
  });
  const baseProps = {
    "Status": { type: "VARIANT", value: "Default" },
    "Show icon#1:2": { type: "BOOLEAN", value: false },
    "Label#1:3": { type: "TEXT", value: "Hi" },
    "Icon#1:4": { type: "INSTANCE_SWAP", value: "9:9" }
  };
  const v1 = makeNode("COMPONENT", "Status=Default", { baseProps, width: 120, height: 40 });
  v1.appendChild(makeNode("TEXT", "Label", { characters: "Hi", fontName: { family: "Inter", style: "Bold" } }));
  set.appendChild(v1);
  set.defaultVariant = v1;
  const badge = makeNode("COMPONENT", "Badge", {
    componentPropertyDefinitions: { "Text#2:1": { type: "TEXT", defaultValue: "New" } },
    baseProps: { "Text#2:1": { type: "TEXT", value: "New" } }
  });
  return { set, v1, badge };
}

console.log("\n== summarize view:map ==");
{
  const api = createBridgeApi();
  const page = newPage("Map page");
  const fr = makeNode("FRAME", "Hero", { width: 1440, height: 800, x: 0, y: 0, fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], cornerRadius: 8 });
  const t = makeNode("TEXT", "Title", { width: 200, height: 20, x: 5, y: 6, characters: "Hello", fontName: { family: "Inter", style: "Bold" }, fontSize: 12 });
  fr.appendChild(t); page.appendChild(fr);
  const out = api.summarize(page.id, { depth: 2, view: "map" });
  const lines = out.split("\n");
  check("map: one string joined by newlines", typeof out === "string" && lines.length === 3, out);
  check("map: page line has children:N and no coords", lines[0] === 'PAGE "Map page" #' + page.id + " 100x100 children:1", lines[0]);
  check("map: frame line is exactly TYPE name id WxH @x,y children:N", lines[1] === '  FRAME "Hero" #' + fr.id + " 1440x800 @0,0 children:1", lines[1]);
  check("map: leaf has no children marker and no fill/font/text", lines[2] === '    TEXT "Title" #' + t.id + " 200x20 @5,6", lines[2]);
  check("map: full view still available", /fill:#FF0000 r8/.test(api.summarize(fr.id, { depth: 0 })));
}

console.log("\n== summarize view:table: screen chrome is not a table ==");
{
  const api = createBridgeApi();
  const page = newPage("Chrome page");
  const screen = makeNode("FRAME", "Screen", { x: 0, y: 0, width: 1366 }); page.appendChild(screen);
  // header and sidebar share a child count but not a column (x / width differ)
  const header = makeNode("FRAME", "Header", { x: 0, y: 0, width: 1366 }); screen.appendChild(header);
  const sidebar = makeNode("FRAME", "Sidebar", { x: 0, y: 80, width: 240 }); screen.appendChild(sidebar);
  for (let i = 0; i < 3; i++) { header.appendChild(makeNode("FRAME", "h" + i)); sidebar.appendChild(makeNode("FRAME", "s" + i)); }
  const content = makeNode("FRAME", "Content", { x: 240, y: 80, width: 1126 }); screen.appendChild(content);
  for (let r = 0; r < 4; r++) {
    const row = makeNode("FRAME", "Frame 2131329" + r, { x: 0, y: 40 * r, width: 1000 });
    for (let c = 0; c < 3; c++) { const cell = makeNode("FRAME", "c"); cell.appendChild(makeNode("TEXT", "t", { characters: "v" + r + c })); row.appendChild(cell); }
    content.appendChild(row);
  }
  const out = api.summarize(screen.id, { view: "table" });
  check("chrome: header + sidebar (same child count, different x/width) are skipped, the real table is found",
    out.split("\n")[0] === 'TABLE #' + content.id + ' "Content" rows:4 cols:3 rowW:1000', out);
}

console.log("\n== summarize view:table ==");
{
  const api = createBridgeApi();
  const page = newPage("Table page");
  const H = { layoutMode: "HORIZONTAL", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 };
  const widths = [558, 95, 158, 77, 158, 124];
  const titles = ["Сотрудник", "Аренда", "Последнее редактирование", "ДМС", "Статус", "Комментарий\nк записи которая очень длинная"];
  const checkbox = { name: "checkbox" };
  const textCell = (s) => { const c = makeNode("FRAME", "ячейки таблицы"); c.appendChild(makeNode("TEXT", "t", { characters: s })); return c; };
  const checkCell = (state) => makeNode("INSTANCE", "checkbox", { mainComponent: checkbox, variantProperties: { State: state } });
  const screen = makeNode("FRAME", "Screen 1366"); page.appendChild(screen);
  const table = makeNode("FRAME", "table"); screen.appendChild(table);
  const filters = makeNode("INSTANCE", "Фильтры десктоп"); table.appendChild(filters);
  for (let i = 0; i < 3; i++) filters.appendChild(makeNode("FRAME", "f" + i));
  const hwrap = makeNode("FRAME", "Заголовки таблицы"); table.appendChild(hwrap);
  const hrow = makeNode("FRAME", "Заголовки", Object.assign({ width: 1170 }, H)); hwrap.appendChild(hrow);
  widths.forEach((w, i) => {
    const bg = makeNode("FRAME", "фон", { width: w, layoutSizingHorizontal: i === 0 ? "FILL" : "FIXED" });
    bg.appendChild(makeNode("TEXT", "label", { characters: titles[i] }));
    hrow.appendChild(bg);
  });
  const rows = [];
  for (let r = 0; r < 8; r++) {
    const row = makeNode("FRAME", "Строки таблицы/Строки таблицы/off", Object.assign({ width: 1170 }, H));
    row.appendChild(textCell(r % 3 === 0 ? "Фамилия Имя Отчество" : "Иванов Иван " + r));
    row.appendChild(checkCell(r < 6 ? "Default" : "Disabled"));
    row.appendChild(textCell("01.01.2026"));
    row.appendChild(checkCell("Default"));
    row.appendChild(textCell("Работает"));
    row.appendChild(makeNode("FRAME", "ячейки таблицы")); // empty cell
    table.appendChild(row); rows.push(row);
  }
  const out = api.summarize(screen.id, { view: "table" });
  const lines = out.split("\n");
  check("table: one block, TABLE line has id, name, rows, cols, rowW, layout without sizing",
    lines[0] === 'TABLE #' + table.id + ' "table" rows:8 cols:6 rowW:1170 [H gap0 pad0]', lines[0]);
  check("table: header found one level deeper than rows (skipping the 1-child wrapper)", lines[1] === '  header #' + hrow.id + ' "Заголовки"', lines[1]);
  check("table: column 1 has title, width, sizing and text distribution", lines[2] === '  1 "Сотрудник" w558 fill → text «Фамилия Имя Отчество» «Иванов Иван 1» …', lines[2]);
  check("table: column 2 = checkbox variant distribution", lines[3] === '  2 "Аренда" w95 fixed → checkbox State=Default×6 State=Disabled×2', lines[3]);
  check("table: header text with newline is flattened and clipped to 30", /^  6 "Комментарий к записи которая о…" w124 fixed → /.test(lines[7]), lines[7]);
  check("table: empty cells are counted", /empty×8$/.test(lines[7]), lines[7]);
  check("table: row0 line gives first row id and all cell ids", lines[8] === "  row0 #" + rows[0].id + " cells: " + rows[0].children.map(c => "#" + c.id).join(" "), lines[8]);
  check("table: nothing but one block (non-table INSTANCE ignored)", lines.length === 9, lines.length);

  // second table: layer names are meaningless, header is a direct sibling, hidden rows are ignored
  const screen2 = makeNode("FRAME", "Screen 768"); page.appendChild(screen2);
  const t2 = makeNode("FRAME", "Frame 2131329412"); screen2.appendChild(t2);
  const h2 = makeNode("FRAME", "Frame 2131329395", Object.assign({ width: 700 }, H)); t2.appendChild(h2);
  ["Имя", "Роль", "Дата"].forEach(s => { const c = makeNode("FRAME", "Frame 1", { width: 100 }); c.appendChild(makeNode("TEXT", "x", { characters: s })); h2.appendChild(c); });
  for (let r = 0; r < 3; r++) {
    const row = makeNode("FRAME", "Frame 2131329398", Object.assign({ width: 700 }, H));
    row.appendChild(textCell("a" + r)); row.appendChild(checkCell("Default")); row.appendChild(textCell("b"));
    t2.appendChild(row);
  }
  const hidden = makeNode("FRAME", "Frame 9", { visible: false });
  for (let i = 0; i < 3; i++) hidden.appendChild(makeNode("FRAME", "c"));
  t2.appendChild(hidden);
  const out2 = api.summarize(screen2.id, { view: "table" }).split("\n");
  check("table #2: found by structure alone (names are Frame NNN)", out2[0] === 'TABLE #' + t2.id + ' "Frame 2131329412" rows:3 cols:3 rowW:700 [H gap0 pad0]', out2[0]);
  check("table #2: header + columns", out2[1].indexOf("header #" + h2.id) === 2 && out2[2] === '  1 "Имя" w100 → text «a0» «a1» …' && out2[3] === '  2 "Роль" w100 → checkbox State=Default×3', out2);

  // no table, several ids at once -> one block per node
  const plain = makeNode("FRAME", "Plain 360"); page.appendChild(plain);
  plain.appendChild(makeNode("TEXT", "only", { characters: "x" }));
  const multi = api.summarize([screen.id, plain.id, screen2.id], { view: "table" }).split("\n");
  check("table: no table -> '#id name: no table found'", multi.indexOf('#' + plain.id + ' "Plain 360": no table found') === 9, multi);
  check("table: several node_ids -> blocks in order", multi[0].indexOf("TABLE #" + table.id) === 0 && multi.some(l => l.indexOf("TABLE #" + t2.id) === 0), multi);
  check("table: missing id reported", api.summarize(["nope:1"], { view: "table" }) === "MISSING nope:1");

  // two tables inside one frame -> both
  const both = makeNode("FRAME", "Two tables"); page.appendChild(both);
  for (let t = 0; t < 2; t++) {
    const box = makeNode("FRAME", "box" + t); both.appendChild(box);
    for (let r = 0; r < 2; r++) { const row = makeNode("FRAME", "row"); box.appendChild(row); row.appendChild(textCell("a")); row.appendChild(textCell("b")); }
  }
  const twoOut = api.summarize(both.id, { view: "table" });
  check("table: several tables in one frame all reported", (twoOut.match(/^TABLE #/gm) || []).length === 2 && /header none/.test(twoOut), twoOut);
  check("table: leaves figma.skipInvisibleInstanceChildren as it was", figma.skipInvisibleInstanceChildren === false);

  const { buildInspectCode } = require(path.join(ROOT, "figma", "index.js"));
  const code = buildInspectCode({ node_ids: [screen.id, screen2.id], view: "table" });
  check("buildInspectCode: view 'table' reaches summarize", /"view":"table"/.test(code) && /so\.view = 'table'/.test(code) && /bridge\.summarize\(refs, so\)/.test(code), code);
  check("buildInspectCode: unknown view stays null", /"view":null/.test(buildInspectCode({ view: "grid" })));
  inspectDone = inspectDone.then(async () => {
    const res = await new AsyncFunction("figma", "bridge", code)(figma, api);
    check("figma_inspect: view table -> outline holds the table text", typeof res.outline === "string" && res.outline.indexOf("TABLE #" + table.id) === 0 && /TABLE #/.test(res.outline.split("\n").slice(9).join("\n")), res);
  });
}

console.log("\n== find: text search ==");
{
  const api = createBridgeApi();
  const page = newPage();
  const login = makeNode("FRAME", "Login screen");
  const home = makeNode("SECTION", "Home section");
  const inner = makeNode("FRAME", "Inner");
  page.appendChild(login); page.appendChild(home); home.appendChild(inner);
  const a = makeNode("TEXT", "Cta", { characters: "Sign In to continue, or register with a long text" });
  const b = makeNode("TEXT", "Note", { characters: "please SIGN in first" });
  const c = makeNode("TEXT", "Other", { characters: "Nothing here" });
  const d = makeNode("RECTANGLE", "sign in rect");
  login.appendChild(a); inner.appendChild(b); inner.appendChild(c); inner.appendChild(d);

  findAllWithCriteriaCalls.length = 0;
  api.find("x", { root: login.id, text: true });
  check("find: scoped search (root = frame) keeps hidden instance children visible", findAllWithCriteriaCalls[0].skip === false, findAllWithCriteriaCalls);
  findAllWithCriteriaCalls.length = 0;
  const found = api.find("sign in", { root: page.id, text: true });
  check("find text: case-insensitive substring over characters, TEXT only", found.length === 2 && found.every(x => x.type === "TEXT"), found);
  check("find text: result shape + text truncated to 40",
    found[0].id === a.id && found[0].name === "Cta" && found[0].text === "Sign In to continue, or register with a long text".slice(0, 40) && found[0].text.length === 40, found[0]);
  check("find text: frame = top-level container name + id",
    found[0].frame === "Login screen #" + login.id && found[1].frame === "Home section #" + home.id, found.map(x => x.frame));
  check("find text: RegExp works", api.find(/^please/i, { root: page.id, text: true }).length === 1);
  check("find text: uses findAllWithCriteria with TEXT type",
    findAllWithCriteriaCalls.length >= 1 && findAllWithCriteriaCalls[0].criteria.types.join() === "TEXT", findAllWithCriteriaCalls);
  check("find text: skipInvisibleInstanceChildren is on during the scan", findAllWithCriteriaCalls[0].skip === true);
  check("find text: ...and restored afterwards", figma.skipInvisibleInstanceChildren === false);

  figma.skipInvisibleInstanceChildren = true;
  api.find("x", { root: page.id, text: true });
  check("find: restores a previous TRUE value, not just false", figma.skipInvisibleInstanceChildren === true);
  figma.skipInvisibleInstanceChildren = false;

  const boom = makeNode("FRAME", "Boom");
  boom.findAllWithCriteria = () => { throw new Error("scan failed"); };
  threw = "";
  try { api.find("x", { root: boom.id, type: "TEXT" }); } catch (e) { threw = e.message; }
  check("find: flag restored in finally even when the scan throws", threw === "scan failed" && figma.skipInvisibleInstanceChildren === false, threw);

  findAllWithCriteriaCalls.length = 0;
  api.find("sign", { root: page.id });
  check("find: plain name search without type does not use criteria", findAllWithCriteriaCalls.length === 0);
  api.find("sign", { root: page.id, type: "RECTANGLE" });
  check("find: type filter uses findAllWithCriteria", findAllWithCriteriaCalls.length === 1 && findAllWithCriteriaCalls[0].criteria.types.join() === "RECTANGLE");

  const legacy = makeNode("FRAME", "Legacy");
  legacy.findAllWithCriteria = undefined;
  legacy.appendChild(makeNode("TEXT", "T", { characters: "sign in" }));
  check("find: falls back to findAll when findAllWithCriteria is missing", api.find("sign", { root: legacy.id, text: true }).length === 1);
}

console.log("\n== context ==");
{
  const api = createBridgeApi();
  const page = newPage("Design");
  const { set, v1, badge } = makeButtonKit();
  const wide = makeNode("FRAME", "Desktop A", { width: 1440 });
  const wide2 = makeNode("FRAME", "Desktop B", { width: 1440 });
  const mobile = makeNode("FRAME", "Mobile", { width: 375 });
  const rect = makeNode("RECTANGLE", "Deco", { width: 999 });
  const section = makeNode("SECTION", "Flows");
  const s1 = makeNode("FRAME", "Flow m1", { width: 375 });
  const s2 = makeNode("FRAME", "Flow m2", { width: 375 });
  const s3 = makeNode("COMPONENT", "Flow tablet", { width: 768 });
  [wide, wide2, mobile, rect, section, set, badge].forEach(n => page.appendChild(n));
  [s1, s2, s3].forEach(n => section.appendChild(n));

  const body = makeNode("FRAME", "Body", { width: 300, height: 200 });
  wide.appendChild(body);
  for (let i = 0; i < 3; i++) body.appendChild(v1.createInstance());
  const b1 = badge.createInstance();
  body.appendChild(b1);
  body.appendChild(badge.createInstance());

  const ctx = api.context(body.id);
  check("context: node summary", JSON.stringify(ctx.node) === JSON.stringify({ id: body.id, name: "Body", type: "FRAME", w: 300, h: 200 }), ctx.node);
  check("context: ancestors from page down, strings", JSON.stringify(ctx.ancestors) === JSON.stringify(['PAGE "Design" #' + page.id, 'FRAME "Desktop A" #' + wide.id]), ctx.ancestors);
  check("context: siblings are widths of neighbouring frames by frequency", JSON.stringify(api.context(wide.id).siblings) === JSON.stringify([{ w: 100, n: 1 }, { w: 375, n: 1 }, { w: 1440, n: 1 }]), api.context(wide.id).siblings);
  check("context: pageWidths counts top level + inside sections, by frequency",
    JSON.stringify(ctx.pageWidths) === JSON.stringify([{ w: 375, n: 3 }, { w: 1440, n: 2 }, { w: 100, n: 1 }, { w: 768, n: 1 }]), ctx.pageWidths);
  check("context: components sorted by usage", ctx.components.length === 2 && ctx.components[0].set === "Button #" + set.id && ctx.components[0].used === 3 && ctx.components[1].used === 2, ctx.components);
  check("context: variant options / BOOLEAN / TEXT / INSTANCE_SWAP, no #suffix",
    JSON.stringify(ctx.components[0].props) === JSON.stringify({ Status: ["Default", "Dropdown"], "Show icon": "BOOLEAN", Label: "TEXT", Icon: "INSTANCE_SWAP" }), ctx.components[0].props);
  check("context: plain component (no set) reports itself", ctx.components[1].set === "Badge #" + badge.id && ctx.components[1].props.Text === "TEXT", ctx.components[1]);
  check("context: an instance counts itself", api.context(b1.id).components[0].used === 1 && api.context(b1.id).components[0].set.startsWith("Badge"));
  check("context: conventions null when unset", ctx.conventions === null);
  api.store.set("conventions", { breakpoints: [375, 1440], section: "Flows" });
  check("context: conventions come from bridge.store", api.context(body.id).conventions.section === "Flows");
  api.store.remove("conventions");
  check("context: compact (< 2 KB)", JSON.stringify(ctx).length < 2000, JSON.stringify(ctx).length);
  threw = "";
  try { api.context("0:404"); } catch (e) { threw = e.message; }
  check("context: missing node throws a clear error", /does not exist/.test(threw), threw);

  const wideCap = newPage("Wide");
  [100, 200, 300, 400, 500, 600, 700, 800].forEach(w => wideCap.appendChild(makeNode("FRAME", "F" + w, { width: w })));
  check("context: pageWidths capped at 6", api.context(wideCap.children[0].id).pageWidths.length === 6);

  const many = makeNode("FRAME", "Many");
  for (let i = 0; i < 20; i++) {
    const c = makeNode("COMPONENT", "C" + i, { componentPropertyDefinitions: {}, baseProps: {} });
    many.appendChild(makeNode("INSTANCE", "i" + i, { mainComponent: c, componentProperties: {} }));
  }
  check("context: components capped at 12", api.context(many.id).components.length === 12);
}

console.log("\n== reactions / connector in inspect ==");
{
  const api = createBridgeApi();
  const btn = makeNode("FRAME", "Btn", {
    reactions: [
      { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "OVERLAY", destinationId: "183:80012" }, { type: "BACK" }] },
      { trigger: { type: "ON_HOVER" }, action: { type: "NODE", navigation: "NAVIGATE", destinationId: "1:2" } },
      { trigger: { type: "ON_CLICK" }, actions: [{ type: "URL", url: "https://x.dev" }] }
    ]
  });
  const plain = makeNode("FRAME", "Plain", { reactions: [] });
  const noReactions = makeNode("RECTANGLE", "NoReactions");
  const conn = makeNode("CONNECTOR", "Arrow", { connectorStart: { endpointNodeId: "5:1", magnet: "AUTO" }, connectorEnd: { endpointNodeId: "5:2" } });
  const got = api.inspect([btn.id, plain.id, conn.id, noReactions.id], ["reactions", "connector"]);
  check("reactions: actions[] and legacy action become short strings",
    JSON.stringify(got[btn.id].reactions) === JSON.stringify(["ON_CLICK→NODE/OVERLAY #183:80012", "ON_CLICK→BACK", "ON_HOVER→NODE/NAVIGATE #1:2", "ON_CLICK→URL https://x.dev"]), got[btn.id].reactions);
  check("reactions: empty list stays empty, node without the property -> null", got[plain.id].reactions.length === 0 && got[noReactions.id].reactions === null, got);
  check("connector: { start, end } endpoint ids", JSON.stringify(got[conn.id].connector) === JSON.stringify({ start: "5:1", end: "5:2" }), got[conn.id]);
  check("connector: non-connector -> null", got[btn.id].connector === null);
}

console.log("\n== setProps ==");
{
  const api = createBridgeApi();
  const { set, v1, badge } = makeButtonKit();
  const btn = v1.createInstance();
  api.setProps(btn, { label: "Buy", "SHOW ICON": true, status: "Dropdown", "Icon#1:4": badge });
  const cp = btn.componentProperties;
  check("setProps: case-insensitive, base-name and exact keys", cp["Label#1:3"].value === "Buy" && cp["Show icon#1:2"].value === true && cp["Status"].value === "Dropdown");
  check("setProps: INSTANCE_SWAP takes a component node -> id", cp["Icon#1:4"].value === badge.id, cp["Icon#1:4"]);
  api.setProps(btn, { Icon: v1.id });
  check("setProps: INSTANCE_SWAP takes an id", btn.componentProperties["Icon#1:4"].value === v1.id);
  api.setProps(btn, { Icon: set });
  check("setProps: COMPONENT_SET resolves to its default variant", btn.componentProperties["Icon#1:4"].value === v1.id);
  check("setProps: returns the instance", api.setProps(btn, {}) === btn);

  const before = JSON.stringify(btn.componentProperties);
  threw = "";
  try { api.setProps(btn, { label: "Changed", colour: "red" }); } catch (e) { threw = e.message; }
  check("setProps: unknown key throws and lists available properties + variants",
    /no property "colour"/.test(threw) && /Status \(VARIANT: Default\|Dropdown\)/.test(threw) && /Label \(TEXT\)/.test(threw) && /Show icon \(BOOLEAN\)/.test(threw), threw);
  check("setProps: nothing applied when a key is unknown", JSON.stringify(btn.componentProperties) === before);
  threw = "";
  try { api.setProps(makeNode("FRAME", "F"), { a: 1 }); } catch (e) { threw = e.message; }
  check("setProps: non-instance is rejected", /expected an INSTANCE/.test(threw), threw);

  const cpj = api.checkpoint("props");
  api.setProps(btn, { Label: "In checkpoint" });
  check("setProps: instance is snapshotted into the open checkpoint", cpj.commit().modified.includes(btn.id));
}

console.log("\n== setText ==");
{
  const api = createBridgeApi();
  const card = makeNode("FRAME", "Card");
  const title = makeNode("TEXT", "Title", { characters: "Old title", fontName: { family: "Inter", style: "Bold" } });
  const sub = makeNode("FRAME", "Sub");
  const title2 = makeNode("TEXT", "Title", { characters: "Old title 2", fontName: { family: "Inter", style: "Bold" } });
  const body = makeNode("TEXT", "Body", {
    characters: "Mixed text", fontName: figma.mixed,
    getStyledTextSegments: () => [{ fontName: { family: "Inter", style: "Regular" } }, { fontName: { family: "Roboto", style: "Italic" } }, { fontName: { family: "Inter", style: "Regular" } }]
  });
  card.appendChild(title); card.appendChild(sub); sub.appendChild(title2); card.appendChild(body);

  fontCalls.length = 0;
  const done = (async () => {
    const res = await api.setText(card, { Title: "New", [body.id]: "Body text" });
    check("setText: sets every exact-name match and id matches, returns { set: ids }",
      title.characters === "New" && title2.characters === "New" && body.characters === "Body text" && res.set.length === 3 && res.set.includes(body.id), res);
    check("setText: loads every font of a mixed-font node once", fontCalls.filter(x => x === "Roboto/Italic").length === 1 && fontCalls.filter(x => x === "Inter/Regular").length === 1 && fontCalls.includes("Inter/Bold"), fontCalls);
    const one = await api.setText(title, { [title.id]: "Self" });
    check("setText: root may itself be the TEXT layer", title.characters === "Self" && one.set[0] === title.id);

    const msg = await rejects(() => api.setText(card, { Title: "Never", Nope: "x" }));
    check("setText: unknown layer -> error listing text layers", /no TEXT layer "Nope"/.test(msg) && /"Title" #/.test(msg) && /"Body" #/.test(msg), msg);
    check("setText: nothing written when any key is unknown", title.characters === "Self");

    const big = makeNode("FRAME", "Big");
    for (let i = 0; i < 25; i++) big.appendChild(makeNode("TEXT", "T" + i, { characters: "x", fontName: { family: "Inter", style: "Regular" } }));
    const msg2 = await rejects(() => api.setText(big, { zzz: "1" }));
    check("setText: lists at most 20 layer names", (msg2.match(/ #/g) || []).length === 20 && /\+5 more/.test(msg2), msg2);
  })();
  inspectDone = inspectDone.then(() => done);
}

console.log("\n== replaceWithInstance ==");
{
  const api = createBridgeApi();
  const { set, v1, badge } = makeButtonKit();
  const done = (async () => {
    const host = makeNode("FRAME", "Host");
    const before = makeNode("RECTANGLE", "Before");
    const ph = makeNode("RECTANGLE", "Placeholder", { x: 30, y: 40, width: 50, height: 60 });
    const after = makeNode("RECTANGLE", "After");
    [before, ph, after].forEach(n => host.appendChild(n));

    const inst = await api.replaceWithInstance(ph, set, { props: { Label: "Go" }, text: { Label: "Go text" } });
    check("replace: COMPONENT_SET -> instance of the default variant", inst.type === "INSTANCE" && inst.mainComponent === v1);
    check("replace: inserted at the target's index, target removed", host.children.length === 3 && host.children[1] === inst && !host.children.includes(ph), host.children.map(c => c.name));
    check("replace: non-AutoLayout parent -> x,y copied, size not forced", inst.x === 30 && inst.y === 40 && inst.width === 120);
    check("replace: props and text applied", inst.componentProperties["Label#1:3"].value === "Go" && inst.children[0].characters === "Go text");

    const ph2 = makeNode("RECTANGLE", "P2", { x: 1, y: 2, width: 50, height: 60 });
    host.appendChild(ph2);
    const inst2 = await api.replaceWithInstance(ph2, badge, { keepSize: true, remove: false });
    check("replace: keepSize resizes to the target, remove:false keeps it", inst2.width === 50 && inst2.height === 60 && host.children.includes(ph2));

    const inst3 = await api.replaceWithInstance(inst2, inst, {});
    check("replace: INSTANCE source uses its main component", inst3.mainComponent === v1);

    const auto = makeNode("FRAME", "Auto", { layoutMode: "VERTICAL" });
    const ph3 = makeNode("RECTANGLE", "P3", { x: 7, y: 8, layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", layoutAlign: "STRETCH", layoutGrow: 1, layoutPositioning: "AUTO" });
    auto.appendChild(makeNode("RECTANGLE", "first")); auto.appendChild(ph3);
    const inst4 = await api.replaceWithInstance(ph3, v1.id, {});
    check("replace: AutoLayout parent -> sizing/align/grow copied, no x/y", inst4.layoutSizingHorizontal === "FILL" && inst4.layoutSizingVertical === "HUG" && inst4.layoutAlign === "STRETCH" && inst4.layoutGrow === 1 && inst4.x === undefined && auto.children[1] === inst4, inst4);
    check("replace: string id component is resolved", inst4.mainComponent === v1);

    const nested = makeNode("INSTANCE", "Outer");
    const inside = makeNode("RECTANGLE", "Inside");
    nested.appendChild(inside);
    const msg = await rejects(() => api.replaceWithInstance(inside, set, {}));
    check("replace: target inside an INSTANCE -> clear error", /INSTANCE "Outer"/.test(msg) && /master component/.test(msg), msg);

    const ph4 = makeNode("RECTANGLE", "P4");
    host.appendChild(ph4);
    const count = host.children.length;
    const msg2 = await rejects(() => api.replaceWithInstance(ph4, set, { props: { nope: 1 } }));
    check("replace: failed props leave no orphan instance and keep the target", /no property "nope"/.test(msg2) && host.children.length === count && host.children.includes(ph4), msg2);

    const cpj = api.checkpoint("replace");
    const ph5 = makeNode("RECTANGLE", "P5"); host.appendChild(ph5);
    const inst5 = await api.replaceWithInstance(ph5, set, {});
    check("replace: the new instance is journaled by the checkpoint", cpj.commit().created.includes(inst5.id));
  })();
  inspectDone = inspectDone.then(() => done);
}

console.log("\n== shift / moveInto / fitSection ==");
{
  const api = createBridgeApi();
  const page = newPage();
  const a = makeNode("FRAME", "A", { x: 10, y: 20, width: 50, height: 50 });
  const b = makeNode("FRAME", "B", { x: 100, y: 100, width: 70, height: 30 });
  page.appendChild(a); page.appendChild(b);

  const cpj = api.checkpoint("shift");
  check("shift: returns the count and moves by dx/dy", api.shift([a, b.id], { dx: 5, dy: -10 }) === 2 && a.x === 15 && a.y === 10 && b.x === 105 && b.y === 90);
  const committed = cpj.commit();
  check("shift: snapshots existing nodes into the checkpoint", committed.modified.includes(a.id) && committed.modified.includes(b.id), committed);
  api.rollback(cpj.id);
  check("shift: rollback restores the position", a.x === 10 && a.y === 20);
  check("shift: dx defaults to 0", api.shift(a, { dy: 1 }) === 1 && a.x === 10 && a.y === 21);
  const inInst = makeNode("INSTANCE", "I"); const kid = makeNode("RECTANGLE", "K", { x: 1, y: 1 }); inInst.appendChild(kid);
  threw = ""; try { api.shift(kid, { dx: 1 }); } catch (e) { threw = e.message; }
  check("shift: inside an INSTANCE explains the remedy", /INSTANCE/.test(threw), threw);

  const box = makeNode("FRAME", "Box", { x: 100, y: 200, width: 500, height: 500 });
  page.appendChild(box);
  const absBefore = [a.absoluteTransform[0][2], a.absoluteTransform[1][2]];
  const ids = api.moveInto([a, b], box);
  check("moveInto: returns ids and reparents", ids.join() === [a.id, b.id].join() && a.parent === box && b.parent === box);
  check("moveInto: layout none keeps the absolute canvas position", a.absoluteTransform[0][2] === absBefore[0] && a.absoluteTransform[1][2] === absBefore[1] && a.x === -90 && a.y === -179, [a.x, a.y]);

  const row = makeNode("FRAME", "Row", { x: 0, y: 0, width: 900, height: 900 });
  page.appendChild(row);
  const r1 = makeNode("FRAME", "R1", { width: 50, height: 10 });
  const r2 = makeNode("FRAME", "R2", { width: 70, height: 20 });
  const r3 = makeNode("FRAME", "R3", { width: 30, height: 40 });
  [r1, r2, r3].forEach(n => page.appendChild(n));
  api.moveInto([r1, r2, r3], row, { layout: "row", gap: 10, padding: 5 });
  check("moveInto: row lays out from padding with gap", [r1, r2, r3].map(n => n.x).join() === "5,65,145" && [r1, r2, r3].every(n => n.y === 5), [r1.x, r2.x, r3.x]);
  api.moveInto([r1, r2, r3], row, { layout: "column" });
  check("moveInto: column, default gap 100 / padding 0", [r1, r2, r3].map(n => n.y).join() === "0,110,230" && [r1, r2, r3].every(n => n.x === 0), [r1.y, r2.y, r3.y]);
  threw = ""; try { api.moveInto(r1, row, { layout: "grid" }); } catch (e) { threw = e.message; }
  check("moveInto: rejects unknown layout", /layout must be/.test(threw), threw);

  const sec = makeNode("SECTION", "Sec", { x: 1000, y: 1000, width: 100, height: 100 });
  page.appendChild(sec);
  const ca = makeNode("FRAME", "CA", { x: 20, y: 30, width: 100, height: 100 });
  const cb = makeNode("FRAME", "CB", { x: 300, y: 50, width: 50, height: 50 });
  sec.appendChild(ca); sec.appendChild(cb);
  const absA = [ca.absoluteTransform[0][2], ca.absoluteTransform[1][2]];
  const absB = [cb.absoluteTransform[0][2], cb.absoluteTransform[1][2]];
  const cps = api.checkpoint("fit");
  const ret = api.fitSection(sec, { padding: 40 });
  check("fitSection: returns the section, sized bbox + 2*padding", ret === sec && sec.width === 410 && sec.height === 180, [sec.width, sec.height]);
  check("fitSection: children keep their absolute position", ca.absoluteTransform[0][2] === absA[0] && ca.absoluteTransform[1][2] === absA[1] && cb.absoluteTransform[0][2] === absB[0] && cb.absoluteTransform[1][2] === absB[1]);
  check("fitSection: container shifted to make room, children padded from its edge", sec.x === 980 && sec.y === 990 && ca.x === 40 && ca.y === 40, [sec.x, sec.y, ca.x, ca.y]);
  const fitCommitted = cps.commit();
  check("fitSection: section and children snapshotted", [sec.id, ca.id, cb.id].every(id => fitCommitted.modified.includes(id)), fitCommitted);
  api.fitSection(sec, { padding: 40 });
  check("fitSection: idempotent", sec.x === 980 && sec.width === 410 && ca.x === 40);
  const fr = makeNode("FRAME", "Fr", { x: 0, y: 0, width: 999, height: 999 });
  fr.appendChild(makeNode("RECTANGLE", "in", { x: 300, y: 300, width: 10, height: 10 }));
  page.appendChild(fr);
  api.fitSection(fr);
  check("fitSection: FRAME, default padding 100, shrinks too", fr.width === 210 && fr.height === 210 && fr.x === 200 && fr.children[0].x === 100, [fr.x, fr.width, fr.children[0].x]);
  threw = ""; try { api.fitSection(makeNode("RECTANGLE", "R")); } catch (e) { threw = e.message; }
  check("fitSection: rejects non-containers", /expected SECTION or FRAME/.test(threw), threw);
}

console.log("\n== unknown bridge helper (Proxy) ==");
{
  const api = createBridgeApi();
  threw = "";
  try { api.summarise("1:1"); } catch (e) { threw = e.message; }
  check("proxy: unknown helper throws at the call, listing real ones", /^bridge\.summarise does not exist\. Available: /.test(threw) && /setProps/.test(threw) && /summarize/.test(threw), threw);
  check("proxy: existing fields still work", typeof api.state === "object" && typeof api.store.get === "function" && typeof api.define === "function" && typeof api.require === "function" && typeof api.context === "function");
  check("proxy: promise/serializer probes stay undefined", api.then === undefined && api.toJSON === undefined && api.asymmetricMatch === undefined && api.nodeType === undefined && api.$$typeof === undefined && api.prototype === undefined && api[Symbol.iterator] === undefined);
  let resolved = null;
  const awaited = Promise.resolve(api).then(v => { resolved = v; });
  inspectDone = inspectDone.then(() => awaited).then(() => {
    check("proxy: awaiting the bridge does not hang or call the trap", resolved === api);
  });
  let serialised = "";
  try { serialised = JSON.stringify(api); } catch (e) { serialised = "ERR " + e.message; }
  check("proxy: JSON.stringify is safe", !/^ERR/.test(serialised), serialised);
  api.define("usesUnknown", "module.exports = { go: () => bridge.zzz() };");
  threw = "";
  try { createBridgeApi().require("usesUnknown").go(); } catch (e) { threw = e.message; }
  check("proxy: code modules receive the guarded bridge", /bridge\.zzz does not exist/.test(threw), threw);
  api.remove("usesUnknown");

  const i2 = api.info();
  check("info: macros documented", ["setProps", "setText", "replaceWithInstance", "shift", "moveInto", "fitSection"].every(n => Object.keys(i2.macros).some(k => k.indexOf("bridge." + n) >= 0)), Object.keys(i2.macros));
  check("info: cheapReads mention context / find text / map view",
    Object.keys(i2.cheapReads).some(k => /bridge\.context/.test(k)) && Object.keys(i2.cheapReads).some(k => /text/.test(k) && /bridge\.find/.test(k)) && Object.keys(i2.cheapReads).some(k => /view/.test(k)), Object.keys(i2.cheapReads));
  check("info: store documents the conventions key", /conventions/.test(i2.persistence["bridge.store"]));
}

console.log("\n== error line numbers (stack parsing) ==");
{
  const v8Probe = 'Error: probe\n    at eval (eval at getAnonCalibration (C:\\Users\\x\\code.js:2100:20), <anonymous>:3:7)\n    at getAnonCalibration (C:\\Users\\x\\code.js:2101:5)';
  const v8Cal = calibrateFromProbeStack(v8Probe);
  check("V8 probe: file token <anonymous>, 2 wrapper lines", v8Cal && v8Cal.file === "<anonymous>" && v8Cal.offset === 2, v8Cal);
  const code = 'const a = 1;\nconst b = 2;\n  bridge.setProps(x, {});   \nreturn a;';
  const v8User = 'Error: boom\n    at Object.setProps (C:\\Users\\x\\code.js:812:9)\n    at eval (eval at <anonymous> (C:\\Users\\x\\code.js:1810:20), <anonymous>:5:11)\n    at async handler (C:\\Users\\x\\code.js:1815:22)';
  const loc = locateErrorInCode(v8User, code, v8Cal);
  check("V8 user error: first anonymous frame, line minus offset, trimmed source line", loc && loc.line === 3 && loc.column === 11 && loc.at === "bridge.setProps(x, {});", loc);
  const frames = parseStackFrames(v8User);
  check("V8: Windows path with drive colon parsed", frames[0].file === "C:\\Users\\x\\code.js" && frames[0].line === 812 && frames[0].column === 9, frames[0]);

  for (const [label, probe, user, expLine, expCol] of [
    ["QuickJS line only", "Error: probe\n    at <anonymous> (<eval>:3)\n    at fn (code.js:77)", "Error: boom\n    at <anonymous> (<eval>:4)\n    at fn (code.js:77)", 2, null],
    ["QuickJS line:col", "Error: probe\n    at <anonymous> (<input>:3:7)\n    at run (code.js:9:1)", "Error: boom\n    at helper (code.js:500:3)\n    at <anonymous> (<input>:5:9)", 3, 9]
  ]) {
    const cal = calibrateFromProbeStack(probe);
    const l = locateErrorInCode(user, code, cal);
    check(label + ": offset " + (cal && cal.offset) + " -> line " + expLine, cal && cal.offset === 2 && l && l.line === expLine && l.column === expCol && l.at.length > 0, [cal, l]);
  }
  check("no usable stack -> null, never throws", calibrateFromProbeStack("") === null && calibrateFromProbeStack(undefined) === null && locateErrorInCode("Error: x", code, v8Cal) === null && locateErrorInCode(v8User, code, null) === null);
  check("frame outside the code's line range is ignored", locateErrorInCode("Error: x\n    at eval (<anonymous>:900:1)", code, v8Cal) === null);
  check("long source line is cut to 160 chars", locateErrorInCode("Error: x\n    at eval (<anonymous>:3:1)", "x".repeat(400), { file: "<anonymous>", offset: 2 }).at.length === 160);

  const real = (async () => {
    const cal = await getAnonCalibration(AsyncFunction);
    check("real engine: calibration measured from a probe", cal && typeof cal.file === "string" && cal.offset >= 1, cal);
    check("real engine: calibration cached", (await getAnonCalibration(AsyncFunction)) === cal);
    const userCode = 'const a = 1;\n\n  await Promise.resolve();\n  throw new Error("user boom");';
    let e1 = null;
    try { await new AsyncFunction(...EXECUTE_PARAM_NAMES, userCode)(); } catch (e) { e1 = e; }
    const l1 = locateErrorInCode(e1 && e1.stack, userCode, cal);
    check("real engine: throw after await maps to the right line", l1 && l1.line === 4 && l1.at === 'throw new Error("user boom");', l1);
    const helperCode = 'const a = 1;\n\nbridge.setProps(null, {});';
    const api = createBridgeApi();
    let e2 = null;
    const args = EXECUTE_PARAM_NAMES.map(n => (n === "bridge" ? api : undefined));
    try { await new AsyncFunction(...EXECUTE_PARAM_NAMES, helperCode)(...args); } catch (e) { e2 = e; }
    const l2 = locateErrorInCode(e2 && e2.stack, helperCode, cal);
    check("real engine: error thrown inside a plugin helper still points at the agent's call", l2 && l2.line === 3 && /setProps/.test(l2.at), [e2 && e2.stack.split("\n").slice(0, 4), l2]);
  })();
  inspectDone = inspectDone.then(() => real);
}

console.log("\n== sanitizeForTransfer ==");
{
  const n = makeNode("FRAME", "Card");
  const cyc = { name: "loop", list: [1] }; cyc.self = cyc; cyc.list.push(cyc);
  const shared = { v: 1 };
  const deep = {}; let cur = deep; for (let i = 0; i < 20; i++) { cur.next = {}; cur = cur.next; }
  const out = sanitizeForTransfer({
    mixed: figma.mixed, node: n, nodes: [n, figma.mixed], fn() {}, arrow: () => 1, bytes: new Uint8Array(5), cyc, a: shared, b: shared,
    num: 1.5, str: "s", bool: false, nul: null, undef: undefined, deep, big: 10n, err: new Error("bad"), map: new Map([["k", 1]])
  });
  check("sanitize: symbol -> \"mixed\"", out.mixed === "mixed" && out.nodes[1] === "mixed");
  check("sanitize: figma node -> { id, name, type }", JSON.stringify(out.node) === JSON.stringify({ id: n.id, name: "Card", type: "FRAME" }) && out.nodes[0].id === n.id, out.node);
  check("sanitize: functions omitted", !("fn" in out) && !("arrow" in out));
  check("sanitize: Uint8Array -> \"[bytes N]\"", out.bytes === "[bytes 5]", out.bytes);
  check("sanitize: cycles -> \"[circular]\", shared (non-cyclic) refs are fine", out.cyc.self === "[circular]" && out.cyc.list[1] === "[circular]" && out.a.v === 1 && out.b.v === 1, out.cyc);
  check("sanitize: primitives untouched", out.num === 1.5 && out.str === "s" && out.bool === false && out.nul === null && out.undef === undefined);
  let d = out.deep, depth = 0; while (d && typeof d === "object") { d = d.next; depth++; }
  check("sanitize: depth > 12 -> \"[deep]\"", d === "[deep]" && depth <= 13, [depth, d]);
  check("sanitize: bigint / Error / Map become plain values", out.big === "10" && out.err === "Error: bad" && out.map.k === 1);
  let cloned = null, cloneErr = "";
  try { cloned = structuredClone(out); } catch (e) { cloneErr = e.message; }
  check("sanitize: result survives structuredClone (what postMessage does)", cloned !== null && !cloneErr, cloneErr);
  let rawErr = "";
  try { structuredClone({ m: figma.mixed }); } catch (e) { rawErr = e.message; }
  check("sanitize: the unsanitized input would NOT (the original bug)", rawErr !== "", rawErr);
  check("sanitize: top-level symbol / undefined", sanitizeForTransfer(figma.mixed) === "mixed" && sanitizeForTransfer(undefined) === undefined);
}

console.log("\n== screenshots: common-ancestor area rule ==");
{
  const consts = (src.match(/^const (?:CAPTURE_\w+|DEFAULT_CAPTURE_MAX_PX) = .*;$/gm) || []).join("\n");
  const grab = (name) => {
    const m = new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?\\n}\\n", "m").exec(src);
    if (!m) throw new Error("function " + name + " not found in code.js");
    return m[0];
  };
  const shots = [];
  const captureSafe = async (node, scale, maxPx) => { shots.push({ name: node.name, maxPx }); return { base64: "IMG:" + node.name, error: null }; };
  const exportCaptureTargets = new Function("captureSafe",
    consts + "\n" + grab("ancestorChain") + "\n" + grab("findCommonAncestor") + "\n" + grab("nodeArea") + "\n" + grab("exportCaptureTargets") + "\nreturn exportCaptureTargets;")(captureSafe);
  const shootable = (name, w, h) => makeNode("FRAME", name, { width: w, height: h, exportAsync: async () => new Uint8Array(1) });

  const done = (async () => {
    let frame = shootable("Tight", 300, 100);
    const c1 = shootable("C1", 100, 100), c2 = shootable("C2", 100, 100);
    frame.appendChild(c1); frame.appendChild(c2);
    shots.length = 0;
    let res = await exportCaptureTargets([c1, c2], 1, 1024);
    check("capture: ancestor area <= 3x targets -> one image of the ancestor", res.images.length === 1 && res.framed === "common-ancestor" && shots.length === 1 && shots[0].name === "Tight", [res, shots]);

    frame = shootable("Huge", 5000, 5000);
    const d1 = shootable("D1", 100, 100), d2 = shootable("D2", 100, 100);
    frame.appendChild(d1); frame.appendChild(d2);
    shots.length = 0;
    res = await exportCaptureTargets([d1, d2], 1, 1024);
    check("capture: ancestor far larger -> separate images", res.images.length === 2 && !res.framed && shots.map(s => s.name).join() === "D1,D2", shots);
    check("capture: each gets maxPx / sqrt(n)", shots.every(s => s.maxPx === Math.round(1024 / Math.SQRT2)), shots);

    const edge = shootable("Edge", 600, 100);
    const e1 = shootable("E1", 100, 100), e2 = shootable("E2", 100, 100);
    edge.appendChild(e1); edge.appendChild(e2);
    shots.length = 0;
    res = await exportCaptureTargets([e1, e2], 1, 1024);
    check("capture: exactly 3x is still allowed", res.framed === "common-ancestor" && shots[0].name === "Edge");
    edge.resize(601, 100);
    shots.length = 0;
    res = await exportCaptureTargets([e1, e2], 1, 1024);
    check("capture: just over 3x is not", !res.framed && shots.length === 2);

    const page = makeNode("PAGE", "P");
    const many = [1, 2, 3, 4, 5, 6].map(i => { const n = shootable("N" + i, 100, 100); page.appendChild(n); return n; });
    shots.length = 0;
    res = await exportCaptureTargets(many, 1, 1024);
    check("capture: at most 4 individual images, note says so", res.images.length === 4 && shots.length === 4 && /4 of 6/.test(res.note), [res.images.length, res.note]);
    check("capture: 4 nodes -> maxPx 512 each", shots.every(s => s.maxPx === 512), shots);
    shots.length = 0;
    await exportCaptureTargets(many.slice(0, 4), 1, 600);
    check("capture: per-image budget never below 384", shots.every(s => s.maxPx === 384), shots);
    shots.length = 0;
    await exportCaptureTargets(many.slice(0, 2), 1, undefined);
    check("capture: missing max_px falls back to 1024 default", shots.every(s => s.maxPx === 724), shots);
    shots.length = 0;
    await exportCaptureTargets(many.slice(0, 3), 1, 2000);
    check("capture: explicit larger max_px is honoured and divided", shots.every(s => s.maxPx === Math.round(2000 / Math.sqrt(3))), shots);
    shots.length = 0;
    res = await exportCaptureTargets([many[0]], 1, 900);
    check("capture: single node unchanged", shots.length === 1 && shots[0].maxPx === 900);
  })();
  inspectDone = inspectDone.then(() => done);
}

inspectDone.then(() => {
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
  process.exit(failures ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
