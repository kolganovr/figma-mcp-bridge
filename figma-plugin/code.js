figma.showUI(__html__, { width: 360, height: 390, themeColors: true });

let autoZoomEnabled = true;
let smartPlacementEnabled = true;

// Toast batching: a burst of calls (bulk generation, a multi-step flow) used to
// fire one figma.notify() per call — at 20+ calls that buries the canvas in
// toasts. The first few in any 4s window still get their own toast (so a
// single action still feels immediate); anything after that relies on the
// HUD log stream instead, which already receives every RESULT regardless.
const recentActionTimestamps = [];
function allowCanvasToast() {
  const now = Date.now();
  while (recentActionTimestamps.length && now - recentActionTimestamps[0] > 4000) recentActionTimestamps.shift();
  recentActionTimestamps.push(now);
  return recentActionTimestamps.length <= 3;
}

// Pure JS Base64 encoder for Figma sandbox (QuickJS / V8 safe without btoa)
function bytesToBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  const l = bytes.length;
  while (i < l) {
    const a = bytes[i++];
    const b = i < l ? bytes[i++] : NaN;
    const c = i < l ? bytes[i++] : NaN;
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (isNaN(b) ? 0 : (b >> 4))];
    result += isNaN(b) ? '=' : chars[((b & 15) << 2) | (isNaN(c) ? 0 : (c >> 6))];
    result += isNaN(c) ? '=' : chars[c & 63];
  }
  return result;
}

// Auto-load fonts safely with fallback chain
async function ensureFont(family = "Inter", style = "Regular") {
  try {
    await figma.loadFontAsync({ family, style });
  } catch (e) {
    try {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    } catch (e2) {
      try {
        await figma.loadFontAsync({ family: "Roboto", style: "Regular" });
      } catch (e3) {}
    }
  }
}

// ==========================================================================
// Bridge Runtime — persistent state, code modules, actionable error hints
// --------------------------------------------------------------------------
// WHY THIS EXISTS
// Every figma_execute_code call is compiled into a FRESH AsyncFunction, so
// top-level const/let/var/function declarations die with the call. And `eval`
// inside the Figma plugin sandbox is a BOUND function, which by spec makes
// every eval() an INDIRECT eval: it cannot see the caller's locals and its
// declarations never reach the caller or globalThis. So the classic "stash
// source in pluginData, eval it next call" trick silently produces nothing.
// `new Function(...)` bodies, in contrast, are ordinary function scopes where
// declarations behave normally, and they share the same globalThis. The module
// loader below is built on that.
// ==========================================================================

const BRIDGE_STATE = {};          // survives calls, cleared on plugin reload
const BRIDGE_MODULES = {};        // name -> compiled exports (in-memory cache)
const BRIDGE_KEY = "abridge:";    // pluginData namespace on figma.root
const BRIDGE_CHUNK = 60000;       // BYTES per entry; pluginData caps around 100KB

// Figma measures the pluginData limit in BYTES, but chunking used to slice by
// JS string length. A module or store value written in Cyrillic is ~2 bytes per
// character, so a "60000-char" chunk was really 120KB and setPluginData threw.
// These helpers split on the real UTF-8 budget, never inside a surrogate pair.
function utf8CharBytes(code) {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

function chunkByUtf8Bytes(str, maxBytes) {
  const parts = [];
  let start = 0;
  let bytes = 0;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let size = utf8CharBytes(code);
    let isPair = false;

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size = 4;      // one astral code point encoded from two JS chars
        isPair = true;
      }
    }

    // Cut BEFORE the current character so a pair is never torn apart.
    if (bytes + size > maxBytes && i > start) {
      parts.push(str.slice(start, i));
      start = i;
      bytes = 0;
    }

    bytes += size;
    if (isPair) i++;
  }

  parts.push(str.slice(start));
  return parts;
}

function bridgeWrite(key, value) {
  const str = String(value == null ? "" : value);
  const full = BRIDGE_KEY + key;
  // wipe any previous chunk tail before rewriting
  const prev = parseInt(figma.root.getPluginData(full + ":n") || "0", 10);
  for (let i = 0; i < prev; i++) figma.root.setPluginData(full + ":" + i, "");

  const parts = chunkByUtf8Bytes(str, BRIDGE_CHUNK);

  if (parts.length <= 1) {
    figma.root.setPluginData(full, str);
    figma.root.setPluginData(full + ":n", "");
    return str.length;
  }

  parts.forEach((p, i) => figma.root.setPluginData(full + ":" + i, p));
  figma.root.setPluginData(full, "");
  figma.root.setPluginData(full + ":n", String(parts.length));
  return str.length;
}

function bridgeRead(key) {
  const full = BRIDGE_KEY + key;
  const n = parseInt(figma.root.getPluginData(full + ":n") || "0", 10);
  if (!n) return figma.root.getPluginData(full);
  let out = "";
  for (let i = 0; i < n; i++) out += figma.root.getPluginData(full + ":" + i);
  return out;
}

function bridgeIndex(kind) {
  try {
    const raw = bridgeRead("index:" + kind);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function bridgeIndexAdd(kind, name) {
  const list = bridgeIndex(kind);
  if (list.indexOf(name) === -1) {
    list.push(name);
    bridgeWrite("index:" + kind, JSON.stringify(list));
  }
}

function bridgeIndexRemove(kind, name) {
  bridgeWrite("index:" + kind, JSON.stringify(bridgeIndex(kind).filter(n => n !== name)));
}

function bridgeCompile(name, source, bridgeApi) {
  // Ordinary function scope: `function foo(){}` and `const x = 1` inside
  // `source` are real declarations here, unlike anything declared via eval().
  let factory;
  try {
    factory = new Function(
      "exports", "module", "figma", "ensureFont", "bridge",
      source + "\n;return module.exports;"
    );
  } catch (err) {
    throw new Error(
      "Module \"" + name + "\" failed to compile: " + err.message +
      ". The module body is a SYNCHRONOUS function body — top-level await is not allowed; " +
      "export an async function instead."
    );
  }
  const mod = { exports: {} };
  const exported = factory(mod.exports, mod, figma, ensureFont, bridgeApi);
  const empty = !exported ||
    (typeof exported !== "function" &&
     (typeof exported !== "object" || Object.keys(exported).length === 0));
  if (empty) {
    throw new Error(
      "Module \"" + name + "\" exported nothing. End the module source with " +
      "module.exports = { ... } listing the helpers you want back."
    );
  }
  BRIDGE_MODULES[name] = exported;
  return exported;
}

// --- Checkpoint Journal state ----------------------------------------------
const CHECKPOINTS = [];   // in-memory only — cleared on plugin reload, see api.info().checkpoints
const CHECKPOINTS_MAX = 50; // bound memory on a long-running session
let activeCheckpoint = null;
let checkpointSeq = 0;

function beginCheckpoint(label) {
  checkpointSeq += 1;
  const cp = {
    id: "cp_" + Date.now().toString(36) + "_" + checkpointSeq,
    label: label || "Unlabeled action",
    createdAt: Date.now(),
    created: [],     // node ids, in creation order
    modified: [],    // [{ id, ...snapshotted props }]
    committed: false,
    rolledBack: false
  };
  CHECKPOINTS.push(cp);
  if (CHECKPOINTS.length > CHECKPOINTS_MAX) CHECKPOINTS.shift();
  activeCheckpoint = cp;
  return {
    id: cp.id,
    commit() {
      cp.committed = true;
      if (activeCheckpoint === cp) activeCheckpoint = null;
      return { checkpoint_id: cp.id, created: cp.created.slice(), modified: cp.modified.map(m => m.id) };
    }
  };
}

function snapshotNodeProps(node) {
  const snap = { id: node.id };
  try {
    if ("x" in node) snap.x = node.x;
    if ("y" in node) snap.y = node.y;
    if ("width" in node && "height" in node && typeof node.resize === "function") {
      snap.width = node.width;
      snap.height = node.height;
    }
    if ("fills" in node && node.fills !== figma.mixed) snap.fills = JSON.parse(JSON.stringify(node.fills));
    if (node.type === "TEXT" && "characters" in node) snap.characters = node.characters;
    if ("opacity" in node) snap.opacity = node.opacity;
    if ("visible" in node) snap.visible = node.visible;
    if ("cornerRadius" in node && node.cornerRadius !== figma.mixed) snap.cornerRadius = node.cornerRadius;
  } catch (e) {
    // A property that refuses to read (mixed values, locked nodes) just means
    // less gets restored for that node — never fails the checkpoint itself.
  }
  return snap;
}

// For the plugin's OWN write handlers (insert_component_instance, insert_svg —
// they build nodes directly rather than through the tracked sandbox Proxy) to
// register what they made with whatever checkpoint the caller opened around them.
function recordCreated(node) {
  if (activeCheckpoint && node && node.id) activeCheckpoint.created.push(node.id);
  return node;
}

function trackModification(node) {
  if (!activeCheckpoint || !node || !node.id) return node;
  if (activeCheckpoint.modified.some(m => m.id === node.id)) return node; // first snapshot wins per checkpoint
  activeCheckpoint.modified.push(snapshotNodeProps(node));
  return node;
}

function restoreNodeProps(node, snap) {
  try {
    if ("width" in snap && "height" in snap && typeof node.resize === "function") node.resize(snap.width, snap.height);
    if ("x" in snap) node.x = snap.x;
    if ("y" in snap) node.y = snap.y;
    if ("fills" in snap) node.fills = snap.fills;
    if ("characters" in snap && node.type === "TEXT") node.characters = snap.characters; // best-effort: font may need reloading
    if ("opacity" in snap) node.opacity = snap.opacity;
    if ("visible" in snap) node.visible = snap.visible;
    if ("cornerRadius" in snap) node.cornerRadius = snap.cornerRadius;
  } catch (e) {
    // Best-effort restore — a single unrestorable property must not abort the rest of the rollback.
  }
}

function rollbackCheckpoint(id) {
  const cp = id === "last"
    ? CHECKPOINTS.slice().reverse().find(c => c.committed && !c.rolledBack)
    : CHECKPOINTS.find(c => c.id === id);

  if (!cp) {
    throw new Error(
      `No rollback-eligible checkpoint found for "${id}". Use bridge.checkpoints() to list committed checkpoints.`
    );
  }
  if (cp.rolledBack) {
    throw new Error(`Checkpoint "${cp.id}" ("${cp.label}") was already rolled back.`);
  }

  const removed = [];
  const restored = [];
  const missing = [];

  // Undo creations. Order doesn't matter for correctness — node.remove() takes
  // its whole subtree with it, so removing a still-present descendant after its
  // ancestor was already removed is simply a no-op via the getNodeById miss.
  for (let i = cp.created.length - 1; i >= 0; i--) {
    const node = figma.getNodeById(cp.created[i]);
    if (node && typeof node.remove === "function") {
      try { node.remove(); removed.push(cp.created[i]); } catch (e) { missing.push(cp.created[i]); }
    }
  }

  for (const snap of cp.modified) {
    const node = figma.getNodeById(snap.id);
    if (node) { restoreNodeProps(node, snap); restored.push(snap.id); }
    else missing.push(snap.id);
  }

  cp.rolledBack = true;
  return { checkpoint_id: cp.id, label: cp.label, removed, restored, missing };
}

// Node-creating methods worth auto-tracking. Kept to an explicit allowlist
// rather than "every function on figma" so this Proxy changes behaviour for
// nothing except "a checkpoint is open and you made a new node."
const TRACKED_CREATORS = new Set([
  "createFrame", "createRectangle", "createEllipse", "createPolygon", "createStar",
  "createVector", "createText", "createLine", "createComponent", "createComponentFromNode",
  "createNodeFromSvg", "createBooleanOperation", "createSlice", "createConnector",
  "createSticky", "createShapeWithText", "createPage"
]);

// Wraps the real `figma` object so create*() calls made during an open
// checkpoint are recorded, while every other property (currentPage, root,
// viewport, ...) passes straight through untouched. `Reflect.get(target, prop,
// target)` forces every getter to run with `this === figma` — the real
// singleton, never the proxy — so this cannot desync anything figma's own
// getters rely on internally. If Proxy construction ever fails on some host
// object quirk, execution falls back to the raw `figma` and simply loses
// auto-tracking for that call rather than failing outright.
function createTrackingFigma() {
  try {
    return new Proxy(figma, {
      get(target, prop, _receiver) {
        const val = Reflect.get(target, prop, target);
        if (typeof val !== "function" || !TRACKED_CREATORS.has(prop)) return val;
        return function (...args) {
          const result = val.apply(target, args);
          if (activeCheckpoint && result && typeof result === "object" && typeof result.id === "string") {
            activeCheckpoint.created.push(result.id);
          }
          return result;
        };
      },
      set(target, prop, value) { target[prop] = value; return true; }
    });
  } catch (e) {
    return figma;
  }
}

function createBridgeApi() {
  const api = {};

  // --- ephemeral scratch: survives calls, dies on plugin reload ------------
  api.state = BRIDGE_STATE;

  // --- durable key/value stored inside the .fig document -------------------
  api.store = {
    set(key, value) {
      bridgeWrite("kv:" + key, JSON.stringify(value === undefined ? null : value));
      bridgeIndexAdd("kv", key);
      return value;
    },
    get(key, fallback) {
      const raw = bridgeRead("kv:" + key);
      if (!raw) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    },
    remove(key) {
      bridgeWrite("kv:" + key, "");
      bridgeIndexRemove("kv", key);
    },
    keys() { return bridgeIndex("kv"); }
  };

  // --- reusable code modules ----------------------------------------------
  api.define = function (name, source) {
    const exported = bridgeCompile(name, source, api);   // fail fast before saving
    bridgeWrite("mod:" + name, source);
    bridgeIndexAdd("mod", name);
    return exported;
  };

  api.require = function (name) {
    if (BRIDGE_MODULES[name]) return BRIDGE_MODULES[name];
    const source = bridgeRead("mod:" + name);
    if (!source) {
      throw new Error(
        "Module \"" + name + "\" is not defined. Available: [" + api.list().join(", ") + "]. " +
        "Create it with bridge.define(\"" + name + "\", \"...source ending in module.exports = {...}...\")."
      );
    }
    return bridgeCompile(name, source, api);
  };

  api.list = function () {
    const saved = bridgeIndex("mod");
    Object.keys(BRIDGE_MODULES).forEach(n => { if (saved.indexOf(n) === -1) saved.push(n); });
    return saved;
  };

  api.source = function (name) { return bridgeRead("mod:" + name); };

  api.remove = function (name) {
    delete BRIDGE_MODULES[name];
    bridgeWrite("mod:" + name, "");
    bridgeIndexRemove("mod", name);
  };

  // --- platform workarounds ------------------------------------------------
  // figma.createComponentFromNode() can force every AutoLayout frame in the
  // subtree to FIXED sizing at whatever size it happened to have mid-convert.
  // Node ids change during conversion, so positions in the tree map them back.
  api.componentize = function (node) {
    const saved = [];
    (function walk(n, path) {
      if ("layoutMode" in n && n.layoutMode !== "NONE") {
        saved.push({ path: path.slice(), p: n.primaryAxisSizingMode, c: n.counterAxisSizingMode });
      }
      if ("children" in n) n.children.forEach((ch, i) => walk(ch, path.concat(i)));
    })(node, []);

    const comp = figma.createComponentFromNode(node);

    for (const s of saved) {
      let n = comp;
      for (let i = 0; i < s.path.length && n; i++) n = n.children ? n.children[s.path[i]] : null;
      if (!n || !("layoutMode" in n)) continue;
      if (s.p) n.primaryAxisSizingMode = s.p;
      if (s.c) n.counterAxisSizingMode = s.c;
    }
    if ("resize" in comp) comp.resize(comp.width, comp.height); // force relayout
    return comp;
  };

  // Figma forbids overriding relative-transform inside an INSTANCE. Fail with
  // the actual remedy instead of the raw platform error.
  api.setPosition = function (node, x, y) {
    let p = node.parent;
    while (p) {
      if (p.type === "INSTANCE") {
        throw new Error(
          "Cannot set x/y on \"" + node.name + "\": it lives inside INSTANCE \"" + p.name +
          "\" and relative-transform cannot be overridden there. Position it through layout instead — " +
          "itemSpacing / primaryAxisAlignItems / counterAxisAlignItems on the parent AutoLayout, or " +
          "layoutPositioning = \"ABSOLUTE\" plus constraints set on the MASTER COMPONENT, not the instance."
        );
      }
      p = p.parent;
    }
    node.x = x; node.y = y;
    return node;
  };

  // --- self-description, so an agent can ask instead of guessing -----------
  api.info = function () {
    return {
      executionModel:
        "Each figma_execute_code call runs as a fresh async function body. Top-level " +
        "const/let/var/function declarations do NOT survive into the next call. " +
        "Top-level await and return are supported; import/export are not.",
      evalWarning:
        "eval() is a bound function in the Figma sandbox, so every eval is an INDIRECT eval: " +
        "it cannot read the caller's locals and its declarations vanish. Never build helpers " +
        "with eval — use bridge.define / bridge.require.",
      persistence: {
        "bridge.state": "in-memory object, survives calls, cleared on plugin reload",
        "bridge.store": "JSON key/value inside the .fig document, survives everything",
        "bridge.define/require": "reusable code modules stored in the document",
        "globalThis": "shared and persists between calls, but prefer bridge.state"
      },
      checkpoints:
        "bridge.checkpoint(label) opens a rollback journal; every figma.create*() call made " +
        "while it is open is recorded automatically. bridge.snapshot(node) records an existing " +
        "node's common properties (x, y, size, fills, characters, opacity, visible) before you " +
        "mutate it. cp.commit() closes it; bridge.rollback(id | \"last\") undoes creations and " +
        "restores snapshotted properties. Deletions are never recoverable. The journal lives in " +
        "memory only — it is cleared when the plugin reloads.",
      injected: ["figma", "ensureFont", "bridge", "getFreePosition", "notify", "log", "progress"],
      modules: api.list(),
      storeKeys: api.store.keys(),
      checkpointCount: CHECKPOINTS.length,
      editorType: figma.editorType,
      pluginApiVersion: typeof figma.apiVersion !== "undefined" ? figma.apiVersion : "n/a"
    };
  };

  // ==========================================================================
  // Checkpoint Journal — best-effort undo for what an agent just did.
  // --------------------------------------------------------------------------
  // The Plugin API has no programmatic undo, so this journal tracks it by
  // construction instead of trying to snapshot the whole document (which would
  // be both slow and huge on a real file):
  //   - CREATED nodes are caught automatically: while a checkpoint is open, the
  //     `figma` reference handed to the sandbox is a thin Proxy that records the
  //     id of anything returned by figma.create*() / createNodeFromSvg() /
  //     createComponentFromNode(). Rollback removes them.
  //   - MODIFIED nodes are only tracked when something explicitly calls
  //     bridge.snapshot(node) before mutating it (the bridge's own tool handlers
  //     — insert_component_instance, insert_svg, set_variables_mode — do this on
  //     the nodes they touch). Rollback restores the snapshotted properties.
  //   - REMOVED nodes are never recoverable and are not tracked; there is
  //     nothing to roll back to.
  // This covers "the agent generated junk and I want it gone" and "the agent
  // reskinned an existing node and broke it" — the two cases that actually come
  // up — without pretending to be a full undo stack.
  // ==========================================================================
  api.checkpoint = function (label) {
    return beginCheckpoint(label);
  };

  api.rollback = function (id) {
    return rollbackCheckpoint(id);
  };

  api.checkpoints = function () {
    return CHECKPOINTS.map(cp => ({
      id: cp.id,
      label: cp.label,
      createdAt: cp.createdAt,
      created: cp.created.length,
      modified: cp.modified.length,
      committed: cp.committed,
      rolledBack: !!cp.rolledBack
    }));
  };

  api.snapshot = function (node) {
    return trackModification(node);
  };

  return api;
}

// Rewrites raw sandbox/platform errors into messages that tell an agent what
// to do differently.
const BRIDGE_ERROR_HINTS = [
  {
    test: /cannot be overridden in an instance|relative-transform/i,
    code: "INSTANCE_TRANSFORM_LOCKED",
    hint: "Children of an INSTANCE cannot have x/y (and other override-forbidden props) set directly. " +
          "Position via AutoLayout on the parent (itemSpacing, primaryAxisAlignItems, counterAxisAlignItems), " +
          "or edit the master COMPONENT instead of the instance. bridge.setPosition(node, x, y) checks this for you."
  },
  {
    test: /unloaded font|font.*(not loaded|must be loaded)|loadFontAsync/i,
    code: "FONT_NOT_LOADED",
    hint: "Load the font first: await ensureFont(family, style) before touching characters / fontName / fontSize."
  },
  {
    test: /over the .* MB limit|too large after encoding/i,
    code: "CAPTURE_TOO_LARGE",
    hint: "Pass capture_node_ids for a specific node instead of capturing everything, or lower \"scale\"."
  },
  {
    test: /await is only valid|Unexpected token|Unexpected identifier|Invalid or unexpected|Unexpected end of input/i,
    code: "SCRIPT_SYNTAX_ERROR",
    hint: "Your code is compiled as an async function body: top-level await and return are allowed, " +
          "import/export are not. Check for unbalanced braces or quotes in the code string."
  },
  {
    test: /removed node|does not exist|has been removed/i,
    code: "STALE_NODE_ID",
    hint: "The node was deleted or replaced — createComponentFromNode, flatten and boolean ops return NEW nodes " +
          "with new ids. Keep the returned reference or re-fetch with figma.getNodeById."
  },
  {
    test: /in set_(width|height)|Cannot resize|fixed dimensions/i,
    code: "AUTOLAYOUT_HUG_RESIZE",
    hint: "AutoLayout frames ignore resize on axes set to AUTO (hug). Set primaryAxisSizingMode / " +
          "counterAxisSizingMode to \"FIXED\" before resizing, or resize the child that drives the layout."
  },
  {
    test: /pluginData|exceeds|too large/i,
    code: "PLUGINDATA_LIMIT",
    hint: "pluginData entries are capped around 100KB. bridge.store and bridge.define chunk automatically — " +
          "use them instead of raw figma.root.setPluginData for large payloads."
  },
  {
    test: /is not defined|is not a function|Cannot read propert/i,
    code: "SCOPE_LOST",
    hint: "Every call runs in a fresh scope, so helpers from a previous figma_execute_code call are gone, and " +
          "anything declared through eval() never existed at all. Persist reusable code with " +
          "bridge.define(\"kit\", \"...; module.exports = { helper }\") and reload it via bridge.require(\"kit\")."
  }
];

function enrichBridgeError(err) {
  const message = (err && err.message) ? err.message : String(err);
  for (const rule of BRIDGE_ERROR_HINTS) {
    if (rule.test.test(message)) return { message, hint: rule.hint, code: rule.code };
  }
  return { message, hint: null, code: null };
}

// Ceiling on what a single capture may render. A whole page at 1.5x on a real
// design file is tens of megapixels; base64-encoding that in the sandbox and
// pushing it into the model's context either timed out or flooded the window.
const MAX_CAPTURE_PIXELS = 4_000_000;   // ~2000x2000
const MAX_CAPTURE_BASE64 = 8 * 1024 * 1024;

async function exportNodeToPngBase64(node, scale = 1.5) {
  if (!node) return null;

  let effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : 1.5;

  // Shrink instead of refusing: a smaller screenshot is still a useful one.
  const w = typeof node.width === 'number' ? node.width : 0;
  const h = typeof node.height === 'number' ? node.height : 0;
  if (w > 0 && h > 0) {
    const pixels = w * h * effectiveScale * effectiveScale;
    if (pixels > MAX_CAPTURE_PIXELS) {
      effectiveScale = Math.max(0.1, Math.sqrt(MAX_CAPTURE_PIXELS / (w * h)));
    }
  }

  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: effectiveScale }
    });
    const b64 = bytesToBase64(bytes);
    if (b64.length > MAX_CAPTURE_BASE64) {
      throw new Error(
        `Screenshot is ${Math.round(b64.length / 1048576)} MB after encoding, over the ${MAX_CAPTURE_BASE64 / 1048576} MB limit. ` +
        `Select a specific frame (or pass node_ids) instead of capturing the whole page, or lower "scale".`
      );
    }
    return b64;
  } catch (err) {
    // Surfaced by the caller rather than swallowed — a silent null looked
    // identical to "nothing was selected".
    throw new Error(`Screenshot failed for "${node.name || node.type}": ${err.message || String(err)}`);
  }
}

// A failed capture must never fail the canvas edit that already succeeded.
async function captureSafe(node, scale) {
  try {
    return { base64: await exportNodeToPngBase64(node, scale), error: null };
  } catch (err) {
    return { base64: null, error: err.message || String(err) };
  }
}

// Loads every distinct font a text node uses, once.
// The previous version walked a mixed-font node character by character and
// awaited loadFontAsync for each one: a 4000-character paragraph meant 4000
// sequential round-trips and the whole tool call timed out.
async function loadFontsForTextNode(textNode) {
  const wanted = [];
  const seen = new Set();

  const remember = (font) => {
    if (!font || !font.family) return;
    const id = font.family + "|" + font.style;
    if (seen.has(id)) return;
    seen.add(id);
    wanted.push(font);
  };

  if (textNode.fontName === figma.mixed) {
    if (typeof textNode.getStyledTextSegments === 'function') {
      for (const segment of textNode.getStyledTextSegments(['fontName'])) {
        remember(segment.fontName);
      }
    } else {
      // Fallback for older plugin API builds. getRangeFontName is synchronous
      // and cheap — it was the per-character *await* that made this quadratic,
      // so collecting first and awaiting the deduped set is enough.
      const len = textNode.characters.length;
      for (let i = 0; i < len; i++) {
        const font = textNode.getRangeFontName(i, i + 1);
        if (font !== figma.mixed) remember(font);
      }
    }
  } else {
    remember(textNode.fontName);
  }

  for (const font of wanted) {
    await ensureFont(font.family, font.style);
  }
}

// Helper to safely apply text overrides to nested text layers inside an instance.
// Matching is deliberately narrow: the old rule also accepted
// `nodeName.includes(targetKey)` for EVERY node, so one {"Label": "..."} override
// rewrote every layer whose name merely contained "label".
async function applyTextOverrides(container, overrides) {
  if (!overrides || typeof overrides !== 'object') return [];
  const textNodes = container.findAll ? container.findAll(n => n.type === 'TEXT') : [];
  const applied = [];

  for (const [key, val] of Object.entries(overrides)) {
    const targetKey = key.trim().toLowerCase();

    const byName = textNodes.filter(n => (n.name || '').trim().toLowerCase() === targetKey);
    const byChars = textNodes.filter(n => (n.characters || '').trim().toLowerCase() === targetKey);
    const byPartialName = textNodes.filter(n => (n.name || '').trim().toLowerCase().includes(targetKey));

    // Exact name wins; exact current text next; a fuzzy name match is only a
    // last resort and only when it is UNambiguous.
    let target = byName[0] || byChars[0] || null;
    if (!target && byPartialName.length === 1) target = byPartialName[0];
    if (!target) continue;

    try {
      await loadFontsForTextNode(target);
      target.characters = String(val);
      applied.push(key);
    } catch (e) {
      // Leave this override unapplied; the caller reports what did land.
    }
  }

  return applied;
}

// Color parser for Hex, RGB, and named colors
function parseColor(colorStr) {
  if (!colorStr || typeof colorStr !== 'string') return null;
  const str = colorStr.trim().toLowerCase();
  
  if (str === 'white') return { r: 1, g: 1, b: 1 };
  if (str === 'black') return { r: 0, g: 0, b: 0 };
  if (str === 'transparent') return null;

  if (str.startsWith('#')) {
    let hex = str.slice(1);
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    // Validate before parsing: "#zzzzzz" used to yield {r: NaN, ...} and Figma
    // threw an opaque error several frames later instead of here.
    if (!/^[0-9a-f]{6}$/.test(hex.substring(0, 6)) || hex.length < 6) {
      throw new Error(`Invalid hex color "${colorStr}". Expected 3 or 6 hex digits, e.g. "#6366F1".`);
    }
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }

  const rgbMatch = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    const clamp = (n) => Math.max(0, Math.min(255, n)) / 255;
    return {
      r: clamp(parseInt(rgbMatch[1], 10)),
      g: clamp(parseInt(rgbMatch[2], 10)),
      b: clamp(parseInt(rgbMatch[3], 10))
    };
  }

  throw new Error(`Unrecognised color "${colorStr}". Use hex ("#6366F1"), rgb(r, g, b), "white", "black" or "transparent".`);
}

function applyScaleConstraints(node) {
  if ('constraints' in node) {
    node.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
  }
  if ('children' in node) {
    for (const child of node.children) {
      applyScaleConstraints(child);
    }
  }
}

function applyVectorColors(container, { fillColor, strokeColor, universalColor }) {
  const nodes = container.findAll ? container.findAll(n => 'fills' in n || 'strokes' in n) : [];
  const allNodes = [container, ...nodes];

  for (const n of allNodes) {
    const targetFill = universalColor || fillColor;
    if (targetFill && 'fills' in n && Array.isArray(n.fills) && n.fills.length > 0) {
      n.fills = [{ type: 'SOLID', color: targetFill }];
    }

    const targetStroke = universalColor || strokeColor;
    if (targetStroke && 'strokes' in n && Array.isArray(n.strokes) && n.strokes.length > 0) {
      n.strokes = [{ type: 'SOLID', color: targetStroke }];
    }
  }
}

// ==========================================================================
// Layout Packer — canvas placement engine
// --------------------------------------------------------------------------
// The previous version recomputed top-level bounds with a plain O(n) scan on
// EVERY candidate position (up to 200 attempts x n nodes) and did it AGAIN in
// autoPositionIfColliding for the same node a moment later. It also only ever
// stepped along one axis, so 20 generated screens turned into a mile-long
// ribbon instead of a page you could see at a reasonable zoom.
//
// This version computes bounds once per placement call, indexes existing
// top-level nodes into a 500px grid hash so a collision test is O(neighbours)
// instead of O(n), and adds a shelf-packing "grid" mode alongside the
// original single-axis "row" mode.
//
// Honest limit: "grid" mode packs new items into a virtual N-column grid and
// checks each candidate cell against real geometry — it does not attempt a
// general bin-packing solve around arbitrary pre-existing layouts. For the
// case it targets (an agent placing a run of similarly-sized generated
// screens) that is indistinguishable from optimal; for a page with wildly
// mixed existing content it degrades to "first free cell", never overlap.
// ==========================================================================
const COLLISION_CELL = 500;

function computeTopLevelBounds(excludeNode) {
  const nodes = figma.currentPage.children.filter(n =>
    n !== excludeNode && n.visible !== false && typeof n.x === 'number' && typeof n.width === 'number'
  );
  if (nodes.length === 0) return { nodes, minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y < minY) minY = n.y;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  return { nodes, minX, minY, maxX, maxY };
}

function buildCollisionGrid(nodes) {
  const grid = new Map();
  const key = (cx, cy) => cx + ':' + cy;
  for (const n of nodes) {
    const x0 = Math.floor(n.x / COLLISION_CELL), x1 = Math.floor((n.x + n.width) / COLLISION_CELL);
    const y0 = Math.floor(n.y / COLLISION_CELL), y1 = Math.floor((n.y + n.height) / COLLISION_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(n);
      }
    }
  }
  return {
    collides(x, y, w, h) {
      const x0 = Math.floor(x / COLLISION_CELL), x1 = Math.floor((x + w) / COLLISION_CELL);
      const y0 = Math.floor(y / COLLISION_CELL), y1 = Math.floor((y + h) / COLLISION_CELL);
      const seen = new Set();
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const bucket = grid.get(key(cx, cy));
          if (!bucket) continue;
          for (const o of bucket) {
            if (seen.has(o)) continue;
            seen.add(o);
            if (x < o.x + o.width && x + w > o.x && y < o.y + o.height && y + h > o.y) return true;
          }
        }
      }
      return false;
    }
  };
}

// Original single-axis placement ("row" along X, "column"/BOTTOM along Y),
// now bounds-shared and grid-indexed instead of doing its own O(n) scan.
function getFreeCanvasPositionRow(width = 400, height = 800, options = {}) {
  const gap = typeof options.gap === 'number' ? options.gap : 80;
  const direction = (options.direction || 'RIGHT').toUpperCase();
  const w = Number.isFinite(width) && width > 0 ? width : 400;
  const h = Number.isFinite(height) && height > 0 ? height : 800;

  const bounds = options.bounds || computeTopLevelBounds();
  const { nodes, minX, maxX, minY, maxY } = bounds;
  if (nodes.length === 0) return { x: 0, y: 0 };

  const grid = options.grid || buildCollisionGrid(nodes);
  const originX = isFinite(minX) ? minX : 0;
  const originY = isFinite(minY) ? minY : 0;
  const edgeX = isFinite(maxX) ? maxX : 0;
  const edgeY = isFinite(maxY) ? maxY : 0;

  let x = direction === 'BOTTOM' ? originX : edgeX + gap;
  let y = direction === 'BOTTOM' ? edgeY + gap : originY;

  for (let attempt = 0; attempt < 200 && grid.collides(x, y, w, h); attempt++) {
    if (direction === 'BOTTOM') y += h + gap;
    else x += w + gap;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

// Shelf-packing placement: scans a virtual `columns`-wide grid row by row and
// returns the first cell whose real geometry is free, so a run of same-sized
// generated screens fills a compact rectangle instead of one long ribbon.
function getFreeCanvasPositionGrid(width = 400, height = 800, options = {}) {
  const gap = typeof options.gap === 'number' ? options.gap : 80;
  const columns = Math.max(1, Math.round(options.columns || 4));
  const w = Number.isFinite(width) && width > 0 ? width : 400;
  const h = Number.isFinite(height) && height > 0 ? height : 800;

  const bounds = options.bounds || computeTopLevelBounds();
  const { nodes, minX, minY } = bounds;
  if (nodes.length === 0) return { x: 0, y: 0 };

  const grid = options.grid || buildCollisionGrid(nodes);
  const originX = isFinite(minX) ? minX : 0;
  const originY = isFinite(minY) ? minY : 0;

  for (let row = 0; row < 200; row++) {
    const y = originY + row * (h + gap);
    for (let col = 0; col < columns; col++) {
      const x = originX + col * (w + gap);
      if (!grid.collides(x, y, w, h)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  // 200 rows x `columns` cells all occupied is pathological — fall back to
  // "past the edge" rather than looping forever.
  return getFreeCanvasPositionRow(width, height, { gap, direction: 'RIGHT', bounds, grid });
}

// Smart Canvas Placement Engine: Calculate free position on canvas avoiding
// overlaps. `layout: "grid"` shelf-packs; anything else keeps the original
// single-axis behaviour ("row" = RIGHT, "column"/"BOTTOM" = downward).
function getFreeCanvasPosition(width = 400, height = 800, options = {}) {
  const layout = String(options.layout || (options.direction === 'BOTTOM' ? 'row' : 'row')).toLowerCase();
  if (layout === 'grid') return getFreeCanvasPositionGrid(width, height, options);
  return getFreeCanvasPositionRow(width, height, options);
}

// Auto-position node if placed at default (0, 0) or overlapping other top-level nodes
function autoPositionIfColliding(node, gap = 80) {
  if (!node || node.parent !== figma.currentPage) return;
  const bounds = computeTopLevelBounds(node);
  if (bounds.nodes.length === 0) return;
  const grid = buildCollisionGrid(bounds.nodes);

  if ((node.x === 0 && node.y === 0) || grid.collides(node.x, node.y, node.width, node.height)) {
    const freePos = getFreeCanvasPositionRow(node.width, node.height, { gap, bounds, grid });
    node.x = freePos.x;
    node.y = freePos.y;
  }
}

// ==========================================================================
// Component Index — cached, tokenized search over COMPONENT / COMPONENT_SET
// nodes, replacing a full page.findAll() on every figma_find_components call.
// --------------------------------------------------------------------------
// A cold build still walks every page once (unavoidable — nothing indexes
// this for us), but every SEARCH after that is O(matches) instead of
// O(document size). The index is invalidated on any create/delete/rename
// document change and otherwise treated as valid for COMPONENT_INDEX_TTL_MS,
// so a search is never more than that far behind reality even if a change
// event is somehow missed.
// ==========================================================================
let componentIndex = null;
let componentIndexBuiltAt = 0;
const COMPONENT_INDEX_TTL_MS = 60000;

function tokenizeName(name) {
  return String(name || '').toLowerCase().split(/[\s_\-/]+/).filter(Boolean);
}

function buildComponentIndex() {
  const index = new Map();
  for (const page of figma.root.children) {
    let nodes = [];
    try {
      nodes = page.findAll(n => n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && n.parent && n.parent.type !== 'COMPONENT_SET'));
    } catch (e) { continue; }
    for (const node of nodes) {
      index.set(node.id, {
        id: node.id,
        name: node.name || '',
        type: node.type,
        pageId: page.id,
        pageName: page.name,
        tokens: tokenizeName(node.name)
      });
    }
  }
  componentIndex = index;
  componentIndexBuiltAt = Date.now();
  return index;
}

function ensureComponentIndex(forceRefresh) {
  if (forceRefresh || !componentIndex || Date.now() - componentIndexBuiltAt > COMPONENT_INDEX_TTL_MS) {
    buildComponentIndex();
  }
  return componentIndex;
}

if (typeof figma.on === 'function') {
  try {
    figma.on('documentchange', (event) => {
      const relevant = (event.documentChanges || []).some(c =>
        c.type === 'CREATE' || c.type === 'DELETE' ||
        (c.type === 'PROPERTY_CHANGE' && Array.isArray(c.properties) && c.properties.indexOf('name') !== -1)
      );
      if (relevant) componentIndex = null; // cheap invalidation; next search rebuilds
    });
  } catch (e) {}
}

// Bounded edit distance — returns max+1 (a sentinel "too far") as soon as the
// budget is provably exceeded, so a wildly different token costs O(len) not
// O(len^2) the way a naive full DP table would for every candidate.
function levenshteinAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const lb = b.length;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[lb];
}

// Ranked search: exact name > name prefix > any token prefix > every query
// token matches some name token by prefix > fuzzy (edit distance <= 2).
function searchComponentIndex(query, options) {
  options = options || {};
  const index = ensureComponentIndex(options.forceRefresh);
  const q = String(query || '').trim().toLowerCase();
  const qTokens = tokenizeName(q);
  let entries = Array.from(index.values());
  if (options.pageName) {
    const pn = options.pageName.toLowerCase();
    entries = entries.filter(e => e.pageName.toLowerCase() === pn);
  }
  if (!q) return entries.slice(0, options.limit || 30);

  const scored = [];
  for (const e of entries) {
    const nameLower = e.name.toLowerCase();
    let score = -1;
    if (nameLower === q) score = 100;
    else if (nameLower.startsWith(q)) score = 80;
    else if (e.tokens.some(t => t.startsWith(q))) score = 60;
    else if (qTokens.length > 0 && qTokens.every(qt => e.tokens.some(t => t.startsWith(qt)))) score = 50;
    else {
      let fuzzyHit = false;
      for (const qt of qTokens) {
        if (fuzzyHit) break;
        for (const t of e.tokens) {
          if (Math.abs(t.length - qt.length) <= 2 && levenshteinAtMost(qt, t, 2) <= 2) { fuzzyHit = true; break; }
        }
      }
      if (fuzzyHit) score = 20;
    }
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, options.limit || 30).map(s => s.e);
}

// ==========================================================================
// Smart Capture — resolves WHAT to screenshot without touching the user's
// selection, and frames tightly instead of exporting a whole container.
// ==========================================================================
function ancestorChain(node) {
  const chain = [];
  let n = node;
  while (n) { chain.push(n); n = n.parent; }
  return chain;
}

// Deepest node that contains every given node somewhere in its subtree, or
// null if they share nothing but the page.
function findCommonAncestor(nodes) {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  let common = ancestorChain(nodes[0]);
  for (let i = 1; i < nodes.length && common.length > 0; i++) {
    const idsInChain = new Set(ancestorChain(nodes[i]).map(n => n.id));
    common = common.filter(n => idsInChain.has(n.id));
  }
  return common[0] || null;
}

// capture_node_ids wins; otherwise whatever this call's checkpoint created or
// modified; otherwise the user's current selection (last resort, so a call
// with no other signal still behaves like the old default) — but selection is
// never MUTATED to make a capture possible, only read.
function resolveCaptureTargets(captureNodeIds, checkpointCreated, checkpointModified, selection) {
  if (Array.isArray(captureNodeIds) && captureNodeIds.length > 0) {
    return captureNodeIds.map(id => figma.getNodeById(id)).filter(Boolean);
  }
  const journalIds = [].concat(checkpointCreated || [], checkpointModified || []);
  if (journalIds.length > 0) {
    const seen = new Set();
    return journalIds.map(id => figma.getNodeById(id)).filter(n => n && !seen.has(n.id) && seen.add(n.id));
  }
  if (selection && selection.length > 0) return selection.slice();
  return [];
}

// Degrades in order: (1) single node → direct export, (2) multiple nodes that
// share a real frame → export just that frame (tight crop instead of the
// whole page), (3) no shared frame → export up to 4 nodes individually rather
// than falling back to a giant whole-page screenshot.
async function exportCaptureTargets(nodes, scale) {
  const cleaned = (nodes || []).filter(n => n && typeof n.exportAsync === 'function');
  if (cleaned.length === 0) {
    return { images: [], note: null, targetName: null, targetId: null };
  }

  if (cleaned.length === 1) {
    const n = cleaned[0];
    const shot = await captureSafe(n, scale);
    return {
      images: shot.base64 ? [{ base64: shot.base64, label: n.name || n.type }] : [],
      note: shot.error,
      targetName: n.name || n.type,
      targetId: n.id
    };
  }

  const ancestor = findCommonAncestor(cleaned);
  if (ancestor && ancestor.type !== 'PAGE' && ancestor.type !== 'DOCUMENT' && typeof ancestor.exportAsync === 'function') {
    const shot = await captureSafe(ancestor, scale);
    if (shot.base64) {
      return {
        images: [{ base64: shot.base64, label: ancestor.name || ancestor.type }],
        note: shot.error,
        targetName: ancestor.name || ancestor.type,
        targetId: ancestor.id,
        framed: 'common-ancestor'
      };
    }
  }

  const capped = cleaned.slice(0, 4);
  const images = [];
  const notes = [];
  for (const n of capped) {
    const shot = await captureSafe(n, scale);
    if (shot.base64) images.push({ base64: shot.base64, label: n.name || n.type });
    if (shot.error) notes.push(`${n.name || n.id}: ${shot.error}`);
  }
  const note = [
    cleaned.length > capped.length
      ? `Captured ${capped.length} of ${cleaned.length} affected nodes individually (no single shared frame to export).`
      : null,
    notes.length ? notes.join(' | ') : null
  ].filter(Boolean).join(' ') || null;

  return {
    images,
    note,
    targetName: capped.map(n => n.name || n.type).join(', '),
    targetId: capped.map(n => n.id).join(',')
  };
}

// ==========================================================================
// Auto-lint — cheap, mechanical checks over the nodes a call just touched.
// Not a design critique; only things that are unambiguously a defect and
// nearly free to detect from properties already in hand.
// ==========================================================================
function relativeLuminance(color) {
  const chan = (c) => { const v = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); return v; };
  return 0.2126 * chan(color.r) + 0.7152 * chan(color.g) + 0.0722 * chan(color.b);
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1) + 0.05;
  const l2 = relativeLuminance(c2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

function findSolidFillColor(node) {
  if (!node || !Array.isArray(node.fills)) return null;
  const solid = node.fills.find(f => f && f.type === 'SOLID' && f.visible !== false);
  return solid ? solid.color : null;
}

function lintNodes(nodes) {
  const warnings = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);

    if (node.type === 'TEXT') {
      try {
        if (typeof node.textAutoResize !== 'undefined' && node.textAutoResize === 'NONE') {
          // Fixed-size text: Figma reports overflow via .exportAsync only, but a
          // cheap proxy is available for horizontal truncation-prone single lines.
          if (node.textTruncation === 'ENDING') {
            warnings.push(`Text "${(node.characters || node.name || '').slice(0, 40)}" is truncated (ends with an ellipsis) — widen the node or its container.`);
          }
        }
        const parentFill = node.parent && findSolidFillColor(node.parent);
        const textFill = findSolidFillColor(node);
        if (parentFill && textFill) {
          const ratio = contrastRatio(parentFill, textFill);
          if (ratio < 4.5) {
            warnings.push(`Text "${(node.characters || node.name || '').slice(0, 40)}" has ~${ratio.toFixed(1)}:1 contrast against its parent fill (WCAG AA wants 4.5:1).`);
          }
        }
      } catch (e) {}
    }

    if (typeof node.width === 'number' && typeof node.height === 'number' && (node.width === 0 || node.height === 0)) {
      warnings.push(`"${node.name || node.type}" has a zero dimension (${Math.round(node.width)}x${Math.round(node.height)}) — likely unintended.`);
    }

    try {
      if (node.parent && 'layoutMode' in node.parent && node.parent.layoutMode !== 'NONE') {
        if (node.parent.primaryAxisSizingMode === 'AUTO' && typeof node.layoutGrow === 'number' && node.layoutGrow > 0) {
          warnings.push(`"${node.name || node.type}" has layoutGrow set inside a hugging (AUTO) parent — grow has no effect there.`);
        }
      }
    } catch (e) {}
  }
  return warnings.slice(0, 10); // cap — this rides along in every response, keep it cheap to read
}

// ==========================================================================
// Live Canvas → REST-shape adapter (figma_read_canvas)
// --------------------------------------------------------------------------
// Produces the same node shape the Figma REST API returns (absoluteBoundingBox,
// layoutMode, fills, style{...}, ...) so the EXISTING optimizer/pruner/
// serializer pipeline in figma/optimizer (written for REST responses) works
// unmodified on live canvas data. Two independent caps bound a single call:
// `maxDepth` (from the request, hard-clamped to 12) and a total node budget
// (4000) so a single `figma_read_canvas` on a huge page cannot block the UI
// thread indefinitely or blow up the WebSocket frame.
// ==========================================================================
const STYLE_WEIGHT_MAP = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600,
  bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900
};

function styleNameToWeight(styleName) {
  if (!styleName) return undefined;
  const cleaned = String(styleName).toLowerCase().replace(/italic/g, '').trim().replace(/\s+/g, '');
  return STYLE_WEIGHT_MAP[cleaned];
}

function liveNodeToRestShape(node, depth, maxDepth, includeHidden, budget) {
  if (!node || budget.count >= budget.max) return null;
  if (node.visible === false && !includeHidden) return null;
  budget.count++;

  const bbox = node.absoluteBoundingBox || { x: node.x || 0, y: node.y || 0, width: node.width || 0, height: node.height || 0 };
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
    absoluteBoundingBox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
  };

  if (depth > maxDepth) { out.truncated = true; return out; }

  try {
    if ('layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE') {
      out.layoutMode = node.layoutMode;
      if (typeof node.itemSpacing === 'number') out.itemSpacing = node.itemSpacing;
      if (typeof node.paddingTop === 'number') out.paddingTop = node.paddingTop;
      if (typeof node.paddingRight === 'number') out.paddingRight = node.paddingRight;
      if (typeof node.paddingBottom === 'number') out.paddingBottom = node.paddingBottom;
      if (typeof node.paddingLeft === 'number') out.paddingLeft = node.paddingLeft;
      if (node.counterAxisAlignItems) out.counterAxisAlignItems = node.counterAxisAlignItems;
      if (node.primaryAxisAlignItems) out.primaryAxisAlignItems = node.primaryAxisAlignItems;
      if (node.layoutWrap === 'WRAP') out.layoutWrap = 'WRAP';
    }
    if (node.layoutSizingHorizontal && node.layoutSizingHorizontal !== figma.mixed) out.layoutSizingHorizontal = node.layoutSizingHorizontal;
    if (node.layoutSizingVertical && node.layoutSizingVertical !== figma.mixed) out.layoutSizingVertical = node.layoutSizingVertical;
    if (node.layoutPositioning === 'ABSOLUTE') out.layoutPositioning = 'ABSOLUTE';

    if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) out.fills = node.fills;
    if ('strokes' in node && node.strokes !== figma.mixed && Array.isArray(node.strokes) && node.strokes.length) {
      out.strokes = node.strokes;
      if (typeof node.strokeWeight === 'number') out.strokeWeight = node.strokeWeight;
    }
    if (typeof node.cornerRadius === 'number') out.cornerRadius = node.cornerRadius;
    else if (Array.isArray(node.rectangleCornerRadii)) out.rectangleCornerRadii = node.rectangleCornerRadii;
    if (typeof node.opacity === 'number') out.opacity = node.opacity;
    if (node.clipsContent === true) out.clipsContent = true;

    if (node.type === 'TEXT') {
      out.characters = node.characters || '';
      const fontName = node.fontName !== figma.mixed ? node.fontName : null;
      out.style = {
        fontFamily: fontName ? fontName.family : undefined,
        fontWeight: styleNameToWeight(fontName && fontName.style),
        fontSize: node.fontSize !== figma.mixed ? node.fontSize : undefined,
        lineHeightPx: (node.lineHeight && node.lineHeight !== figma.mixed && node.lineHeight.unit === 'PIXELS') ? node.lineHeight.value : undefined,
        letterSpacing: (node.letterSpacing && node.letterSpacing !== figma.mixed && node.letterSpacing.unit === 'PIXELS') ? node.letterSpacing.value : undefined,
        textAlignHorizontal: node.textAlignHorizontal
      };
    }

    if (node.type === 'INSTANCE') {
      if (node.mainComponent) out.componentId = node.mainComponent.id;
      if (node.variantProperties) out.variantProperties = node.variantProperties;
    }
    if (node.componentProperties && Object.keys(node.componentProperties).length) out.componentProperties = node.componentProperties;
  } catch (e) {
    // A single unreadable property (rare host-object edge case) must not sink
    // the whole subtree — the node still comes back with whatever we got.
  }

  if ('children' in node && Array.isArray(node.children) && node.children.length) {
    const kids = [];
    for (const child of node.children) {
      if (budget.count >= budget.max) { out.truncated = true; break; }
      const k = liveNodeToRestShape(child, depth + 1, maxDepth, includeHidden, budget);
      if (k) kids.push(k);
    }
    if (kids.length) out.children = kids;
  }

  return out;
}

function readCanvasTree(options) {
  const maxDepth = Number.isFinite(options.depth) && options.depth > 0 ? Math.min(options.depth, 12) : 6;
  const includeHidden = options.include_hidden === true;
  const budget = { count: 0, max: 4000 };

  let roots;
  if (Array.isArray(options.node_ids) && options.node_ids.length > 0) {
    roots = options.node_ids.map(id => figma.getNodeById(id)).filter(Boolean);
  } else {
    roots = figma.currentPage.children.filter(n => n.visible !== false || includeHidden);
  }

  const children = roots.map(n => liveNodeToRestShape(n, 0, maxDepth, includeHidden, budget)).filter(Boolean);

  return {
    document: { id: figma.currentPage.id, name: figma.currentPage.name, type: 'CANVAS', children },
    name: figma.root.name,
    truncatedTop: budget.count >= budget.max
  };
}

// Set by the Control tab's Pause button. Gated centrally below rather than in
// each handler, so pausing genuinely stops every write-type message the same
// way instead of needing to be threaded through each one individually.
let executionPaused = false;
const PAUSABLE_TYPES = new Set([
  'EXECUTE', 'INSERT_COMPONENT_INSTANCE', 'INSERT_SVG', 'SET_VARIABLES_MODE'
]);

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'SET_PAUSED') {
    executionPaused = msg.value === true;
    figma.ui.postMessage({ type: 'PAUSED_STATE', paused: executionPaused });
    return;
  }

  if (executionPaused && PAUSABLE_TYPES.has(msg.type || 'EXECUTE')) {
    figma.ui.postMessage({
      type: 'RESULT',
      id: msg.id,
      success: false,
      description: msg.description || 'AI Command',
      error: 'Paused by user. Resume from the Control tab to let the AI act again.',
      code: 'EXECUTION_PAUSED',
      startTime: msg.startTime
    });
    return;
  }

  if (msg.type === 'JUMP_TO_NODE') {
    try {
      const node = figma.getNodeById(msg.nodeId);
      if (node && 'x' in node) {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    } catch (e) {}
    return;
  }

  if (msg.type === 'SET_AUTO_ZOOM') {
    autoZoomEnabled = msg.value === true;
    return;
  }

  if (msg.type === 'SET_SMART_PLACEMENT') {
    smartPlacementEnabled = msg.value === true;
    return;
  }

  if (msg.type === 'RESIZE_WINDOW') {
    figma.ui.resize(msg.width, msg.height);
    return;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    try {
      await figma.clientStorage.setAsync('antigravity_settings', msg.settings);
    } catch (e) {}
    return;
  }

  if (msg.type === 'LOAD_SETTINGS') {
    try {
      const settings = await figma.clientStorage.getAsync('antigravity_settings') || {};
      figma.ui.postMessage({ type: 'SETTINGS_LOADED', settings });
    } catch (e) {
      figma.ui.postMessage({ type: 'SETTINGS_LOADED', settings: {} });
    }
    return;
  }

  // ==========================================
  // 1. Generic JS Sandbox Execution
  // ==========================================
  if (msg.type === 'EXECUTE') {
    const {
      id, code, description, capture, scale = 1.5, autoZoom = true, startTime,
      capture_node_ids, diff
    } = msg;
    const actionLabel = description || "AI Command Execution";
    const execStart = Date.now();

    let runningToast = null;
    if (allowCanvasToast()) {
      try { runningToast = figma.notify(`🤖 ${actionLabel}...`, { timeout: 30000 }); } catch (e) {}
    }

    const logToUi = (text) => {
      figma.ui.postMessage({ type: 'LOG', text: String(text) });
    };

    const notifyCanvas = (text, opts) => {
      try {
        return figma.notify(text, opts);
      } catch (e) {
        return null;
      }
    };

    const reportProgress = (step, of, note) => {
      try {
        figma.ui.postMessage({ type: 'PROGRESS', id, step, of, note: note ? String(note) : undefined, ts: Date.now() });
      } catch (e) {}
    };

    // Every figma.create*() call the sandboxed code makes is journaled here so
    // rollback and the default capture target both know what this call did,
    // without requiring the agent to opt in. See "Checkpoint Journal" above.
    const cp = beginCheckpoint(actionLabel);
    const trackingFigma = createTrackingFigma();

    let beforeShot = null;
    if (diff === true && Array.isArray(capture_node_ids) && capture_node_ids.length > 0) {
      const before = capture_node_ids.map(nid => figma.getNodeById(nid)).filter(Boolean);
      if (before.length > 0) {
        const shot = await exportCaptureTargets(before, scale);
        if (shot.images.length > 0) beforeShot = shot.images[0];
      }
    }

    try {
      await ensureFont("Inter", "Regular");
      await ensureFont("Inter", "Medium");
      await ensureFont("Inter", "Bold");

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // No wrapper newline/indent: keeps reported error line numbers aligned
      // with the code the agent actually sent.
      const bridgeApi = createBridgeApi();
      const fn = new AsyncFunction(
        'figma', 'ensureFont', 'notify', 'log', 'getFreePosition', 'getFreeCanvasPosition', 'bridge', 'progress',
        code
      );

      const result = await fn(
        trackingFigma, ensureFont, notifyCanvas, logToUi,
        getFreeCanvasPosition, getFreeCanvasPosition, bridgeApi, reportProgress
      );

      const cpResult = cp.commit();

      const selection = figma.currentPage.selection;
      if (selection.length > 0) {
        for (const selNode of selection) {
          if (smartPlacementEnabled && selNode.parent === figma.currentPage && selNode.x === 0 && selNode.y === 0) {
            autoPositionIfColliding(selNode, 80);
          }
        }
        if (autoZoom && autoZoomEnabled) {
          figma.viewport.scrollAndZoomIntoView(selection);
        }
      }

      let screenshot = null;
      let screenshots = null;
      let targetName = null;
      let targetId = null;
      let captureNote = null;

      if (capture) {
        const targets = resolveCaptureTargets(capture_node_ids, cpResult.created, cpResult.modified, selection);
        if (targets.length > 0) {
          const shot = await exportCaptureTargets(targets, scale);
          targetName = shot.targetName;
          targetId = shot.targetId;
          captureNote = shot.note;
          if (shot.images.length === 1) {
            screenshot = shot.images[0].base64;
          } else if (shot.images.length > 1) {
            screenshots = shot.images.map(img => ({ base64: img.base64, label: img.label }));
          }
        } else {
          // Never auto-export figma.currentPage: on a real file that is the
          // entire canvas, which is both enormous and almost never what the
          // agent meant to look at.
          captureNote =
            "Nothing was created, modified, selected, or passed via capture_node_ids, so no screenshot was taken " +
            "(capturing the whole page is disabled). Pass capture_node_ids, or select a node before returning.";
        }
      }

      const warnings = lintNodes(
        (capture_node_ids || []).map(nid => figma.getNodeById(nid)).filter(Boolean)
          .concat(cpResult.created.map(nid => figma.getNodeById(nid)).filter(Boolean))
          .concat(cpResult.modified.map(nid => figma.getNodeById(nid)).filter(Boolean))
      );

      if (runningToast) runningToast.cancel();
      if (allowCanvasToast()) {
        if (capture && (screenshot || screenshots)) {
          figma.notify(`✅ ${actionLabel} + 📸 capture sent to AI`, { timeout: 3000 });
        } else {
          figma.notify(`✅ ${actionLabel} — done!`, { timeout: 2500 });
        }
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: result !== undefined ? result : "Execution finished successfully",
        screenshot: screenshot,
        screenshots: screenshots,
        beforeScreenshot: beforeShot ? beforeShot.base64 : null,
        captureNote: captureNote,
        targetName: targetName,
        targetId: targetId,
        checkpointId: cpResult.checkpoint_id,
        created: cpResult.created,
        modified: cpResult.modified,
        warnings: warnings,
        durationMs: Date.now() - execStart,
        startTime: startTime
      });
    } catch (err) {
      cp.commit(); // whatever WAS created before the throw is still on canvas and rollback-eligible
      if (runningToast) runningToast.cancel();
      const enriched = enrichBridgeError(err);
      try { figma.notify(`❌ Error: ${enriched.message}`, { error: true, timeout: 6000 }); } catch (e) {}

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        durationMs: Date.now() - execStart,
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 2. High-Performance Canvas Screenshot
  // ==========================================
  else if (msg.type === 'SCREENSHOT') {
    const { id, nodeIds, scale = 1.5, description = "Screenshot capture", autoZoom = true, startTime } = msg;

    let targets = [];
    if (nodeIds && typeof nodeIds === 'string' && nodeIds.trim().length > 0) {
      const ids = nodeIds.split(',').map(s => s.trim().replace(/-/g, ":"));
      for (const nid of ids) {
        const node = figma.getNodeById(nid);
        if (node) targets.push(node);
      }
    }

    if (targets.length === 0) {
      targets = figma.currentPage.selection.length > 0 ? figma.currentPage.selection : [figma.currentPage];
    }

    if (autoZoom && autoZoomEnabled && targets.length > 0) {
      figma.viewport.scrollAndZoomIntoView(targets);
    }

    figma.notify(`📸 Capturing screenshot (${targets.map(t => t.name).join(', ')})...`, { timeout: 2500 });

    try {
      const screenshots = [];
      for (const target of targets) {
        const shot = await captureSafe(target, scale);
        screenshots.push({
          id: target.id,
          name: target.name || "Node",
          base64: shot.base64,
          error: shot.error || undefined
        });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: description,
        result: `Captured ${screenshots.length} node(s)`,
        screenshots: screenshots,
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: description,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 3. Design System: Find Components & Sets
  // ==========================================
  else if (msg.type === 'FIND_COMPONENTS') {
    const { id, query = '', page_name, include_variants = true, limit = 30, refresh_index, startTime } = msg;
    const actionLabel = `Find Components${query ? ` ("${query}")` : ''}`;

    try {
      // Candidate lookup goes through the Component Index (cached, tokenized,
      // ranked) instead of a page.findAll() on every call — see "Component
      // Index" above. Only the small, already-ranked candidate set below still
      // touches the live nodes, to build the exact same variants/properties
      // detail the old implementation returned.
      const candidates = searchComponentIndex(query, {
        pageName: page_name,
        limit: Math.max(limit, 60), // search wider than the final cap so per-candidate detail extraction can still legitimately drop a few (e.g. description-based matches this index doesn't rank) — trimmed to `limit` below
        forceRefresh: refresh_index === true
      });

      const q = query.trim().toLowerCase();
      const results = [];

      for (const entry of candidates) {
        const node = figma.getNodeById(entry.id);
        if (!node) continue; // stale index entry (deleted since last rebuild) — skip rather than error

        const name = node.name || '';
        const desc = node.description || '';
        const isComponentSet = node.type === 'COMPONENT_SET';

        let variantsMap = null;
        let propDefinitions = null;

        if (isComponentSet) {
          variantsMap = {};
          const defs = node.componentPropertyDefinitions || {};
          for (const [pName, def] of Object.entries(defs)) {
            if (def.type === 'VARIANT' && Array.isArray(def.variantOptions)) {
              variantsMap[pName] = def.variantOptions;
            } else {
              if (!propDefinitions) propDefinitions = {};
              propDefinitions[pName] = { type: def.type, defaultValue: def.defaultValue };
            }
          }

          if (Object.keys(variantsMap).length === 0 && node.children) {
            for (const child of node.children) {
              if (child.type === 'COMPONENT' && child.variantProperties) {
                for (const [k, v] of Object.entries(child.variantProperties)) {
                  if (!variantsMap[k]) variantsMap[k] = [];
                  if (!variantsMap[k].includes(v)) variantsMap[k].push(v);
                }
              }
            }
          }
        } else if (node.componentPropertyDefinitions) {
          propDefinitions = {};
          for (const [pName, def] of Object.entries(node.componentPropertyDefinitions)) {
            propDefinitions[pName] = { type: def.type, defaultValue: def.defaultValue };
          }
        }

        // The index already ranked by name/token match; a query can still hit
        // through the description or a variant VALUE the index doesn't see —
        // re-check those here so nothing the old substring search found is lost.
        let matches = true;
        if (q) {
          const inIndex = entry.tokens.some(t => t.indexOf(q) !== -1) || (entry.name || '').toLowerCase().indexOf(q) !== -1;
          const inDesc = desc.toLowerCase().indexOf(q) !== -1;
          let inVariants = false;
          if (variantsMap) {
            for (const [k, vals] of Object.entries(variantsMap)) {
              if (k.toLowerCase().indexOf(q) !== -1 || vals.some(v => String(v).toLowerCase().indexOf(q) !== -1)) {
                inVariants = true;
                break;
              }
            }
          }
          matches = inIndex || inDesc || inVariants;
        }
        if (!matches) continue;

        const item = {
          id: node.id,
          name,
          type: node.type,
          key: node.key,
          page: entry.pageName,
          description: desc || undefined
        };
        if (include_variants && isComponentSet && variantsMap) item.variants = variantsMap;
        if (propDefinitions) item.properties = propDefinitions;

        results.push(item);
        if (results.length >= limit) break;
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: results,
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 4. Design System: Insert Component Instance
  // ==========================================
  else if (msg.type === 'INSERT_COMPONENT_INSTANCE') {
    const {
      id,
      component_name,
      component_id,
      properties = {},
      text_overrides = {},
      target_parent_id,
      position,
      capture = true,
      scale = 1.5,
      startTime
    } = msg;

    const actionLabel = `Insert Component "${component_name || component_id}"`;
    const cp = beginCheckpoint(actionLabel);
    let runningToast = null;
    if (allowCanvasToast()) {
      try { runningToast = figma.notify(`🎨 Inserting component...`, { timeout: 15000 }); } catch (e) {}
    }

    try {
      await ensureFont("Inter", "Regular");
      await ensureFont("Inter", "Medium");
      await ensureFont("Inter", "Bold");

      // Non-fatal problems surfaced in the result instead of vanishing into an
      // empty catch: a "success" response used to look identical whether every
      // requested property/override actually landed or none of them did.
      const propertyWarnings = [];

      // 1. Locate Master Component / Component Set
      let master = null;
      if (component_id) {
        master = figma.getNodeById(component_id.replace(/-/g, ":"));
      }

      if (!master && component_name) {
        const qName = component_name.trim().toLowerCase();
        for (const page of figma.root.children) {
          const candidates = page.findAll(n =>
            (n.type === 'COMPONENT_SET' || n.type === 'COMPONENT') &&
            (n.name.toLowerCase() === qName || n.name.toLowerCase().includes(qName))
          );
          if (candidates.length > 0) {
            // Prioritize exact match, then component sets, then components
            candidates.sort((a, b) => {
              const aExact = a.name.toLowerCase() === qName ? 2 : 0;
              const bExact = b.name.toLowerCase() === qName ? 2 : 0;
              const aSet = a.type === 'COMPONENT_SET' ? 1 : 0;
              const bSet = b.type === 'COMPONENT_SET' ? 1 : 0;
              return (bExact + bSet) - (aExact + aSet);
            });
            master = candidates[0];
            break;
          }
        }
      }

      if (!master) {
        throw new Error(`Component "${component_name || component_id}" was not found in document.`);
      }

      // 2. Resolve Variant and Instantiate
      let instance = null;
      if (master.type === 'COMPONENT') {
        instance = master.createInstance();
      } else if (master.type === 'COMPONENT_SET') {
        let bestChild = null;
        if (properties && Object.keys(properties).length > 0) {
          // Only a key that is an ACTUAL variant property name on this set can
          // decide a match. Component properties (text, boolean, instance-swap)
          // share the same `properties` object but are applied later via
          // instance.setProperties — treating THEM as unmatched variant keys
          // used to make every request with one "match" nothing and silently
          // fall through to master.children[0], the wrong instance.
          const variantKeyNames = new Set();
          for (const child of master.children) {
            if (child.type === 'COMPONENT' && child.variantProperties) {
              Object.keys(child.variantProperties).forEach(k => variantKeyNames.add(k.toLowerCase()));
            }
          }

          for (const child of master.children) {
            if (child.type === 'COMPONENT' && child.variantProperties) {
              let match = true;
              for (const [k, v] of Object.entries(properties)) {
                const kLower = k.toLowerCase();
                if (!variantKeyNames.has(kLower)) continue; // a component property, not a variant axis

                const childValKey = Object.keys(child.variantProperties).find(
                  ck => ck.toLowerCase() === kLower
                );
                // The key IS a variant axis on this set but this child lacks it,
                // or its value differs — either way this child does not match.
                if (!childValKey || String(child.variantProperties[childValKey]).toLowerCase() !== String(v).toLowerCase()) {
                  match = false;
                  break;
                }
              }
              if (match) {
                bestChild = child;
                break;
              }
            }
          }

          if (!bestChild) {
            const requestedAxes = Object.keys(properties).filter(k => variantKeyNames.has(k.toLowerCase()));
            if (requestedAxes.length > 0) {
              throw new Error(
                `No variant of ComponentSet "${master.name}" matches ${JSON.stringify(properties)}. ` +
                `Known variant properties: ${[...variantKeyNames].join(', ') || '(none)'}.`
              );
            }
          }
        }

        if (!bestChild) {
          bestChild = master.defaultVariant || master.children[0];
        }

        if (!bestChild || bestChild.type !== 'COMPONENT') {
          throw new Error(`Failed to resolve valid variant in ComponentSet "${master.name}"`);
        }

        instance = bestChild.createInstance();

        // Apply remaining properties via setProperties. Failures used to be
        // swallowed silently — the agent saw a "success" result with a screenshot
        // of an instance whose requested properties were never actually applied.
        if (properties && Object.keys(properties).length > 0) {
          try {
            instance.setProperties(properties);
          } catch (pe) {
            propertyWarnings.push(`setProperties(${JSON.stringify(properties)}) failed: ${pe.message || pe}`);
          }
        }
      } else {
        throw new Error(`Target node "${master.name}" is of type "${master.type}", not a COMPONENT or COMPONENT_SET.`);
      }
      recordCreated(instance);

      // 3. Apply Text Overrides
      const appliedViaProperty = [];
      if (text_overrides && typeof text_overrides === 'object' && Object.keys(text_overrides).length > 0) {
        // Try Component Property Text Overrides first
        for (const [k, v] of Object.entries(text_overrides)) {
          try {
            instance.setProperties({ [k]: String(v) });
            appliedViaProperty.push(k);
          } catch (e) {}
        }
        // Direct nested text layer traversal for whatever wasn't a component property
        const appliedViaLayer = await applyTextOverrides(instance, text_overrides);
        const requested = Object.keys(text_overrides);
        const applied = new Set([...appliedViaProperty, ...appliedViaLayer]);
        const missed = requested.filter(k => !applied.has(k));
        if (missed.length > 0) {
          propertyWarnings.push(`text_overrides not applied (no matching text layer or property): ${missed.join(', ')}`);
        }
      }

      // 4. Attach to Target Container
      let parent = null;
      if (target_parent_id) {
        parent = figma.getNodeById(target_parent_id.replace(/-/g, ":"));
      }

      if (!parent) {
        const curSel = figma.currentPage.selection;
        if (curSel.length > 0 && curSel[0].type === 'FRAME') {
          parent = curSel[0];
        } else {
          parent = figma.currentPage;
        }
      }

      if (position && typeof position.index === 'number' && parent.insertChild) {
        parent.insertChild(position.index, instance);
      } else {
        parent.appendChild(instance);
      }

      if (position && typeof position.x === 'number' && typeof position.y === 'number') {
        instance.x = position.x;
        instance.y = position.y;
      } else if (parent === figma.currentPage) {
        autoPositionIfColliding(instance, 80);
      }

      // 5. Focus & Selection
      figma.currentPage.selection = [instance];
      if (autoZoomEnabled) {
        figma.viewport.scrollAndZoomIntoView([instance]);
      }

      // 6. Screenshot Capture
      let screenshot = null;
      let captureNote = null;
      if (capture) {
        const shot = await captureSafe(instance, scale);
        screenshot = shot.base64;
        captureNote = shot.error;
      }

      const cpResult = cp.commit();
      const warnings = lintNodes([instance]).concat(propertyWarnings);

      if (runningToast) runningToast.cancel();
      if (allowCanvasToast()) {
        figma.notify(`✅ Inserted ${instance.name}${capture && screenshot ? ' + 📸 capture' : ''}`, { timeout: 3000 });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          instanceId: instance.id,
          name: instance.name,
          masterComponentId: master.id,
          masterName: master.name,
          parentContainer: parent.name || parent.id,
          width: instance.width,
          height: instance.height,
          variantProperties: instance.variantProperties || undefined,
          warnings: propertyWarnings.length > 0 ? propertyWarnings : undefined
        },
        screenshot: screenshot,
        captureNote: captureNote,
        targetName: instance.name,
        targetId: instance.id,
        checkpointId: cpResult.checkpoint_id,
        created: cpResult.created,
        modified: cpResult.modified,
        warnings: warnings,
        startTime: startTime
      });
    } catch (err) {
      cp.commit();
      if (runningToast) runningToast.cancel();
      const enriched = enrichBridgeError(err);
      try { figma.notify(`❌ Error: ${enriched.message}`, { error: true, timeout: 6000 }); } catch (e) {}

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 5. Design System: Get Variables & Tokens
  // ==========================================
  else if (msg.type === 'GET_VARIABLES') {
    const { id, collection_name, limit = 300, startTime } = msg;
    const actionLabel = `Get Variables${collection_name ? ` ("${collection_name}")` : ''}`;

    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables = await figma.variables.getLocalVariablesAsync();

      const qColl = collection_name ? collection_name.trim().toLowerCase() : '';
      const filteredCollections = qColl
        ? collections.filter(c => c.name.toLowerCase() === qColl || c.name.toLowerCase().includes(qColl))
        : collections;

      const collData = [];
      const tokensData = [];
      // Unbounded on a large design-token file (hundreds of tokens x every mode)
      // used to flood the response; cap it like figma_find_components does.
      const maxTokens = typeof limit === 'number' && limit > 0 ? limit : 300;
      let truncated = false;

      outer:
      for (const col of filteredCollections) {
        collData.push({
          id: col.id,
          name: col.name,
          defaultModeId: col.defaultModeId,
          modes: col.modes.map(m => ({ modeId: m.modeId, name: m.name }))
        });

        // Collect variables belonging to this collection
        const colVars = variables.filter(v => v.variableCollectionId === col.id);
        for (const v of colVars) {
          if (tokensData.length >= maxTokens) { truncated = true; break outer; }
          const valuesByMode = {};
          for (const mode of col.modes) {
            valuesByMode[mode.name] = v.valuesByMode[mode.modeId];
          }
          tokensData.push({
            id: v.id,
            name: v.name,
            resolvedType: v.resolvedType,
            collectionName: col.name,
            description: v.description || undefined,
            valuesByMode: valuesByMode
          });
        }
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          collections: collData,
          tokens: tokensData,
          truncated: truncated || undefined,
          truncatedNote: truncated
            ? `Showing the first ${maxTokens} tokens. Pass a narrower "collection_name" or a higher "limit" to see more.`
            : undefined
        },
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 6. Design System: Set Variables Mode
  // ==========================================
  else if (msg.type === 'SET_VARIABLES_MODE') {
    const { id, collection_name, mode_name, target_id, capture = true, scale = 1.5, startTime } = msg;
    const actionLabel = `Set Variable Mode "${mode_name}" on "${collection_name}"`;

    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const qColl = (collection_name || '').trim().toLowerCase();
      const qMode = (mode_name || '').trim().toLowerCase();

      const col = collections.find(c => c.name.toLowerCase() === qColl || c.name.toLowerCase().includes(qColl));
      if (!col) {
        throw new Error(`Variable collection "${collection_name}" not found.`);
      }

      const targetMode = col.modes.find(m => m.name.toLowerCase() === qMode || m.name.toLowerCase().includes(qMode));
      if (!targetMode) {
        const availableModes = col.modes.map(m => m.name).join(', ');
        throw new Error(`Mode "${mode_name}" not found in collection "${col.name}". Available modes: ${availableModes}`);
      }

      let targetNode = null;
      if (target_id) {
        targetNode = figma.getNodeById(target_id.replace(/-/g, ":"));
      }

      if (!targetNode) {
        const curSel = figma.currentPage.selection;
        targetNode = curSel.length > 0 ? curSel[0] : figma.currentPage;
      }

      targetNode.setExplicitVariableModeForCollection(col, targetMode.modeId);

      let screenshot = null;
      let captureNote = null;
      if (capture) {
        const shot = await captureSafe(targetNode, scale);
        screenshot = shot.base64;
        captureNote = shot.error;
      }

      figma.notify(`🌓 Theme switched to "${targetMode.name}" on ${targetNode.name}`, { timeout: 3000 });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: `Successfully set mode "${targetMode.name}" (${targetMode.modeId}) for collection "${col.name}" on "${targetNode.name}"`,
        screenshot: screenshot,
        captureNote: captureNote,
        targetName: targetNode.name,
        targetId: targetNode.id,
        startTime: startTime
      });
    } catch (err) {
      figma.notify(`❌ Error: ${err.message || String(err)}`, { error: true, timeout: 6000 });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 7. Direct SVG & Vector Import
  // ==========================================
  else if (msg.type === 'INSERT_SVG') {
    const {
      id,
      svg_code,
      name,
      width,
      height,
      fill_override,
      stroke_override,
      color_override,
      target_parent_id,
      position,
      as_component = false,
      capture = true,
      scale = 2.0,
      startTime
    } = msg;

    const actionLabel = `Insert SVG "${name || 'Vector'}"`;
    const cp = beginCheckpoint(actionLabel);
    let runningToast = null;
    if (allowCanvasToast()) {
      try { runningToast = figma.notify(`📐 Inserting vector SVG...`, { timeout: 15000 }); } catch (e) {}
    }

    try {
      if (!svg_code || typeof svg_code !== 'string' || !svg_code.includes('<svg')) {
        throw new Error("Invalid or empty svg_code. Must be a valid <svg ...>...</svg> XML string.");
      }

      // 1. Create node from SVG
      const rawNode = figma.createNodeFromSvg(svg_code);
      rawNode.name = name || "SVG Vector";
      recordCreated(rawNode);

      // 2. Proportional Scaling
      const origW = rawNode.width;
      const origH = rawNode.height;
      if ((width && width !== origW) || (height && height !== origH)) {
        const targetW = width || ((origW / origH) * height);
        const targetH = height || ((origH / origW) * width);
        applyScaleConstraints(rawNode);
        rawNode.resize(targetW, targetH);
      }

      // 3. Color Overrides
      const fillColor = parseColor(fill_override);
      const strokeColor = parseColor(stroke_override);
      const universalColor = parseColor(color_override);

      if (fillColor || strokeColor || universalColor) {
        applyVectorColors(rawNode, { fillColor, strokeColor, universalColor });
      }

      // 4. Wrap as Component if requested
      let finalNode = rawNode;
      if (as_component) {
        const comp = figma.createComponent();
        comp.name = name || "Icon / " + (rawNode.name || "Vector");
        comp.resize(rawNode.width, rawNode.height);
        for (const child of [...rawNode.children]) {
          comp.appendChild(child);
        }
        rawNode.remove();
        finalNode = comp;
        recordCreated(finalNode);
      }

      // 5. Attach to Target Container
      let parent = null;
      if (target_parent_id) {
        parent = figma.getNodeById(target_parent_id.replace(/-/g, ":"));
      }

      if (!parent) {
        const curSel = figma.currentPage.selection;
        if (curSel.length > 0 && curSel[0].type === 'FRAME') {
          parent = curSel[0];
        } else {
          parent = figma.currentPage;
        }
      }

      if (position && typeof position.index === 'number' && parent.insertChild) {
        parent.insertChild(position.index, finalNode);
      } else {
        parent.appendChild(finalNode);
      }

      if (position && typeof position.x === 'number' && typeof position.y === 'number') {
        finalNode.x = position.x;
        finalNode.y = position.y;
      } else if (parent === figma.currentPage) {
        autoPositionIfColliding(finalNode, 60);
      }

      // 6. Viewport Focus & Capture
      figma.currentPage.selection = [finalNode];
      if (autoZoomEnabled) {
        figma.viewport.scrollAndZoomIntoView([finalNode]);
      }

      let screenshot = null;
      let captureNote = null;
      if (capture) {
        const shot = await captureSafe(finalNode, scale);
        screenshot = shot.base64;
        captureNote = shot.error;
      }

      const cpResult = cp.commit();
      const warnings = lintNodes([finalNode]);

      if (runningToast) runningToast.cancel();
      if (allowCanvasToast()) {
        figma.notify(`✅ Vector inserted: ${finalNode.name}${capture && screenshot ? ' + 📸 capture' : ''}`, { timeout: 3000 });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          nodeId: finalNode.id,
          name: finalNode.name,
          type: finalNode.type,
          width: finalNode.width,
          height: finalNode.height,
          parentContainer: parent.name || parent.id
        },
        screenshot: screenshot,
        captureNote: captureNote,
        targetName: finalNode.name,
        targetId: finalNode.id,
        checkpointId: cpResult.checkpoint_id,
        created: cpResult.created,
        modified: cpResult.modified,
        warnings: warnings,
        startTime: startTime
      });
    } catch (err) {
      cp.commit();
      if (runningToast) runningToast.cancel();
      const enriched = enrichBridgeError(err);
      try { figma.notify(`❌ Error: ${enriched.message}`, { error: true, timeout: 6000 }); } catch (e) {}

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 8. Canvas Layout & Smart Bounds
  // ==========================================
  else if (msg.type === 'GET_CANVAS_LAYOUT') {
    const { id, direction = 'RIGHT', gap = 80, limit = 200, layout, columns, startTime } = msg;
    const actionLabel = "Get Canvas Layout";

    try {
      const page = figma.currentPage;
      const topNodes = page.children.filter(n => n.visible !== false);
      // Bounds are computed over EVERY node so the suggested position stays
      // correct even on a page with hundreds of artboards; only the listing
      // sent back to the model is capped.
      const maxListed = typeof limit === 'number' && limit > 0 ? limit : 200;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const artboards = [];

      for (const n of topNodes) {
        if (n.x < minX) minX = n.x;
        if (n.x + n.width > maxX) maxX = n.x + n.width;
        if (n.y < minY) minY = n.y;
        if (n.y + n.height > maxY) maxY = n.y + n.height;

        if (artboards.length < maxListed) {
          artboards.push({
            id: n.id,
            name: n.name,
            type: n.type,
            x: Math.round(n.x),
            y: Math.round(n.y),
            width: Math.round(n.width),
            height: Math.round(n.height)
          });
        }
      }

      const suggestedPos = getFreeCanvasPosition(400, 800, { direction, gap, layout, columns });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          pageName: page.name,
          totalArtboards: topNodes.length,
          artboards: artboards,
          truncated: topNodes.length > artboards.length || undefined,
          canvasBounds: topNodes.length > 0 ? {
            minX: Math.round(minX),
            maxX: Math.round(maxX),
            minY: Math.round(minY),
            maxY: Math.round(maxY)
          } : null,
          suggestedNextPosition: suggestedPos
        },
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 9. Read Canvas — live-document optimizer input (figma_read_canvas)
  // ==========================================
  else if (msg.type === 'READ_CANVAS') {
    const { id, node_ids, depth, include_hidden, startTime } = msg;
    const actionLabel = "Read Canvas";

    try {
      const result = readCanvasTree({
        node_ids: node_ids ? String(node_ids).split(',').map(s => s.trim()).filter(Boolean) : null,
        depth,
        include_hidden
      });
      figma.ui.postMessage({ type: 'RESULT', id, success: true, description: actionLabel, result, startTime });
    } catch (err) {
      const enriched = enrichBridgeError(err);
      figma.ui.postMessage({
        type: 'RESULT', id, success: false, description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        startTime
      });
    }
  }

  // ==========================================
  // 10. Checkpoint Journal — rollback & listing (figma_rollback)
  // ==========================================
  else if (msg.type === 'ROLLBACK') {
    const { id, checkpoint_id, startTime } = msg;
    const actionLabel = `Rollback ${checkpoint_id || 'last'}`;

    try {
      const result = rollbackCheckpoint(checkpoint_id || 'last');
      if (autoZoomEnabled) {
        try {
          const restoredNodes = result.restored.map(nid => figma.getNodeById(nid)).filter(Boolean);
          if (restoredNodes.length > 0) figma.viewport.scrollAndZoomIntoView(restoredNodes);
        } catch (e) {}
      }
      figma.notify(`↩ Rolled back "${result.label}" (${result.removed.length} removed, ${result.restored.length} restored)`, { timeout: 3500 });
      figma.ui.postMessage({ type: 'RESULT', id, success: true, description: actionLabel, result, startTime });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT', id, success: false, description: actionLabel,
        error: err.message || String(err), startTime
      });
    }
  }

  else if (msg.type === 'LIST_CHECKPOINTS') {
    const { id, startTime } = msg;
    try {
      const result = createBridgeApi().checkpoints();
      figma.ui.postMessage({ type: 'RESULT', id, success: true, description: "List Checkpoints", result, startTime });
    } catch (err) {
      figma.ui.postMessage({ type: 'RESULT', id, success: false, description: "List Checkpoints", error: err.message || String(err), startTime });
    }
  }

  // ==========================================
  // 11. Target Router — document identity, requested by the UI so it can
  //     report fileKey/fileName/pageName/pluginVersion on CLIENT_READY /
  //     CLIENT_FOCUS. figma.* is only reachable from this sandbox, not ui.html.
  // ==========================================
  else if (msg.type === 'GET_DOC_INFO') {
    try {
      figma.ui.postMessage({
        type: 'DOC_INFO',
        fileKey: (typeof figma.fileKey !== 'undefined' ? figma.fileKey : null),
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        pageId: figma.currentPage.id
      });
    } catch (e) {}
  }
};

// Keep the UI's document-identity payload (used for Target Router focus
// routing) fresh across page switches without waiting for a poll.
if (typeof figma.on === 'function') {
  try {
    figma.on('currentpagechange', () => {
      figma.ui.postMessage({ type: 'PAGE_CHANGED', pageName: figma.currentPage.name, pageId: figma.currentPage.id });
    });
  } catch (e) {}
}
