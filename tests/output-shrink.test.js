// Pure-function contract for the 4.2.1 output path in figma/index.js. Run:
// node tests/output-shrink.test.js
//
// No server, no sockets: index.js only exports helpers when require()d. Covers
// line-wise shrinking of multi-line strings (the figma_inspect outline), the
// max_output_bytes ceiling, the pre-flight syntax check, error-location
// pass-through and the code figma_inspect generates for its newer arguments.
const path = require("path");
const { spawnSync } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "figma", "index.js");
const srv = require(SERVER_PATH);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 600) : "")); }
}

const json = (v) => JSON.stringify(v);
const bytes = (v) => Buffer.byteLength(json(v));

// ~100 bytes per line. `levels` = indent level per line, cycled after the root.
function outline(count, levels = [1]) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const lv = i === 0 ? 0 : levels[(i - 1) % levels.length];
    const body = `FRAME "Node ${i}" #9:${i} 320x200 @0,${i * 10} [V gap8 pad16] fill:#FFFFFF r8`;
    lines.push("  ".repeat(lv) + body.padEnd(100 - 2 * lv, "."));
  }
  return lines.join("\n");
}
const isNodeLine = (l) => /^ *FRAME "Node \d+" #9:\d+ 320x200 @0,\d+ \[V gap8 pad16\] fill:#FFFFFF r8\.*$/.test(l);

console.log("\n== multi-line strings shrink by whole lines ==");
{
  const o25 = outline(25);
  const r25 = srv.shrinkToBudget({ outline: o25 }, 3500);
  check("25 lines of ~100 bytes fit the 3500 budget untouched", r25.truncated === null && r25.value.outline === o25, r25.truncated);

  const o80 = outline(80);
  const r80 = srv.shrinkToBudget({ outline: o80 }, 3500);
  const lines80 = r80.value.outline.split("\n");
  const kept = lines80.length - 1;
  check("80 lines: result fits the budget", bytes(r80.value) <= 3500 && r80.truncated && r80.truncated.to <= 3500, r80.truncated);
  check("...most of the budget is used for lines (old behaviour kept ~500 bytes)", kept >= 25, kept);
  check("...every kept line is whole", lines80.slice(0, kept).every(isNodeLine), lines80.find(l => !isNodeLine(l)));
  check("...the last line names the count, the total and the offset to continue from",
    lines80[kept] === `… +${80 - kept} more lines (80 total) — pass offset=${kept}`, lines80[kept]);

  // levels: root, then cycle 1,2,3,3 -> dropping level 3 collapses pairs
  const oDeep = outline(70, [1, 2, 3, 3]);
  const rDeep = srv.shrinkToBudget({ outline: oDeep }, 3500);
  const deepLines = rDeep.value.outline.split("\n");
  check("deep outline: fits by collapsing runs of deep lines into one '… +N deeper' line each", bytes(rDeep.value) <= 3500 && deepLines.some(l => /^ {4}… \+3 deeper$/.test(l)), deepLines.slice(0, 6));
  const rMild = srv.shrinkToBudget({ outline: outline(40, [1, 2, 3, 3]) }, 3500);
  const mildLines = rMild.value.outline.split("\n");
  check("...the DEEPEST level goes first: level 2 stays while dropping level 3 is enough",
    bytes(rMild.value) <= 3500 && mildLines.some(l => /^ {6}… \+2 deeper$/.test(l)) && mildLines.filter(l => /^ {4}FRAME/.test(l)).length === 10, mildLines.slice(0, 5));
  check("...no line is cut mid-way and nothing needed the tail cut",
    deepLines.every(l => isNodeLine(l) || /^ +… \+\d+ deeper$/.test(l)) && !/more lines/.test(rDeep.value.outline), deepLines.find(l => !isNodeLine(l) && !/deeper$/.test(l)));
  check("...the root and the level-1 lines survive", isNodeLine(deepLines[0]) && /Node 1"/.test(deepLines[1]));

  // a very tight budget collapses further levels, still line-wise
  const rTight = srv.shrinkToBudget({ outline: oDeep }, 2000);
  check("tighter budget: level 2 collapses too ('    … +N deeper'), still whole lines",
    bytes(rTight.value) <= 2000 && rTight.value.outline.split("\n").every(l => isNodeLine(l) || /^ +… \+\d+ deeper$/.test(l) || /^… \+\d+ more lines/.test(l)), rTight.value.outline.slice(0, 300));

  // several roots: level 0 is all that is left after collapsing, then tail cut
  const many = Array.from({ length: 60 }, (_, i) => `FRAME "Root ${i}" #1:${i} 100x100 ` + ".".repeat(40) + "\n  child " + ".".repeat(60)).join("\n");
  const rMany = srv.shrinkToBudget({ outline: many }, 3500);
  const manyLines = rMany.value.outline.split("\n");
  check("several roots: children collapse to markers, roots stay whole", bytes(rMany.value) <= 3500 && manyLines.some(l => /^ {2}… \+1 deeper$/.test(l)), manyLines.slice(0, 4));

  const rTop = srv.shrinkToBudget(o80, 1000);
  check("a top-level multi-line string is cut by whole lines too", typeof rTop.value === "string" && byteLenOf(rTop.value) <= 1000 && /pass offset=\d+$/.test(rTop.value), rTop.value.slice(-90));

  const rTiny = srv.shrinkToBudget({ outline: o80 }, 120);
  check("only when not even the first line fits is a line cut", bytes(rTiny.value) <= 120 || typeof rTiny.value === "string", rTiny);
}

function byteLenOf(s) { return Buffer.byteLength(json(s)); }

console.log("\n== the rest of the value gets its share first ==");
{
  const value = { name: "x".repeat(30), rows: Array.from({ length: 100 }, (_, i) => ({ id: i })), outline: outline(30) };
  const r = srv.shrinkToBudget(value, 3500);
  check("an object with a big array and an outline: fits, and the outline is not reduced to one line",
    bytes(r.value) <= 3500 && r.value.outline.split("\n").length > 5, r.value.outline.split("\n").length);
  const two = srv.shrinkToBudget({ a: outline(40), b: "one\ntwo" }, 3500);
  check("a short multi-line string next to a long one stays whole", two.value.b === "one\ntwo" && bytes(two.value) <= 3500, two.value.b);
  check("single-line strings still use the per-level character cut",
    srv.shrinkToBudget({ s: "y".repeat(5000) }, 1000).value.s.endsWith("chars)"));
}

console.log("\n== paging with offset ==");
{
  const o80 = outline(80);
  const paged = srv.applyLineOffset({ outline: o80 }, 30);
  const lines = paged.outline.split("\n");
  check("applyLineOffset drops the first N lines and marks it", lines[0] === "… lines 0–29 skipped" && lines[1] === o80.split("\n")[30] && lines.length === 51, lines.slice(0, 2));
  check("...also for `found`, leaves other fields and single-line strings alone",
    srv.applyLineOffset({ found: o80, props: { a: 1 } }, 2).found.startsWith("… lines 0–1 skipped\n") &&
    srv.applyLineOffset({ found: "no matches" }, 5).found === "no matches" && srv.applyLineOffset({ outline: o80 }, 0).outline === o80);
  const shrunk = srv.shrinkToBudget({ outline: paged.outline }, 1500);
  const sl = shrunk.value.outline.split("\n");
  const last = sl[sl.length - 1];
  const first = Number(/offset=(\d+)$/.exec(last)[1]);
  check("shrinking a paged outline keeps the header and numbers the next offset from ORIGINAL lines",
    sl[0] === "… lines 0–29 skipped" && /\(80 total\)/.test(last) && first === 30 + (sl.length - 2) && new RegExp(`Node ${first - 1}"`).test(sl[sl.length - 2]), { first, last, n: sl.length });
}

console.log("\n== grid shrink keeps the most that fits ==");
{
  // Shape of session e6524905 step #107: 6 keys x 6 objects x 7 keys, 4444 bytes -> was cut to 651.
  const cells = (p) => Array.from({ length: 6 }, (_, i) => ({ name: "ячейки таблицы", w: 100 + i, text: "Фамилия Имя " + p + i, grow: 0, sizing: "FIXED", cb: null, idx: i }));
  const v = { b1366_headers: cells("h"), b1366_cells: cells("c"), b768_headers: cells("h"), b768_cells: cells("c"), b360_headers: cells("h"), b360_cells: cells("c") };
  const full = Buffer.byteLength(JSON.stringify(v));
  const r = srv.shrinkToBudget(v, 3000);
  check("grid: uses most of the budget (was ~15% with fixed levels)", r.truncated.to <= 3000 && r.truncated.to >= 2000, { full, to: r.truncated.to });
  check("grid: objects keep their fields instead of '{object with N keys}'", typeof r.value.b1366_headers[0] === "object" && r.value.b1366_headers[0].text === "Фамилия Имя h0", r.value.b1366_headers[0]);
  const small = srv.shrinkToBudget(v, 100000);
  check("grid: a value that fits is untouched", small.truncated === null && small.value === v);
}

console.log("\n== read nudge (use_instead) ==");
{
  // Scripts shaped like the ones Antigravity wrote in session e6524905.
  const READ_SECTIONS = `const ref = await figma.getNodeByIdAsync("157:140133");
const target = await figma.getNodeByIdAsync("161:24484");
function inspectSection(s) { return { id: s.id, children: (s.children || []).map(c => ({ id: c.id, x: Math.round(c.x),
  sub: c.children ? c.children.map(sc => ({ id: sc.id, w: Math.round(sc.width) })) : [] })) }; }
return { ref: inspectSection(ref), target: inspectSection(target) };`;
  const READ_TABLE = `const b = await figma.getNodeByIdAsync("194:85088");
const headers = b.findOne(n => n.name === 'Заголовки');
return headers.children.map(cell => ({ name: cell.name, w: cell.width, text: (cell.findOne(t => t.type === 'TEXT') || {}).characters }));`;
  const READ_FONT = `const n = await figma.getNodeByIdAsync("194:84942"); return { fontName: n.fontName, size: n.fontSize };`;
  const READ_CB = `const n = await figma.getNodeByIdAsync("194:85120"); const cb = n.findAll(x => x.name === 'checkbox' && x.type === 'INSTANCE');
return cb.map(c => c.componentProperties);`;
  const STASH = "return bridge.state.lastResult.targetItems.slice(10);";
  const WRITE_MOVE = `const s = await figma.getNodeByIdAsync("161:24484"); for (const c of s.children) { c.x += 100; } return s.children.length;`;
  const WRITE_SECTION = "const s1 = figma.createSection(); s1.name = 'test'; s1.remove(); return true;";
  const WRITE_SETPROPS = `const n = await figma.getNodeByIdAsync("1:2"); n.findAll(x => x.name === 'checkbox').forEach(c => c.setProperties({ State: 'Disabled' }));`;
  const CHEAP = `return bridge.summarize("1:2", { depth: 2 });`;

  const kinds = [READ_SECTIONS, READ_TABLE, READ_FONT, READ_CB, STASH, WRITE_MOVE, WRITE_SECTION, WRITE_SETPROPS, CHEAP].map(c => srv.classifyScript(c));
  check("classify: reads, stash slicing, writes (+=, create, setProperties), bridge helper reads",
    JSON.stringify(kinds) === JSON.stringify(["read", "read", "read", "read", "stash", "write", "write", "write", "cheap"]), kinds);
  check("classify: a script that created/modified nodes is a write whatever its text",
    srv.classifyScript(READ_FONT, { created: ["9:9"] }) === "write" && srv.classifyScript(READ_FONT, { modified: ["9:9"] }) === "write");
  check("classify: comparisons are not assignments", srv.classifyScript(`const n = figma.getNodeById("1:2"); return n.name === 'a' && n.x == 3 && n.y >= 0;`) === "read");

  const s1 = srv.suggestInspect(READ_SECTIONS);
  check("suggest: section walk -> both ids, outline depth from the nesting", JSON.stringify(s1) === JSON.stringify({ node_ids: ["157:140133", "161:24484"], depth: 2 }), s1);
  const s2 = srv.suggestInspect(READ_TABLE);
  check("suggest: a walk into table headers/rows -> view:table for the screen",
    JSON.stringify(s2) === JSON.stringify({ node_ids: ["194:85088"], view: "table" }), s2);
  // #38: a page header is not a table header; node_id / ids are node_ids
  const T7H = srv.suggestInspect(`const frame = await figma.getNodeByIdAsync("20:2"); const header = frame.children.find(c => c.name === 'Header'); return header.children.map(c => c.name);`);
  check("suggest (#38): `const header = ...` + .children does not become view:table", !T7H || T7H.view !== "table", T7H);
  const T8H = srv.suggestInspect(`const t = await figma.getNodeByIdAsync("20:2"); const header = t.children[0]; return header.children.map(c => c.name) + t.children[1].children.length + ' rows';`);
  check("suggest (#38): header together with rows still reads as a table", T8H && T8H.view === "table", T8H);
  const specIds = c => JSON.parse(/^const a = (.*);$/m.exec(c)[1]).ids;
  check("inspect (#38): node_id and ids behave like node_ids",
    JSON.stringify(specIds(srv.buildInspectCode({ node_id: "1-2" }))) === JSON.stringify(["1:2"]) && JSON.stringify(specIds(srv.buildInspectCode({ ids: ["1:2", "3:4"] }))) === JSON.stringify(["1:2", "3:4"]) &&
    srv.buildInspectCode({ node_id: "1:2" }) === srv.buildInspectCode({ node_ids: ["1:2"] }));
  const inspectProps38 = srv.TOOLS.find(t => t.name === "figma_inspect").inputSchema.properties;
  check("inspect (#38): schema names the aliases", inspectProps38.node_id.type === "string" && inspectProps38.ids.type === "array");
  const s2b = srv.suggestInspect(`const n = await figma.getNodeByIdAsync("5:5"); const f = n.findOne(x => x.name === 'Футер'); return f.children.map(c => c.name);`);
  check("suggest: findOne of a non-table layer -> find + depth", JSON.stringify(s2b) === JSON.stringify({ node_ids: ["5:5"], find: "Футер", depth: 2 }), s2b);
  const s3 = srv.suggestInspect(READ_FONT);
  check("suggest: font read on an id -> its own outline line (font is on it), not props", JSON.stringify(s3) === JSON.stringify({ node_ids: ["194:84942"], depth: 0 }), s3);
  const s3b = srv.suggestInspect(`const n = await figma.getNodeByIdAsync("1:2"); return [n.layoutGrow, n.constraints];`);
  check("suggest: props the outline lacks on an id -> props", JSON.stringify(s3b) === JSON.stringify({ node_ids: ["1:2"], props: ["layoutGrow", "constraints"] }), s3b);
  const s4 = srv.suggestInspect(READ_CB);
  check("suggest: find + type + componentProperties -> find, find_type, props:[props]",
    JSON.stringify(s4) === JSON.stringify({ node_ids: ["194:85120"], find: "checkbox", find_type: "INSTANCE", props: ["props"] }), s4);
  check("suggest: URL-style ids are normalised, instance ids kept",
    JSON.stringify(srv.suggestInspect(`figma.getNodeById("161-24484"); figma.getNodeById("I194:85094;160:147835").children`).node_ids) === JSON.stringify(["161:24484", "I194:85094;160:147835"]));
  check("suggest: no ids -> canvas map", JSON.stringify(srv.suggestInspect("return figma.currentPage.children.map(c => c.name);")) === JSON.stringify({ view: "map" }));

  srv.READ_STATE.streak = 0; srv.READ_STATE.total = 0; srv.READ_STATE.lastIds = []; srv.READ_STATE.lastArgs = null; srv.READ_STATE.capsShown = false;
  const n1 = srv.readNudge(READ_SECTIONS, {});
  check("nudge #1: a ready call with the script's ids, the count, and (once) the other modes",
    n1.startsWith('figma_inspect {"node_ids":["157:140133","161:24484"],"depth":2}') && /read #1 in a row/.test(n1) && /find_text/.test(n1), n1);
  const n2 = srv.readNudge(STASH, {});
  check("nudge on lastResult slicing reuses the last read's ids, says why, no repeated mode list",
    n2.startsWith('figma_inspect {"node_ids":["157:140133","161:24484"],"depth":2}') && /slicing bridge\.state\.lastResult/.test(n2) && /#2 in a row/.test(n2) && !/find_text/.test(n2), n2);
  const n3 = srv.readNudge(READ_FONT, {});
  check("nudge #3 adds the plan: one inspect, then ONE write call", /#3 in a row/.test(n3) && /ONE figma_execute_code/.test(n3), n3);
  check("nudge stays small (< 600 bytes after the first)", Buffer.byteLength(n3) < 600, Buffer.byteLength(n3));
  check("writes and cheap reads get no nudge; a write resets the streak",
    srv.readNudge(CHEAP, {}) === null && srv.readNudge(WRITE_MOVE, {}) === null && srv.READ_STATE.streak === 0);
  srv.readNudge(READ_FONT, {}); srv.resetReadStreak();
  check("figma_inspect resets the streak", srv.READ_STATE.streak === 0 && srv.READ_STATE.total === 4);

  const env = JSON.parse(srv.buildStructuredResult(
    { result: { rows: Array.from({ length: 150 }, (_, i) => ({ id: "1:" + i, name: "Row " + i, w: 100 + i })) }, resultStashed: true, checkpointId: null },
    null, { maxOutputBytes: 3500, lead: { use_instead: n3 } }));
  check("envelope: use_instead comes right after ok, before result", Object.keys(env).slice(0, 3).join() === "ok,use_instead,result", Object.keys(env));
  check("envelope: a cut read points at the use_instead call, not at slicing lastResult",
    /use_instead call/.test(env.truncated) && !/slice\(40, 80\)/.test(env.truncated), env.truncated);
  check("envelope with nudge still fits the byte budget", Buffer.byteLength(JSON.stringify(env)) <= 3500, Buffer.byteLength(JSON.stringify(env)));
  srv.READ_STATE.streak = 0; srv.READ_STATE.total = 0; srv.READ_STATE.lastIds = []; srv.READ_STATE.lastArgs = null; srv.READ_STATE.capsShown = false;
}

console.log("\n== ceiling ==");
{
  check("default ceiling is 3900", srv.ECONOMY.outputCeiling === 3900, srv.ECONOMY.outputCeiling);
  const c = srv.outputBudgetInfo({ max_output_bytes: 5000 });
  check("5000 -> 3900 with a note", c.bytes === 3900 && /^max_output_bytes capped at 3900: a bigger reply is written to a file .*offset.*bridge\.state\.lastResult/.test(c.capNote), c);
  check("unknown client: explicit 0 is capped too (it would spill)", srv.outputBudgetInfo({ max_output_bytes: 0 }).bytes === 3900 && !!srv.outputBudgetInfo({ max_output_bytes: 0 }).capNote);
  srv.MCP_CLIENT.name = "Antigravity";
  check("Antigravity: ceiling on", srv.activeOutputCeiling() === 3900 && srv.outputBudgetInfo({ max_output_bytes: 8000 }).bytes === 3900);
  srv.MCP_CLIENT.name = "claude-code";
  check("non-spilling client (claude-code): no ceiling, 0 and 8000 honoured", srv.activeOutputCeiling() === 0 && srv.outputBudgetInfo({ max_output_bytes: 0 }).bytes === 0 && srv.outputBudgetInfo({ max_output_bytes: 8000 }).bytes === 8000);
  check("non-spilling client: truncation note offers raising the budget", /raise max_output_bytes/.test(srv.truncationNote({ from: 9000, to: 3000 }, true)));
  srv.MCP_CLIENT.name = null;
  const tn = srv.truncationNote({ from: 9000, to: 3000 }, true);
  check("spilling client: truncation note shows a lastResult slice and never suggests 0 / raising", /lastResult\.slice\(40, 80\)/.test(tn) && !/no cap|raise max_output_bytes/.test(tn), tn);
  check("values at or under the ceiling and the default are left alone",
    srv.outputBudgetInfo({ max_output_bytes: 3900 }).capNote === null && srv.outputBudgetInfo({ max_output_bytes: 2000 }).bytes === 2000 && srv.outputBudgetInfo({}).bytes === 3500);
  check("max_output_chars is clamped like max_output_bytes", srv.outputBudgetInfo({ max_output_chars: 8000 }).bytes === 3900);
  const env = (extra) => spawnSync(process.execPath, ["-e",
    `const s=require(${JSON.stringify(SERVER_PATH)});process.stdout.write(JSON.stringify([s.outputBudgetInfo({max_output_bytes:5000}).bytes,s.outputBudgetInfo({max_output_bytes:0}).bytes]))`],
    { env: { ...process.env, ...extra }, encoding: "utf-8" });
  check("FIGMA_MCP_MAX_OUTPUT_CEILING=0 removes the ceiling", env({ FIGMA_MCP_MAX_OUTPUT_CEILING: "0" }).stdout === "[5000,0]", env({ FIGMA_MCP_MAX_OUTPUT_CEILING: "0" }).stdout);
  check("FIGMA_MCP_MAX_OUTPUT_CEILING=4200 moves it", env({ FIGMA_MCP_MAX_OUTPUT_CEILING: "4200" }).stdout === "[4200,4200]", env({ FIGMA_MCP_MAX_OUTPUT_CEILING: "4200" }).stdout);
  const env4 = buildEnvelopeCheck();
  check("the cap note is part of the envelope and the whole envelope respects the ceiling", env4.ok, env4.detail);
}

function buildEnvelopeCheck() {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: "1:" + i, name: "Row " + i }));
  const info = srv.outputBudgetInfo({ max_output_bytes: 5000 });
  const text = srv.buildStructuredResult({ result: { rows, outline: outline(80) } }, null, { maxOutputBytes: info.bytes, capNote: info.capNote });
  const body = JSON.parse(text);
  return { ok: Buffer.byteLength(text) <= 3900 && body.note === info.capNote, detail: Buffer.byteLength(text) };
}

console.log("\n== syntax check before the plugin ==");
{
  const catchErr = (code) => { try { srv.checkAgentSyntax(code); return null; } catch (e) { return e; } };
  const e3 = catchErr("const a = 1;\nconst b = 2;\n   const c = ;\nreturn a;");
  check("an error on the 3rd line reports line 3 (lineOffset -1 maps to the agent's own numbering)", e3 && e3.code === "SCRIPT_SYNTAX_ERROR" && e3.line === 3, e3 && e3.line);
  check("...and that line, trimmed", e3 && e3.at === "const c = ;", e3 && e3.at);
  const e1 = catchErr("const = 1;");
  check("an error on line 1 reports line 1", e1 && e1.line === 1, e1 && e1.line);
  const long = catchErr("const s = 'a';\n" + "x".repeat(300) + " = = 1;");
  check("`at` is cut to 160 characters", long && long.line === 2 && long.at.length === 160, long && long.at && long.at.length);
  check("message carries the async-function-body hint", e3 && /HINT: Your code is compiled as an async function body: top-level await and return are allowed, import\/export are not/.test(e3.message));
  check("valid code passes: top-level await, return, the sandbox globals",
    catchErr("const n = figma.currentPage.name;\nawait ensureFont('Inter', 'Regular');\nbridge.state.x = 1; notify('a'); log('b'); progress(1); getFreePosition(1, 2); getFreeCanvasPosition(1, 2);\nreturn n;") === null);
  check("import / export are refused", catchErr("import a from 'b';") !== null && catchErr("export const a = 1;") !== null);
  check("a non-string `code` is left to the plugin", catchErr(undefined) === null);
  const env = srv.buildErrorEnvelope(e3);
  check("buildErrorEnvelope carries code, line and at", env.ok === false && env.code === "SCRIPT_SYNTAX_ERROR" && env.line === 3 && env.at === "const c = ;" && !("column" in env), env);
  const plug = srv.buildErrorEnvelope(Object.assign(new Error("boom"), { code: "X", line: 9, column: 4, at: "foo();" }));
  check("plugin failures pass line / column / at through", plug.line === 9 && plug.column === 4 && plug.at === "foo();", plug);
  check("...and are absent when the plugin sent none", !("line" in srv.buildErrorEnvelope(new Error("plain"))));
}

console.log("\n== figma_inspect generated code ==");
{
  const specOf = (code) => JSON.parse(/^const a = (.*);$/m.exec(code)[1]);
  const base = srv.buildInspectCode({ node_ids: ["1-2"] });
  check("default: an outline over bridge.summarize, spec has no view/context/findText",
    /bridge\.summarize\(refs, so\)/.test(base) && specOf(base).view === null && specOf(base).context === false && specOf(base).findText === null, specOf(base));
  const map = srv.buildInspectCode({ node_ids: ["1:2"], view: "map", depth: 2 });
  check("view: 'map' -> summarize(refs, { depth, view: 'map' })", specOf(map).view === "map" && specOf(map).depth === 2 && /if \(a\.view === 'map'\) so\.view = 'map';/.test(map) && /if \(a\.depth !== null\) so\.depth = a\.depth;/.test(map), map);
  check("view: 'outline' is the default (no view sent)", specOf(srv.buildInspectCode({ view: "outline" })).view === null);
  const ctx = srv.buildInspectCode({ node_ids: ["1:2", "3:4"], context: true });
  check("context: true -> out.context[id] = bridge.context(id) as one-line strings, for every ref", specOf(ctx).context === true && /const c = bridge\.context\(id\);/.test(ctx) && /out\.context\[id\] = \{ node:/.test(ctx) && /"ids":\["1:2","3:4"\]/.test(ctx), ctx);
  const ft = srv.buildInspectCode({ node_ids: ["1:2"], find_text: "Купить", limit: 5, find_type: "text" });
  check("find_text -> bridge.find(query, { root, limit, text: true }) per root",
    specOf(ft).findText === "Купить" && specOf(ft).limit === 5 && specOf(ft).type === "TEXT" && /const query = a\.findText \|\| a\.find;/.test(ft) &&
    /if \(a\.findText\) opts\.text = true;/.test(ft) && /if \(root\) opts\.root = root;/.test(ft) && /bridge\.find\(query, opts\)/.test(ft), ft);
  const fnd = srv.buildInspectCode({ find: "Button" });
  check("find (names) is unchanged: no text flag in the spec, results under `found`",
    specOf(fnd).find === "Button" && specOf(fnd).findText === null && /out\[query \? 'found' : a\.view === 'flow' \? 'flow' : 'outline'\]/.test(fnd));
  const pr = srv.buildInspectCode({ node_ids: ["1:2"], props: ["reactions", "connector"] });
  check("props: reactions / connector go to bridge.inspect", specOf(pr).props.join() === "reactions,connector" && /bridge\.inspect\(refs, a\.props\)/.test(pr));
  check("all generated variants are valid JS function bodies", [base, map, ctx, ft, fnd, pr, srv.buildInspectCode({ check: { "1:2": { width: 1 } } })].every(c => {
    try { srv.checkAgentSyntax(c); return true; } catch (e) { return false; }
  }));
}

console.log("\n== defaults and metadata ==");
{
  check("maxImages defaults to 4", srv.ECONOMY.maxImages === 4, srv.ECONOMY.maxImages);
  const desc = srv.TOOLS.find(t => t.name === "figma_execute_code").description;
  check("execute_code lists the macros", ["replaceWithInstance", "setProps", "setText", "shift", "moveInto", "fitSection", "context"].every(m => desc.includes("bridge." + m)), desc.slice(-500));
  check("server instructions stay within the ~2000-char cut and mention the macros",
    srv.SERVER_INSTRUCTIONS.length <= 2000 && /replaceWithInstance/.test(srv.SERVER_INSTRUCTIONS), srv.SERVER_INSTRUCTIONS.length);
  // #41: the rules added to the descriptions must not turn them into manuals
  // (each description is re-sent on every turn).
  const lens = srv.TOOLS.map(t => [t.name, t.description.length]);
  check("every tool description stays <= 2400 chars", lens.every(([, n]) => n <= 2400), lens.filter(([, n]) => n > 2000));
  check("all tool descriptions together stay <= 9000 chars", lens.reduce((a, [, n]) => a + n, 0) <= 9000, lens.reduce((a, [, n]) => a + n, 0));
  const insp = srv.TOOLS.find(t => t.name === "figma_inspect").description;
  check("inspect decodes a:start/center (start = MIN, end = MAX)", /primaryAxisAlignItems\/counterAxisAlignItems/.test(insp) && /start = MIN/.test(insp) && /end = MAX/.test(insp));
  check("inspect: compare gives REF lines for the write", /compare[^.]*REF lines/.test(insp));
  check("execute_code: setText is the way for mixed styles, no characters = / getRangeFontName loop", /bridge\.setText\(textNode, 'new text'\)/.test(desc) && /never `characters =`/.test(desc) && /getRangeFontName/.test(desc));
  check("use_instead caps note mentions like and compare", /like:'<ref id>'/.test(srv.CAPS_NOTE || "") && /compare:'<ref id>'/.test(srv.CAPS_NOTE || ""));
}

console.log("\n== 4.2.5: read guard, page scans, componentize, validation errors, stalled jobs ==");
{
  const fs = require("fs");
  const reset = () => { srv.READ_STATE.streak = 0; srv.READ_STATE.redirects = 0; srv.READ_STATE.total = 0; srv.READ_STATE.lastIds = []; srv.READ_STATE.lastArgs = null; srv.READ_STATE.capsShown = false; };
  const READ_A = `const n = await figma.getNodeById("194:84942"); return { fontName: n.fontName, size: n.fontSize };`;
  const READ_B = `const n = await figma.getNodeById("194:85120"); return n.children.map(c => c.name);`;
  const WRITE = `const n = await figma.getNodeById("1:2"); n.x += 10; return true;`;

  reset();
  check("guard: first read runs (nudge only)", srv.readGuard(READ_A) === null);
  srv.readNudge(READ_A, {});
  const g2 = srv.readGuard(READ_B);
  check("guard: 2nd read in a row is redirected to figma_inspect", g2 && g2.type === "redirect" && /^figma_inspect \{/.test(g2.call) && /194:85120/.test(g2.call), g2);
  const g3 = srv.readGuard(READ_B);
  check("guard: 3rd read in a row is refused without a result", g3 && g3.type === "refuse", g3);
  const refusal = srv.guardRefusal(g3);
  const rb = JSON.parse(refusal.content[0].text);
  check("refusal: isError, READ_REFUSED, names the call and the run-anyway escape, no result",
    refusal.isError === true && rb.code === "READ_REFUSED" && /figma_inspect/.test(rb.use_instead) && /run-anyway/.test(rb.error) && !("result" in rb), rb);
  check("guard: /* run-anyway */ lifts it", srv.readGuard(READ_B + " /* run-anyway */") === null);
  check("guard: writes and cheap reads are never held", srv.readGuard(WRITE) === null && srv.readGuard(`return bridge.summarize("1:2", { depth: 2 });`) === null);
  srv.resetReadStreak();
  check("guard: figma_inspect / write resets the chain", srv.READ_STATE.streak === 0 && srv.READ_STATE.redirects === 0 && srv.readGuard(READ_A) === null);

  reset();
  check("pageWideScan: figma.currentPage.findAll", srv.pageWideScan(`return figma.currentPage.findAll(n => n.reactions.length).length;`) === "findAll");
  check("pageWideScan: figma.root.findOne and aliased page", srv.pageWideScan(`figma.root.findOne(n => n.name === 'x')`) === "findAll" && srv.pageWideScan(`const page = figma.currentPage; return page.findAll(n => true);`) === "findAll");
  check("pageWideScan: a section's findAll is fine", srv.pageWideScan(`const s = await figma.getNodeByIdAsync("1:2"); return s.findAll(n => n.type === 'TEXT');`) === null);
  check("pageWideScan: walk of the page over reactions", srv.pageWideScan(`function walk(n){ if (n.reactions.length) out.push(n.id); (n.children||[]).forEach(walk); } walk(figma.currentPage);`) === "reactions");
  check("pageWideScan: selection alias is not the page", srv.pageWideScan(`const sel = figma.currentPage.selection; return sel.length;`) === null);

  const heavy = srv.readGuard(`return figma.currentPage.findAll(n => n.name === 'Sheet').map(n => n.id);`);
  check("guard: a page-wide READ is refused before it runs, with the scoped call", heavy && heavy.type === "heavy" && /figma_inspect/.test(heavy.call) && /Sheet/.test(heavy.call), heavy);
  const hb = JSON.parse(srv.guardRefusal(heavy).content[0].text);
  check("heavy refusal: PAGE_SCAN_BLOCKED and explains section scoping", hb.code === "PAGE_SCAN_BLOCKED" && /section/.test(hb.error), hb);
  const heavyR = srv.readGuard(`const out=[]; function walk(n){ if (n.reactions && n.reactions.length) out.push(n.id); for (const c of n.children||[]) walk(c); } walk(figma.currentPage); return out;`);
  check("guard: reactions walk -> view:flow or map suggestion", heavyR && heavyR.type === "heavy" && /view/.test(heavyR.call), heavyR);
  check("guard: a page-wide WRITE is not held", srv.readGuard(`figma.currentPage.findAll(n => n.name === 'x').forEach(n => n.remove());`) === null);
  reset();

  const rw = srv.rewriteComponentize(`const c = figma.createComponentFromNode(frame); const d = figma.createComponentFromNode (other);`);
  check("componentize: rewritten to bridge.componentize, lint says how many",
    rw.code === `const c = bridge.componentize(frame); const d = bridge.componentize(other);` && /2×/.test(rw.lint) && /bridge\.componentize/.test(rw.lint), rw);
  check("componentize: untouched code gives no lint", srv.rewriteComponentize("return 1;").lint === null && srv.rewriteComponentize("return bridge.componentize(n);").code === "return bridge.componentize(n);");

  // H3: macro guard (bench T3)
  const peek = srv.macroGuard(`return bridge.openOverlay.toString();`);
  check("macroGuard: macro source read -> signature, not run", peek && peek.type === "peek" && peek.body.not_run === true && /BOTTOM_CENTER/.test(peek.body.signatures.openOverlay) && Object.keys(peek.body.signatures).length === 1, peek);
  const peekAll = srv.macroGuard(`return { has: typeof bridge.openOverlay === 'function', keys: Object.keys(bridge) };`);
  check("macroGuard: typeof + Object.keys(bridge) -> signature + info pointer", peekAll && peekAll.type === "peek" && peekAll.body.signatures.openOverlay && /bridge\.info\(\)/.test(peekAll.body.note), peekAll);
  const pc = srv.macroGuard(`return typeof bridge.componentize;`);
  check("macroGuard (H4): componentize peek -> signature with the id change", pc && pc.type === "peek" && /id CHANGES/.test(pc.body.signatures.componentize), pc);
  const rIds = srv.resultIds([1, 2, 3, 4, 5, 6].map(i => ({ oldId: "12:99" + i, newId: "12:98" + i })));
  check("resultIds (H4): all twelve ids of six old/new pairs, in order", rIds.length === 12 && rIds[1] === "12:981" && rIds[11] === "12:986", rIds);
  // H5: font loads memoized, prelude on the script's first line
  const memo = srv.withFontMemo(`const t = await figma.getNodeByIdAsync("1:2");\nawait figma.loadFontAsync(t.fontName);`);
  check("withFontMemo (H5): prefix on the same line, line count unchanged", memo.startsWith(srv.FONT_MEMO_PRELUDE + "const t") && memo.split("\n").length === 2, memo.slice(0, 80));
  check("withFontMemo: code without loadFontAsync untouched", srv.withFontMemo("return 1;") === "return 1;");
  // #37: ensureFont in a loop (16 calls) gets the prelude and loads each family|style once
  const efCode = "for (let i = 0; i < 16; i++) await ensureFont(i % 2 ? 'Oswald' : 'Inter', i % 2 ? 'Light' : 'Medium');\nawait ensureFont();\nreturn 1;";
  const efMemo = srv.withFontMemo(efCode);
  check("withFontMemo (#37): code with ensureFont gets the prelude, line count unchanged", efMemo.startsWith(srv.FONT_MEMO_PRELUDE) && efMemo.split("\n").length === 3, efMemo.slice(0, 60));
  const efCalls = [];
  const efReal = async (family, style) => { efCalls.push(String(family) + "|" + String(style)); };
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  AsyncFn("figma", "ensureFont", efMemo)({ loadFontAsync: async () => {} }, efReal).then(r => {
    check("withFontMemo (#37): 16 ensureFont calls load each font once (+ the default one)", r === 1 && efCalls.length === 3 && efCalls.slice().sort().join() === "Inter|Medium,Oswald|Light,undefined|undefined", efCalls);
  });
  const stripped = srv.stripFontMemo({ error: "boom\n  at line 1: " + srv.FONT_MEMO_PRELUDE + "const t = x;" });
  check("stripFontMemo: the prelude never reaches the agent", stripped.error === "boom\n  at line 1: const t = x;", stripped.error);
  check("withFontMemo: prelude parses as a script body", (() => { try { new (Object.getPrototypeOf(async function () {}).constructor)("figma", memo); return true; } catch (e) { return e.message; } })() === true);
  check("macroGuard: String(bridge.setReaction) answered", (srv.macroGuard(`return String(bridge.setReaction);`) || {}).type === "peek");
  check("macroGuard: unknown helper or plain code runs", srv.macroGuard(`return bridge.foo.toString();`) === null && srv.macroGuard(`return bridge.info().reactions;`) === null && srv.macroGuard(`return 1;`) === null);
  check("macroGuard: a write that names the macro runs", srv.macroGuard(`return await bridge.openOverlay('1:2', '1:3', { dim: 0.4 });`) === null);
  const look = srv.macroGuard(`const b = await figma.getNodeByIdAsync('10:1975'); const o = await figma.getNodeByIdAsync('10:1999'); o.overlayPositionType = 'BOTTOM_CENTER'; return true;`);
  check("macroGuard: overlay look write refused with openOverlay call on the script's ids",
    look && look.type === "overlay" && look.body.code === "USE_OPEN_OVERLAY" && /READ-ONLY/.test(look.body.error) && /bridge\.openOverlay\("10:1975", "10:1999"/.test(look.body.use_instead), look);
  const raw = srv.macroGuard(`const b = figma.getNodeById("10:2009"); b.reactions = [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "10:2033", navigation: "OVERLAY", transition: null }] }];`);
  check("macroGuard: hand-built OVERLAY reaction refused", raw && raw.type === "overlay" && /hand-built/.test(raw.body.error), raw);
  // Argon #18: the frame whose look is set / the destinationId is the overlay, never the trigger
  check("overlayCall: look write on one frame -> it is the overlay (2nd arg)", /openOverlay\(triggerId, "15:22150"/.test(srv.overlayCall(`const o = await figma.getNodeByIdAsync('15:22150'); o.overlayPositionType = 'BOTTOM_CENTER';`)), srv.overlayCall(`const o = await figma.getNodeByIdAsync('15:22150'); o.overlayPositionType = 'BOTTOM_CENTER';`));
  check("overlayCall: raw reaction -> node is trigger, destinationId is overlay", /openOverlay\("10:2009", "10:2033"/.test(raw.body.use_instead), raw.body.use_instead);
  // Argon #23: done is self-contained even when the script drops the macro's MANUAL STEP text
  const od = srv.overlayDone(`await bridge.openOverlay('21:2062', '21:2086', { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }); return 'ok';`);
  check("overlayDone: names both ids, the wanted look, says MANUAL STEP and not to re-check", /#21:2062 opens overlay #21:2086/.test(od) && /BOTTOM_CENTER/.test(od) && /40%/.test(od) && /clicking outside/.test(od) && /MANUAL STEP/.test(od) && /Don't re-check/.test(od), od);
  // #39: ids kept in variables (h13 T3#3 08732f9d) come from the macro's own result
  const VAR_CODE = `const btnId = '21:2062'; const sheetId = '21:2086'; const r = await bridge.openOverlay(btnId, sheetId, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }); return r;`;
  check("overlayIds (#39): literals win; variables -> response.modified [trigger, overlay]; no macro -> null",
    JSON.stringify(srv.overlayIds(`await bridge.openOverlay('1:2', '3:4', {});`, null)) === JSON.stringify(["1:2", "3:4"]) &&
    JSON.stringify(srv.overlayIds(VAR_CODE, { modified: ["21:2062", "21:2086"] })) === JSON.stringify(["21:2062", "21:2086"]) &&
    srv.overlayIds(VAR_CODE, { modified: ["21:2062"] }) === null && srv.overlayIds("return 1;", { modified: ["1:1", "2:2"] }) === null);
  const odv = srv.overlayDone(VAR_CODE, ["21:2062", "21:2086"]);
  check("overlayDone (#39): with ids from the result names both and the wanted look", /#21:2062 opens overlay #21:2086/.test(odv) && /BOTTOM_CENTER/.test(odv) && /40%/.test(odv), odv);
  const scr = srv.buildInspectCode({ node_ids: ["1:2", "3:4"], view: "flow", screens: true });
  check("inspect (#39): screens:true -> the flow is built for the top-level screens of the ids", JSON.parse(/^const a = (.*);$/m.exec(scr)[1]).screens === true && /tops\.push\(n\.id\)/.test(scr), scr.slice(0, 200));
  srv.OVERLAY_LINKED.set("21:2086", "21:2062");
  const again = srv.macroGuard(`const t = await figma.getNodeByIdAsync('21:2086'); t.overlayPositionType = 'BOTTOM_CENTER'; return t.overlayPositionType;`);
  check("macroGuard: look write on an overlay openOverlay already linked -> OVERLAY_ALREADY_LINKED with done, not run", again && again.body.code === "OVERLAY_ALREADY_LINKED" && again.body.not_run === true && /MANUAL STEP/.test(again.body.done) && /#21:2062/.test(again.body.done), again);
  srv.OVERLAY_LINKED.clear();
  check("macroGuard: NAVIGATE reaction and run-anyway pass",
    srv.macroGuard(`b.reactions = [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "1:3", navigation: "NAVIGATE", transition: null }] }];`) === null &&
    srv.macroGuard(`/* run-anyway */ o.overlayPositionType = 'CENTER';`) === null);
  check("execute_code description gives the openOverlay call", /bridge\.openOverlay\(triggerId, overlayFrameId, \{ position: 'BOTTOM_CENTER'/.test(srv.TOOLS.find(t => t.name === "figma_execute_code").description));

  // CRLF-normalized: a Windows checkout (core.autocrlf) turns the fixtures into CRLF.
  const fxAction = fs.readFileSync(path.join(__dirname, "fixtures", "set_reactions_action.txt"), "utf8").replace(/\r\n/g, "\n");
  const fxActions = fs.readFileSync(path.join(__dirname, "fixtures", "set_reactions_actions.txt"), "utf8").replace(/\r\n/g, "\n");
  const c1 = srv.compressValidationError(fxAction);
  check("validation: legacy `action` union (2.8 KB) -> the matching branch, under 500 bytes", c1.length < 500 && /transition: Required value missing/.test(c1) && /8 other variants skipped/.test(c1) && /at line 17/.test(c1), c1);
  check("validation: the missing `transition` gets the fix named", /needs the key `transition` \(null = instant\)/.test(c1), c1);
  const c2 = srv.compressValidationError(fxActions);
  check("validation: `actions` union with an overlay key -> closest branch + overlay hint, under 700 bytes",
    c2.length < 700 && /Unrecognized key\(s\)/.test(c2) && /READ-ONLY FRAME properties/.test(c2) && /bridge\.info\(\)\.reactions/.test(c2), c2);
  const c3 = srv.compressValidationError(`in set_reactions: Property "reactions" failed validation: Unrecognized key(s) in object: 'overlayBackground' at [1].actions[0]`);
  check("validation: a short overlay-key error gets the hint appended", /^in set_reactions/.test(c3) && /READ-ONLY FRAME properties/.test(c3), c3);
  check("validation: other messages pass through", srv.compressValidationError("boom") === "boom" && srv.compressValidationError(null) === null);
  const env = JSON.parse(srv.buildStructuredResult({ result: { success: false, error: fxAction } }, null, { maxOutputBytes: 3500 }));
  check("validation: an error a script caught and returned is compressed inside result", env.result.error.length < 500 && !env.truncated, env);
  const err = srv.buildErrorEnvelope(new Error(fxAction));
  check("validation: thrown errors are compressed too", err.error.length < 700 && /8 other variants skipped/.test(err.error), err.error.length);

  const flowCode = srv.buildInspectCode({ node_ids: ["1:2"], view: "flow" });
  check("inspect: view flow -> so.view = 'flow', result under `flow`, no ids -> every top-level node of the page (#35)",
    /"view":"flow"/.test(flowCode) && /if \(a\.view === 'flow'\) so\.view = 'flow';/.test(flowCode) && /figma\.currentPage\.children\.map/.test(flowCode) && !/pass node_ids/.test(flowCode), flowCode);
  check("inspect: flow result pages with offset", /^… lines 0–1 skipped\n/.test(srv.applyLineOffset({ flow: "a\nb\nc" }, 2).flow));
  check("write detection: reaction macros are writes", ["setReaction", "openOverlay", "closeOverlay"].every(m => srv.classifyScript(`await bridge.${m}("1:2", {});`) === "write"));
  const exDesc = srv.TOOLS.find(t => t.name === "figma_execute_code").description;
  check("execute_code description names componentize, the reaction macros, flow and the findAll rule",
    /bridge\.componentize/.test(exDesc) && /setReaction/.test(exDesc) && /openOverlay/.test(exDesc) && /flow/.test(exDesc) && /findAll the whole page/.test(exDesc));
  check("figma_inspect schema offers view flow", srv.TOOLS.find(t => t.name === "figma_inspect").inputSchema.properties.view.enum.includes("flow"));

  // similar: copies of one element with different style (bench T1)
  const SIM = [
    'FRAME "Фильтры / 1280" #1:1 1280x400 @0,0 [V gap24 pad32 fixed/fixed] fill:#F9FAFB',
    '  FRAME "Мультиселект" #1:2 280x44 @0,0 [H gap8 pad10,14,10,14 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r8 shadow:0,1/2 #101828@0.05 children:2',
    '  FRAME "Dropdown" #1:3 280x44 @296,0 [H gap8 pad10,14,10,14 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r4',
    '    FRAME "Frame 2131329286" #1:4 119x34 @14,4 [V gap2 pad0 hug/hug]',
    '      … +2 deeper',
    '    VECTOR "chevron" #1:5 16x16 @310,13 stroke:#667085/1.5',
    '  FRAME "Select" #1:6 340x40 @32,153 [H gap8 pad8,12,8,12 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r8 shadow:0,1/2 #101828@0.05 children:2'
  ].join("\n");
  const sh = srv.similarHint(SIM);
  check("similar: 3 same-structure nodes with different style -> one hint naming them and compare", typeof sh === "string" && /3 nodes/.test(sh) && /#1:2 #1:3 #1:6/.test(sh) && /r, shadow, pad, h/.test(sh) && /compare:/.test(sh), sh);
  const SAME = SIM.replace(/ r4$/m, " r8 shadow:0,1/2 #101828@0.05").replace("pad8,12,8,12", "pad10,14,10,14").replace("340x40", "340x44");
  check("similar: same style (only width differs) -> no hint", srv.similarHint(SAME) === null, srv.similarHint(SAME));
  // #36: fixture = outline of h7 T1 (0073d214, turn 2), a bare "Filters row" next to the real dropdowns
  const H7 = [
    'FRAME "Фильтры / 1280" #21:18 1280x400 @0,0 [V gap24 pad32,32,0,32 fixed/fixed] fill:#F9FAFB',
    '  TEXT "Фильтры отчёта" #21:19 193x29 @32,32 size:hug/hug fill:#000000 Inter/Medium 24 "Фильтры отчёта"',
    '  FRAME "Filters row" #21:26 576x44 @32,85 [H gap16 pad0 hug/hug]',
    '    FRAME "Мультиселект потребителей" #21:27 280x44 @0,0 [H gap8 pad10,14,10,14 fixed/fixed a:between/center] fill:#FFFFFF stroke:#D0D5DD/1 r8 shadow:0,1/2 #101828@0.05 children:2',
    '    FRAME "Dropdown" #21:32 280x44 @296,0 [H gap8 pad10,14,10,14 fixed/fixed a:between/center] fill:#FFFFFF stroke:#D0D5DD/1 r4 children:2',
    'FRAME "Фильтры / 768" #21:20 768x400 @1400,0 [V gap24 pad32,32,0,32 fixed/fixed] fill:#F9FAFB',
    '  FRAME "Мультиселект потребителей copy" #21:37 340x44 @32,85 [H gap8 pad10,14,10,14 fixed/fixed a:between/center] fill:#FFFFFF stroke:#E4E7EC/0,0,1,0 r8 shadow:0,1/2 #101828@0.05',
    '    FRAME "Frame 2131329286" #21:38 119x34 @14,4.5 [V gap2 pad0 hug/hug] children:2',
    '    VECTOR "chevron-down" #21:41 16x16 @310,13.5 size:fixed/fixed stroke:#667085/1.5',
    '  FRAME "Select" #21:42 340x40 @32,153 [H gap8 pad8,12,8,12 fixed/fixed a:between/center] fill:#FFFFFF stroke:#D0D5DD/1 r8 shadow:0,1/2 #101828@0.05',
    '    FRAME "Frame 2131329286" #21:43 89x34 @13,3 [V gap2 pad0 hug/hug] children:2',
    '    VECTOR "chevron-down" #21:46 16x16 @311,12 size:fixed/fixed stroke:#667085/1.5'
  ].join("\n");
  const h7 = srv.similarHint(H7);
  check("similar: bare row not grouped; dropdowns 21:27, 21:32 (children:N) and the copies are (#36)",
    typeof h7 === "string" && !/#21:26\b/.test(h7) && /#21:27 #21:32 #21:37 #21:42/.test(h7), h7);
  const REFS = H7 + '\nFRAME "Фильтры / 1280 (эталон)" #21:24 1280x300 @0,600 [V gap24 pad32 fixed/fixed] fill:#F9FAFB\n' +
    '  FRAME "Мультиселект" #21:52 280x36 @32,85 [H gap8 pad6,14,6,14 fixed/fixed] fill:#FFFFFF stroke:#98A2B3/1 r2 children:2';
  const hr = srv.similarHint(REFS);
  check("similar: a node inside a frame named (эталон) is noted, not grouped (#36)",
    /not in the group: #21:52/.test(hr) && !/ #21:52 /.test(hr.split(" (frames")[0]) && /#21:27 #21:32 #21:37 #21:42/.test(hr), hr);
  const NESTED = 'PAGE "Фильтры" #21:17\n' + H7.split("\n").map(l => "  " + l).join("\n") + '\n  FRAME "Фильтры / 1280 (эталон)" #21:24 1280x300 @0,600 [V gap24 pad32 fixed/fixed] fill:#F9FAFB\n' +
    '    FRAME "Мультиселект" #21:52 280x36 @32,85 [H gap8 pad6,14,6,14 fixed/fixed] fill:#FFFFFF stroke:#98A2B3/1 r2 children:2';
  const hn = srv.similarHint(NESTED);
  check("similar: the (эталон) frame one level below the page root is found by its ancestors too (#36)", /not in the group: [^)]*#21:52/.test(hn) && !/ #21:52 /.test(hn.split(" (frames")[0]) && /#21:27 #21:32 #21:37 #21:42/.test(hn), hn);
  const HDR = [
    'FRAME "Главная / 1280" #5:1 1280x800 @0,0 [V gap0 pad0 fixed/fixed] fill:#FFFFFF',
    '  INSTANCE "Header" #5:2 1280x64 @0,0 [H gap16 pad0,24,0,24 fixed/fixed a:between/center] fill:#FFFFFF stroke:#EAECF0/0,0,1,0 →"Header" Size=Desktop children:3',
    '    FRAME "Logo" #I5:2;7:1 120x24 @24,20 [H gap4 pad0 hug/hug] fill:#101828 children:2',
    '    FRAME "Nav" #I5:2;7:4 400x24 @200,20 [H gap8 pad0 hug/hug] fill:#F2F4F7 children:2',
    'FRAME "Главная / 768" #6:1 768x800 @1400,0 [V gap0 pad0 fixed/fixed] fill:#FFFFFF',
    '  INSTANCE "Header" #6:2 768x64 @0,0 [H gap16 pad0,24,0,24 fixed/fixed a:between/center] fill:#FFFFFF stroke:#EAECF0/0,0,1,0 →"Header" Size=Tablet children:3',
    '    FRAME "Logo" #I6:2;7:1 120x24 @24,20 [H gap4 pad0 hug/hug] fill:#101828 children:2',
    '    FRAME "Nav" #I6:2;7:4 300x24 @200,20 [H gap8 pad0 hug/hug] fill:#F2F4F7 children:2',
    'FRAME "Главная / 360" #7:1 360x800 @2300,0 [V gap0 pad0 fixed/fixed] fill:#FFFFFF',
    '  INSTANCE "Header" #7:2 360x56 @0,0 [H gap16 pad0,16,0,16 fixed/fixed a:between/center] fill:#FFFFFF stroke:#EAECF0/0,0,1,0 →"Header" Size=Mobile children:3',
    '    FRAME "Logo" #I7:2;7:1 96x24 @16,16 [H gap4 pad0 hug/hug] fill:#101828 children:2',
    '    FRAME "Nav" #I7:2;7:4 200x24 @100,16 [H gap8 pad0 hug/hug] fill:#F2F4F7 children:2'
  ].join("\n");
  const hh = srv.similarHint(HDR);
  check("similar: 3 Header instances with internals (#I...) -> no hint, the internals are never offered (#36)", hh === null || (!/#I/.test(hh) && !/Header/.test(hh) && hh.indexOf("#5:2") === -1), hh);
  check("similar: not an outline -> null", srv.similarHint(undefined) === null && srv.similarHint("FRAME \"a\" #1:1 10x10 @0,0") === null);
  check("inspect truncation note points at compare/ids, not lastResult", /compare/.test(srv.truncationNote({ from: 3764, to: 2249 }, true, false, "inspect")) && !/lastResult/.test(srv.truncationNote({ from: 3764, to: 2249 }, true, false, "inspect")));
  const ln = srv.truncationNote({ from: 5000, to: 3000 }, true, false, "inspect-list");
  check("props/compare truncation note: no 'outline'/'deeper', offers fewer ids/props and offset", !/outline|deeper/.test(ln) && /props/.test(ln) && /offset=K/.test(ln) && !/lastResult/.test(ln), ln);
  const scriptErr = srv.buildErrorEnvelope(new Error("bridge.setTextt is not a function"));
  check("script error naming bridge.xxx is not BRIDGE_OFFLINE and gets no plugin hint", scriptErr.code !== "BRIDGE_OFFLINE" && !/Mokido plugin/.test(scriptErr.error), scriptErr);
  const offline = srv.buildErrorEnvelope(new Error("Timeout waiting for Figma Plugin response."));
  check("timeout is still BRIDGE_OFFLINE with the plugin hint", offline.code === "BRIDGE_OFFLINE" && /HINT:/.test(offline.error), offline);

  // stalled job: STOP once, then answer at once
  srv.jobs.set("job_stalled", { id: "job_stalled", status: "running", progress: [], createdAt: Date.now() - 400000, updatedAt: Date.now() - 400000 });
  (async () => {
    const a = await srv.readJobSnapshot("job_stalled", 50);
    const t0 = Date.now();
    const b = await srv.readJobSnapshot("job_stalled", 5000);
    check("stalled: first report says STOP (stop:true, stalled:true)", a.stalled === true && a.stop === true && /^STOP/.test(a.hint), a);
    check("stalled: a repeated poll returns at once and says already reported", Date.now() - t0 < 1000 && b.stalled === true && /Already reported/.test(b.hint), [Date.now() - t0, b]);
    srv.jobs.delete("job_stalled");
    console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
    process.exit(failures ? 1 : 0);
  })();
}
