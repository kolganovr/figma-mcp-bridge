// Contract test for the Context Optimizer (figma/optimizer). Run:
// node tests/optimizer.test.js
//
// Exercises the REAL pruner/serializer pipeline against small, hand-built
// REST-API-shaped fixtures (the same shape figma_read_canvas's live adapter
// produces — see the "Live Canvas -> REST-shape adapter" section of
// figma-plugin/code.js) so both figma_read_canvas and get_file/get_node are
// covered by one set of fixtures.
const path = require("path");
const { optimizeFigmaData } = require(path.join(__dirname, "..", "figma", "optimizer"));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const CARD = {
  document: {
    id: "1:1", name: "Card", type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 120 },
    layoutMode: "VERTICAL", itemSpacing: 12,
    paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
    cornerRadius: 12,
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
    children: [
      {
        id: "1:2", name: "Title", type: "TEXT",
        absoluteBoundingBox: { x: 16, y: 16, width: 288, height: 24 },
        characters: "Hello",
        style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16, textAlignHorizontal: "LEFT" },
        fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 } }]
      },
      {
        id: "1:3", name: "ic_shield_check", type: "VECTOR", visible: true,
        absoluteBoundingBox: { x: 16, y: 48, width: 24, height: 24 },
        fills: [{ type: "SOLID", visible: true, color: { r: 0.29, g: 0.8, b: 0.5 } }]
      },
      {
        id: "1:4", name: "Hidden Layer", type: "TEXT", visible: false,
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        characters: "secret"
      },
      {
        id: "1:5", name: "Footer", type: "FRAME",
        absoluteBoundingBox: { x: 16, y: 80, width: 288, height: 24 },
        children: [
          {
            id: "1:6", name: "Description", type: "TEXT",
            absoluteBoundingBox: { x: 16, y: 80, width: 288, height: 24 },
            characters: "This is a longer paragraph of body copy nested two levels deep, the kind of content that a shallow maxDepth is meant to cut away entirely.",
            style: { fontFamily: "Inter", fontWeight: 400, fontSize: 13, textAlignHorizontal: "LEFT" }
          }
        ]
      }
    ]
  }
};

console.log("\n== jsx format ==");
const jsx = optimizeFigmaData(CARD, { format: "jsx" });
check("includes header with reduction stats", /Optimized Figma Layout/.test(jsx), jsx.slice(0, 80));
check("root frame becomes a Frame tag with layout attrs", /<Frame[^>]*id="1:1"[^>]*col[^>]*gap="12"/.test(jsx), jsx);
check("text node becomes a Text tag with its content", /<Text[^>]*>Hello<\/Text>/.test(jsx), jsx);
check("small vector with icon-ish name collapses to an Icon tag", /<Icon /.test(jsx), jsx);
check("hidden layer is pruned by default", !/Hidden Layer|secret/.test(jsx), jsx);
check("solid fill becomes a hex color, not a raw paint object", /#FFFFFF|#ffffff/i.test(jsx) || /bg="#FFFFFF"/i.test(jsx), jsx);

console.log("\n== include_hidden ==");
const jsxHidden = optimizeFigmaData(CARD, { format: "jsx", includeHidden: true });
check("include_hidden brings the hidden layer back", /secret/.test(jsxHidden), jsxHidden);

console.log("\n== tree format ==");
const tree = optimizeFigmaData(CARD, { format: "tree" });
check("tree format uses bracketed type tags", /\[FRAME\]/.test(tree) && /\[TEXT\]/.test(tree), tree);
check("tree format is more compact than jsx for the same data", tree.length < jsx.length, { tree: tree.length, jsx: jsx.length });

console.log("\n== json format ==");
const json = optimizeFigmaData(CARD, { format: "json" });
const parsed = JSON.parse(json.replace(/^<!--[\s\S]*?-->\n?/gm, ""));
check("json format round-trips to a pruned tree with the root id", parsed.id === "1:1", parsed);
check("pruned json drops raw absoluteBoundingBox in favour of width/height", parsed.width === 320 && parsed.height === 120 && !("absoluteBoundingBox" in parsed), parsed);

console.log("\n== raw / simplify:false passthrough ==");
const raw = optimizeFigmaData(CARD, { format: "raw" });
check("raw format returns the untouched input as JSON", JSON.parse(raw).document.id === "1:1");
const unsimplified = optimizeFigmaData(CARD, { format: "jsx", simplify: false });
check("simplify:false behaves like raw regardless of format", unsimplified === raw);

console.log("\n== token reduction is real, not cosmetic ==");
const rawBytes = Buffer.byteLength(JSON.stringify(CARD), "utf8");
const jsxBytes = Buffer.byteLength(jsx, "utf8");
check("optimized jsx is meaningfully smaller than the raw payload", jsxBytes < rawBytes, { rawBytes, jsxBytes });

console.log("\n== maxDepth truncation (what figma_read_canvas's budget_tokens loop relies on) ==");
// depth is 0 at the root, so maxDepth:0 fully expands the root itself and
// stubs its CHILDREN (depth 1) instead — matching pruneNode's `depth > maxDepth` check.
const shallow = optimizeFigmaData(CARD, { format: "tree", maxDepth: 0 });
check("maxDepth:0 keeps the root but marks its children truncated", /\[FRAME\] "Card"/.test(shallow) && /truncated/.test(shallow), shallow);
const deep = optimizeFigmaData(CARD, { format: "tree", maxDepth: 25 });
check("a generous maxDepth returns full children, no truncation", !/truncated/.test(deep) && /Title/.test(deep), deep);
check("shallower maxDepth is never larger than deeper maxDepth output", shallow.length <= deep.length, { shallow: shallow.length, deep: deep.length });

console.log("\n== get_node shape: { nodes: { id: { document } } } ==");
const NODE_RESPONSE = { nodes: { "1:1": { document: CARD.document } } };
const fromNodes = optimizeFigmaData(NODE_RESPONSE, { format: "tree" });
check("get_node's {nodes:{...}} shape is unwrapped to the same tree as get_file", fromNodes.replace(/^<!--.*-->\n/, "") === tree.replace(/^<!--.*-->\n/, ""), { fromNodes, tree });

// ---------------------------------------------------------------------------
// Reduction benchmark — this is the fixture behind the "86–91% smaller" figure
// quoted in README.md. It is asserted, not just printed, so the headline claim
// can't silently rot: a change that pushes reduction below 80% fails the suite.
// The fixture mimics what the REST API actually returns for a simple marketing
// section — the noise (fillGeometry paths, absoluteRenderBounds, constraints,
// blendMode, per-character style tables) is the whole point, since that noise
// is exactly what the pruner exists to remove.
// ---------------------------------------------------------------------------
console.log("\n== reduction benchmark (the number quoted in README.md) ==");
{
  const noisyVector = (id) => ({
    id, name: "ic_check", type: "VECTOR",
    absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
    absoluteRenderBounds: { x: 0, y: 0, width: 24, height: 24 },
    fills: [{ type: "SOLID", visible: true, color: { r: 0.2, g: 0.7, b: 0.4 }, a: 1 }],
    strokes: [], strokeWeight: 2, effects: [], blendMode: "PASS_THROUGH",
    constraints: { vertical: "TOP", horizontal: "LEFT" },
    strokeGeometry: [],
    fillGeometry: [{ path: "M1 2C3 4 5 6 7 8 ".repeat(40), windingRule: "NONZERO" }]
  });

  const noisyText = (id, chars, size) => ({
    id, name: "Text", type: "TEXT",
    absoluteBoundingBox: { x: 0, y: 0, width: 280, height: size * 1.4 },
    absoluteRenderBounds: { x: 0, y: 0, width: 280, height: size * 1.4 },
    characters: chars,
    style: {
      fontFamily: "Inter", fontPostScriptName: "Inter-Regular", fontWeight: 400, fontSize: size,
      textAlignHorizontal: "LEFT", textAlignVertical: "TOP", letterSpacing: 0,
      lineHeightPx: size * 1.4, lineHeightPercent: 100, lineHeightUnit: "INTRINSIC_%"
    },
    characterStyleOverrides: [], styleOverrideTable: {},
    lineTypes: ["NONE"], lineIndentations: [0],
    fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.12 }, a: 1 }],
    strokes: [], effects: [], blendMode: "PASS_THROUGH",
    constraints: { vertical: "TOP", horizontal: "LEFT" }
  });

  const noisyCard = (i) => ({
    id: "2:" + i, name: "Card", type: "FRAME",
    absoluteBoundingBox: { x: i * 320, y: 0, width: 300, height: 200 },
    absoluteRenderBounds: { x: i * 320, y: 0, width: 300, height: 200 },
    layoutMode: "VERTICAL", itemSpacing: 12,
    paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20,
    cornerRadius: 16, clipsContent: true, blendMode: "PASS_THROUGH",
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG",
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, a: 1 }],
    strokes: [], constraints: { vertical: "TOP", horizontal: "LEFT" },
    effects: [{
      type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.08 },
      offset: { x: 0, y: 4 }, radius: 12, spread: 0, blendMode: "NORMAL"
    }],
    children: [
      noisyVector("3:" + i),
      noisyText("4:" + i, "Feature " + i, 18),
      noisyText("5:" + i, "Some supporting body copy that explains the feature in a sentence.", 14)
    ]
  });

  const LANDING = {
    document: {
      id: "1:1", name: "Landing", type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      layoutMode: "HORIZONTAL", itemSpacing: 20,
      fills: [], strokes: [], effects: [],
      constraints: { vertical: "TOP", horizontal: "LEFT" },
      children: [0, 1, 2, 3, 4, 5].map(noisyCard)
    }
  };

  const bytes = (s) => Buffer.byteLength(s, "utf8");
  const rawBytes = bytes(JSON.stringify(LANDING));
  const jsxBytes = bytes(optimizeFigmaData(LANDING, { format: "jsx" }));
  const treeBytes = bytes(optimizeFigmaData(LANDING, { format: "tree" }));

  const jsxCut = 100 - (100 * jsxBytes) / rawBytes;
  const treeCut = 100 - (100 * treeBytes) / rawBytes;

  console.log(`       raw  ${rawBytes} B (~${Math.ceil(rawBytes / 4)} tok)`);
  console.log(`       jsx  ${jsxBytes} B (~${Math.ceil(jsxBytes / 4)} tok)  -${jsxCut.toFixed(1)}%`);
  console.log(`       tree ${treeBytes} B (~${Math.ceil(treeBytes / 4)} tok)  -${treeCut.toFixed(1)}%`);

  check("pseudo-JSX cuts at least 80% off a realistic REST payload", jsxCut >= 80, jsxCut.toFixed(1) + "%");
  check("tree format cuts at least 85%", treeCut >= 85, treeCut.toFixed(1) + "%");
  check("tree is the more compact of the two", treeBytes < jsxBytes, { treeBytes, jsxBytes });
}

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures ? 1 : 0);
