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

console.log("\n== one-time read tip ==");
{
  srv.TIPS_SHOWN.clear();
  check("a write script gets no tip", srv.readScriptTip("const f = figma.createFrame(); f.children.forEach(c => c.remove());") === null);
  check("a script without a tree walk gets no tip", srv.readScriptTip("return figma.getNodeById('1:2').width;") === null);
  const t = srv.readScriptTip("const out = []; for (const s of figma.currentPage.findAll(n => n.type === 'SECTION')) out.push(s.name); return out;");
  check("a hand-written read walk gets the tip, naming the inspect modes", typeof t === "string" && /view:"map"/.test(t) && /context:true/.test(t) && /find_text/.test(t), t);
  check("...only once per server process", srv.readScriptTip("return figma.currentPage.findAll(() => true).length;") === null);
  srv.TIPS_SHOWN.clear();
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
  check("view: 'map' -> summarize(refs, { depth, view: 'map' })", specOf(map).view === "map" && specOf(map).depth === 2 && /if \(a\.view === 'map'\) so\.view = 'map';/.test(map) && /const so = \{ depth: /.test(map), map);
  check("view: 'outline' is the default (no view sent)", specOf(srv.buildInspectCode({ view: "outline" })).view === null);
  const ctx = srv.buildInspectCode({ node_ids: ["1:2", "3:4"], context: true });
  check("context: true -> out.context[id] = bridge.context(id) for every ref", specOf(ctx).context === true && /out\.context\[id\] = bridge\.context\(id\)/.test(ctx) && /"ids":\["1:2","3:4"\]/.test(ctx), ctx);
  const ft = srv.buildInspectCode({ node_ids: ["1:2"], find_text: "Купить", limit: 5, find_type: "text" });
  check("find_text -> bridge.find(query, { root, limit, text: true }) per root",
    specOf(ft).findText === "Купить" && specOf(ft).limit === 5 && specOf(ft).type === "TEXT" && /const query = a\.findText \|\| a\.find;/.test(ft) &&
    /if \(a\.findText\) opts\.text = true;/.test(ft) && /if \(root\) opts\.root = root;/.test(ft) && /bridge\.find\(query, opts\)/.test(ft), ft);
  const fnd = srv.buildInspectCode({ find: "Button" });
  check("find (names) is unchanged: no text flag in the spec, results under `found`",
    specOf(fnd).find === "Button" && specOf(fnd).findText === null && /out\[query \? 'found' : 'outline'\]/.test(fnd));
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
}

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures ? 1 : 0);
