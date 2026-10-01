# Changelog

## 4.2.4 — find the copies of a reference, not just diff given ones

Measured on Antigravity session `87bd6b0a` (Gemini Flash, 4.2.3, one task: redo the dropdowns of one
scenario after two reference links): 90 MCP calls, 67 `figma_inspect`. About 34 of them only paired
references with their copies on 1366/768/360 (the target was a whole screen, the menu copy had another
name), ~14 more read a nested instance's variant, and a series of `props` read the reference values
`compare` reported only as "missing in target". `compare` was used once before the write.

- **`figma_inspect like: "<ref id>"`** (and `bridge.like(refs, roots)`): finds every copy of the
  reference under `node_ids` (default: its top section) — instances of the same component set, or the
  same type+name, or (renamed copies) the same child names — and diffs each. Copies with the same diff
  set form one group (the diff printed once, the ids listed), the shared screen-name prefix is said
  once, matching copies end on one line. One call answers "where are the broken ones and what is off".
- **`compare` gives the reference's own line for a missing child** (`missing in target (ref #id TEXT
  …size:fill/hug font …)`), so the write needs no extra read of the reference.
- **An extra wrapper is one line** (`wrapper not in ref (FRAME) — ref holds "Title" directly`), and the
  wrapped children are still compared, instead of a `missing` per child plus an `extra` per frame.
- **Another variant is one line**: `compare` no longer walks into an instance whose component/variant
  differs (its children follow the variant; a section-wide `like` went from 23 lines per copy to 1).
- Server instructions: a screenshot to orient beats a series of reads (a turn re-sends the whole chat).

## 4.2.3 — read a section in one call, diff against a reference

Measured on Antigravity session `9672b93e` (Gemini Flash, 4.2.2, one task: fix six dropdowns after a
correct one): 75 MCP calls, 66 of them `figma_inspect` — reads now went through inspect, but in small
steps: depth 1, then deeper, then `props` for stroke weights, corner radii, effects, sizing.

- **`figma_inspect compare: "<ref id>"`** (and `bridge.compare(ref, targets)` in code): per node only
  what differs from the reference — layout, alignment, sizing, per-side stroke, per-corner radius,
  effects, clip, font, component/variant; children matched by name; geometry and text content skipped.
  `identical` when done, so the same call verifies the write.
- **The outline goes as deep as fits** when `depth` is omitted; a node cut by the depth ends with
  `children:N`. Wide nodes list up to 200 children, so `offset` paging reaches all of them (it used to
  page over a list already capped at 15).
- **The outline line carries the non-default facts** that cost separate `props` calls: `a:start/center`
  alignment, `size:fill/hug` for children of AutoLayout, `abs`, per-side stroke `stroke:#E8EAF0/0,1,1,1`,
  per-corner `r0,0,3,3`, `shadow:0,4/20 #000@0.1`; instances show their component set instead of
  repeating the variant list.
- `context: true` comes back as one-line strings (siblings were shrunk to `{object with 2 keys}`).
- `figma_list_targets` with nothing connected says what to ask the user (the model spent 8 turns
  grepping the server source instead).

## 4.2.2

Theme: reads go through `figma_inspect`, not hand-written scripts. Measured on Antigravity session
`e6524905` (Gemini Flash, 3 tasks on 4.2.1): 76 MCP calls, ~69 of them read-only `figma_execute_code`
scripts plus 15 calls slicing `bridge.state.lastResult`; `figma_inspect` was never called.

- **`use_instead` — a ready read call in every hand-written read.** A `figma_execute_code` script
  that only reads (no canvas writes, nothing created or modified) gets, as the FIRST field of the
  reply, the `figma_inspect` call that reads the same nodes — node ids, the `find` query, `find_type`
  and `props` lifted from the script, `view: "table"` for walks into rows / headers / cells — plus a
  count of read turns spent in a row. Slicing `bridge.state.lastResult` gets the call that replaces the
  walk it came from. The 4.2.1 one-time generic tip is gone: replayed on that session, the new
  classifier flags all 63 reads and none of the 3 writes.
- **`figma_inspect view: "table"`.** Tables are found by structure (rows in one column with the same
  cell count), never by layer names: per table the header, every column's title, width, sizing and
  contents (text samples, component + variant counts such as `checkbox State=Default×6 State=Disabled×2`),
  and the ids of the first row and its cells. Several `node_ids` = several screens compared in one call.
- **Tool texts say it first.** `figma_execute_code` is described as the WRITE tool and routes reads to
  `figma_inspect`; the server instructions' rule 1 is now "READ with figma_inspect", rule 2 "WRITE the
  whole change in ONE figma_execute_code call" (they used to say read, change and verify in one script).
- **Shrinking keeps the most that fits.** Plain data is pruned on a grid (depth × array length ×
  string length) and the largest result under the budget wins, instead of fixed levels that dropped a
  4444-byte reply to 651 bytes. A cut hand-written read points at `use_instead`, not at slicing.
- **Reads leave no checkpoints.** A call that journaled nothing no longer gets a `checkpoint_id`, so
  60 reads can't push real writes out of the 50-slot ring or become `figma_rollback("last")`.

## 4.2.1

Theme: fewer model turns per task. Server side:

- **An outline is no longer cut mid-string.** Multi-line results (the `figma_inspect` outline) shrink
  by whole lines: the deepest indent levels collapse first (`… +N deeper`), then the tail is cut on a
  line boundary and ends with `… +N more lines (T total) — pass offset=K`. A 25-line outline now
  arrives whole; before, one long string was chopped at 400 characters and the child tree was lost.
- **`figma_inspect` grows without a new tool:** `offset` pages a cut outline, `view: "map"` returns
  a canvas map, `context: true` adds ancestor sections / breakpoints / component variants,
  `find_text` searches text content, `props` also accepts `reactions` and `connector`.
- **Output ceiling, per client.** In clients that spill large tool output to a file (Antigravity,
  and any client that doesn't identify itself as one that keeps it inline) a requested
  `max_output_bytes` above 3900 — or `0` — is capped to 3900 with a short note, so a reply never
  crosses the ~4.1 KB spill line. Claude Code, Cursor, Windsurf, Cline and similar keep the old
  behaviour. The client comes from `initialize` `clientInfo.name` (logged to stderr);
  `FIGMA_MCP_MAX_OUTPUT_CEILING` forces a value for every client (`0` = off).
- **Truncation notes point at the cheap next step:** `return bridge.state.lastResult.slice(40, 80)`
  (or `offset` for an outline) — they no longer advertise `max_output_bytes: 0` where it would spill.
- **A one-time tip in the reply.** Antigravity never shows the model the server instructions, but the
  model reads every response: the first read-only script with a hand-written tree walk gets one line
  pointing at `figma_inspect` `view` / `context` / `find_text` and the write macros.
- **`figma/instructions.md` opens with "Fewest calls"** — the 3–5-call path for a typical task (agents
  in Antigravity read this file when stuck).
- **Syntax errors never reach the plugin.** `figma_execute_code` compiles the code first and
  answers `SCRIPT_SYNTAX_ERROR` with `line` and `at` (the offending line) at once.
- **Located errors.** A runtime failure reports the `line`, `column` and `at` sent by the plugin.
- Up to 4 images per response (was 3); a call that escalates to a background job carries a hint to
  scope `findAll` / `find` to a section.

Plugin side:

- **Result sanitizing.** `figma.mixed` and other unserializable values no longer sink the response
  after a mutation has already happened.
- **Fewer wasted retries.** A call to a `bridge` helper that does not exist now names the helper
  (and lists the ones that exist) instead of failing as `undefined is not a function`.
- **Screenshots per node.** Each `capture_node_ids` entry is rendered on its own (downscaled)
  instead of one shared section image.
- **Fast search.** `bridge.find` turns on `skipInvisibleInstanceChildren` for its duration and uses
  `findAllWithCriteria` where it can; `find` also matches text content (`text: true`).
- **New reads and macros.** `bridge.context(id)`, `bridge.summarize(..., { view: "map" })`,
  `reactions` / `connector` in `props`, the `conventions` key of `bridge.store` (breakpoints, working section — returned by `bridge.context`), and the macros
  `replaceWithInstance`, `setProps`, `setText`, `shift`, `moveInto`, `fitSection`.
