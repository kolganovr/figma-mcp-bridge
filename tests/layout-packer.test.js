// Contract test for the Layout Packer (§4.6 / §2.7 of the UX plan). Run:
// node tests/layout-packer.test.js
//
// Extracts the Layout Packer block out of the plugin and exercises it against
// plain node-like objects on a stub figma.currentPage — no Figma runtime
// needed, since these are pure functions over {x, y, width, height, visible}.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "figma-plugin", "code.js"), "utf8");

const startMarker = "// ==========================================================================\n// Layout Packer";
const endMarker = "// ==========================================================================\n// Component Index";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error("Layout Packer block not found");
const block = src.slice(start, end);

let node = (x, y, w, h) => ({ x, y, width: w, height: h, visible: true });

const figma = { currentPage: { children: [] } };

const load = new Function(
  "figma",
  block + "\n;return { getFreeCanvasPosition, getFreeCanvasPositionRow, getFreeCanvasPositionGrid, computeTopLevelBounds, buildCollisionGrid, autoPositionIfColliding };"
);
const { getFreeCanvasPosition, getFreeCanvasPositionRow, getFreeCanvasPositionGrid, computeTopLevelBounds, buildCollisionGrid, autoPositionIfColliding } = load(figma);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

console.log("\n== empty canvas ==");
figma.currentPage.children = [];
check("empty page places at origin", JSON.stringify(getFreeCanvasPosition(400, 800)) === JSON.stringify({ x: 0, y: 0 }));

console.log("\n== row placement (single axis, matches pre-existing behaviour) ==");
figma.currentPage.children = [node(0, 0, 400, 800)];
const posRight = getFreeCanvasPositionRow(400, 800, { gap: 80 });
check("places to the right of the single existing frame", posRight.x === 480 && posRight.y === 0, posRight);

figma.currentPage.children = [node(0, 0, 400, 800), node(480, 0, 400, 800)];
const posRight2 = getFreeCanvasPositionRow(400, 800, { gap: 80 });
check("steps past a second occupied slot", posRight2.x === 960, posRight2);

console.log("\n== grid placement (shelf packing) ==");
figma.currentPage.children = [];
const placed = [];
for (let i = 0; i < 9; i++) {
  const p = getFreeCanvasPositionGrid(300, 500, { gap: 40, columns: 3, bounds: computeTopLevelBounds() });
  // Simulate the frame actually landing there before the next placement call,
  // matching how the agent calls this once per created frame.
  const n = node(p.x, p.y, 300, 500);
  figma.currentPage.children.push(n);
  placed.push(p);
}

let anyOverlap = false;
for (let i = 0; i < placed.length; i++) {
  for (let j = i + 1; j < placed.length; j++) {
    const a = { ...placed[i], width: 300, height: 500 };
    const b = { ...placed[j], width: 300, height: 500 };
    if (overlaps(a, b)) anyOverlap = true;
  }
}
check("9 items in a 3-column grid never overlap", !anyOverlap, placed);

const uniqueRows = new Set(placed.map(p => p.y)).size;
check("9 items in a 3-column grid form 3 rows, not one long ribbon", uniqueRows === 3, placed);

const uniqueCols = new Set(placed.map(p => p.x)).size;
check("columns are reused across rows (compact, not ever-growing)", uniqueCols === 3, placed);

console.log("\n== collision grid (O(neighbours), not O(n)) ==");
figma.currentPage.children = [node(0, 0, 100, 100), node(1000, 1000, 100, 100)];
const grid = buildCollisionGrid(figma.currentPage.children);
check("detects a real collision", grid.collides(50, 50, 100, 100) === true);
check("clears far away from both existing nodes", grid.collides(500, 500, 100, 100) === false);
check("detects collision with the far node without touching the near one", grid.collides(1050, 1050, 100, 100) === true);

console.log("\n== autoPositionIfColliding ==");
figma.currentPage.children = [];
const anchor = node(0, 0, 200, 200);
anchor.parent = figma.currentPage;
figma.currentPage.children.push(anchor);
const mover = node(0, 0, 200, 200); // deliberately placed at (0,0), colliding with anchor
mover.parent = figma.currentPage;
figma.currentPage.children.push(mover);
autoPositionIfColliding(mover, 80);
check("collision at (0,0) is moved somewhere that doesn't overlap the anchor", !overlaps(mover, anchor), mover);

const settled = node(900, 900, 50, 50); // already clear of everything — must not move
settled.parent = figma.currentPage;
figma.currentPage.children.push(settled);
const before = { x: settled.x, y: settled.y };
autoPositionIfColliding(settled, 80);
check("a non-colliding, non-origin node is left alone", settled.x === before.x && settled.y === before.y, settled);

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures ? 1 : 0);
