# Figma MCP Bridge — Instructions & Best Practices

## Overview
This MCP server connects AI coding assistants (such as Antigravity, Claude, Cursor) with Figma. It supports two modes:
1. **Interactive Live Bridge (Local)**: Real-time two-way interaction with an open Figma document via the *Antigravity Bridge* plugin (`http://127.0.0.1:8765`). Full read/write access to the Figma canvas.
2. **REST API (Cloud)**: Read-only access to Figma files, nodes, comments, styles, and image exports via Figma REST API (`FIGMA_PERSONAL_ACCESS_TOKEN`) with **Token Optimizer** saving 85%+ context tokens.

---

## 0. Execution Model of `figma_execute_code` (READ FIRST)

Everything an agent writes for the live canvas is compiled by the plugin like this:

```js
new AsyncFunction("figma", "ensureFont", "notify", "log", "getFreePosition", "bridge", yourCode)
```

Four consequences that are not guessable from the outside:

| Fact | What it means for you |
|------|-----------------------|
| Every call is a **fresh async function body** | `const` / `let` / `var` / `function` declared at top level are **gone on the next call**. |
| Top-level `await` and `return` work; `import` / `export` do not | Return a value to send it back to the model; `await ensureFont(...)` directly. |
| `eval()` in the Figma sandbox is a **bound** function | By spec every `eval(...)` is therefore an **indirect eval**: it cannot see your locals, and `var` / `function` / `class` declared inside the string reach **neither** the caller **nor** `globalThis`. Building a helper kit through `eval` fails *silently* — the declarations simply do not exist afterwards. **Never use `eval` here.** |
| `new Function(...)` bodies are ordinary function scopes and share `globalThis` | This is what the `bridge` module loader is built on. Use it instead. |

Ask the runtime itself at any time:

```js
return bridge.info();   // execution model, injected globals, defined modules, stored keys
```

### Persisting helpers between calls — `bridge.define` / `bridge.require`

Define once (source is compiled immediately, so mistakes surface right away, then saved into the `.fig` document):

```js
bridge.define("kit", `
  async function label(parent, text, size = 14) {
    await ensureFont("Inter", "Medium");
    const t = figma.createText();
    t.fontName = { family: "Inter", style: "Medium" };
    t.characters = text;
    t.fontSize = size;
    parent.appendChild(t);
    return t;
  }
  const TOKENS = { brand: { r: 0.39, g: 0.4, b: 0.95 } };
  module.exports = { label, TOKENS };
`);
return "kit saved";
```

Use it in every later call — including after Figma or the plugin has been restarted:

```js
const { label, TOKENS } = bridge.require("kit");
const frame = figma.createFrame();
frame.fills = [{ type: "SOLID", color: TOKENS.brand }];
await label(frame, "Hello");
figma.currentPage.appendChild(frame);
return "used kit";
```

Rules for module sources:
- End with `module.exports = { ... }` — a module that exports nothing is rejected with an explanatory error.
- The module body is **synchronous** (no top-level `await`); export `async` functions instead, as above.
- Inside a module you get `figma`, `ensureFont`, `bridge`, `exports`, `module`.
- Sources larger than 60 KB are chunked across `pluginData` entries automatically.

### Persisting data

| API | Lifetime | Use for |
|-----|----------|---------|
| `bridge.state` | survives calls, cleared when the plugin reloads | scratch: ids, counters, cursors within one work session |
| `bridge.store.set(k, v)` / `.get(k, fallback)` / `.remove(k)` / `.keys()` | stored in the `.fig` document, survives everything | design tokens, naming maps, generation manifests |
| `globalThis` | shared, survives calls | works, but prefer `bridge.state` — it is namespaced and inspectable |

### Module & store management

```js
bridge.list();            // module names (in memory + in document)
bridge.source("kit");     // the saved source of a module
bridge.remove("kit");     // forget it everywhere
bridge.store.keys();      // durable keys in this document
```

---

## 0b. Platform Limits Figma Imposes (and the wrappers for them)

These are **Figma Plugin API** behaviours, not bridge bugs. The bridge wraps the two that cost the most time.

**Children of an `INSTANCE` cannot be moved.**
Setting `x`/`y` on any node inside an instance throws
`This property cannot be overridden in an instance: relative-transform`.
There is no direct workaround — position through layout:

```js
bridge.setPosition(node, 24, 40);   // throws early, naming the remedy, if node is inside an INSTANCE
```

Design the layout so position is a *result*: `itemSpacing`, `primaryAxisAlignItems`, `counterAxisAlignItems` on the parent AutoLayout, or `layoutPositioning = "ABSOLUTE"` + constraints set on the **master component**, not the instance.

**`figma.createComponentFromNode()` can freeze AutoLayout sizing.**
It may force `primaryAxisSizingMode` / `counterAxisSizingMode` to `"FIXED"` on the frame *and every nested AutoLayout frame*, at whatever (often not yet recalculated) size they had at that moment. It also returns **new nodes with new ids**, so any reference or id you captured before conversion is dead.

```js
const comp = bridge.componentize(frame);   // records sizing modes by tree position, restores them, forces relayout
```

**Fonts** must be loaded before any text mutation: `await ensureFont("Inter", "Bold")`.
**Colors** are floats `0..1`, not `0..255`.

---

## 0c. Error Hints

Failures coming back from the sandbox carry a `HINT:` line whenever the bridge recognises the failure mode — unloaded fonts, instance overrides, stale node ids, resizing a hugging AutoLayout frame, `pluginData` size limits, and the "helper from my previous call is not defined" case. Read the hint before retrying; it names the API that actually works.

---

## 1. Visual Feedback Loop (Crucial Rule for AI Agents)
Whenever creating, editing, styling, or restructuring UI elements on the Figma canvas:
- **Always close the visual loop**: Pass `capture: true` in `figma_execute_code`, `figma_insert_component_instance`, or `figma_insert_svg`, or call `figma_screenshot` immediately after UI generation.
- **Visually inspect the result**: Check alignment, spacing, typographic hierarchy, color contrast, and clipping before declaring a design task complete.
- **Iterative refinement**: If the screenshot reveals misalignments or bad spacing, send follow-up commands to fix them.

---

## 2. Reading Existing Designs & Token Optimizer (`get_file`, `get_node`)
When analyzing design files or screen trees from Figma Cloud:
- **Default Pseudo-JSX Output (`format: "jsx"`)**: Automatically strips 85–90% of AST noise, collapses vector icons, normalizes AutoLayout and colors, and presents screens in clean, semantic JSX:
  ```jsx
  <Frame name="Header" row gap="16" pad="14, 20" bg="#0F1729" radius="16">
    <Icon name="ic_shield_check" size="24" stroke="#4ADE80" strokeWidth="2" />
    <Text color="#FFFFFF" font="Inter Bold 16px">Antigravity Bridge</Text>
    <Instance name="Button" row pad="8, 14" bg="#6366F1" Type="Primary">
      <Text color="#FFFFFF" font="Inter SemiBold 13px">Save</Text>
    </Instance>
  </Frame>
  ```
- **Alternative Formats**:
  - `format: "tree"`: Ultra-compact indented text tree (`[FRAME] "Header" row gap=16`).
  - `format: "json"`: Cleaned JSON AST with noise removed.
  - `format: "raw"`: Unmodified Figma REST API response.

---

## 3. Smart Canvas Positioning (No Overlaps at 0, 0)
- **Automatic Smart Placement**: When creating new top-level frames, artboards, or cards on the canvas, the bridge automatically prevents overlaps. If an element is placed at `(0, 0)` while other designs exist, it is automatically shifted to free canvas space to the right (`maxX + 80px`).
- **Sandbox Helper `getFreePosition(width, height, { gap, direction })`**: Available globally in `figma_execute_code`. Returns safe coordinates for new screens.
  ```js
  const pos = getFreePosition(400, 800, { gap: 80, direction: "RIGHT" });
  frame.x = pos.x;
  frame.y = pos.y;
  ```
- **Inspect Layout**: Call `figma_get_canvas_layout()` to view all existing artboard bounding boxes and the `suggestedNextPosition`.

---

## 4. Design Systems & Component Reusability (Best Practice)
Instead of drawing buttons, cards, and form elements from raw rectangles and text nodes:
1. **Discover Available Components**: Call `figma_find_components({ query: "Button" })` to inspect existing master components, variant keys (e.g. `Type`, `Size`, `State`), and property definitions.
2. **Insert Component Instances**: Call `figma_insert_component_instance({ component_name: "Button", properties: { Type: "Primary", Size: "MD" }, text_overrides: { "Label": "Save Changes" }, target_parent_id: "12:34" })`.
3. **Variables & Theme Modes**: Call `figma_get_variables()` to discover design tokens and `figma_set_variables_mode({ collection_name: "Theme", mode_name: "Dark" })` to switch theme modes across an artboard or page.

---

## 5. Direct SVG & Vector Import (`figma_insert_svg`)
When adding icons, brand logos, or vector illustrations:
- **Use raw SVG code**: Pass standard SVG strings from Lucide, Heroicons, Material, SimpleIcons, or FontAwesome directly to `figma_insert_svg`.
- **Proportional Resizing**: Set `width` and `height` (e.g. `24, 24`). Geometry paths scale proportionally without manual matrix calculations.
- **Color Overrides**:
  - For outline/stroke icons (Lucide, Feather): pass `stroke_override="#6366F1"`.
  - For filled icons/logos (Material, SimpleIcons): pass `fill_override="#FFFFFF"`.
  - For universal coloring: pass `color_override="#6366F1"`.
- **Component Libraries**: Pass `as_component: true` to wrap the vector into a reusable master `ComponentNode`.

---

## 6. Live Canvas Scripting Guidelines (`figma_execute_code`)

> Scope, persistence and `bridge.*` are covered in **§0 Execution Model** above — read that first.

### Font Loading
Figma requires fonts to be loaded before modifying text node characters or font properties. Use the built-in `ensureFont` helper:
```js
await ensureFont("Inter", "Regular");
await ensureFont("Inter", "Medium");
await ensureFont("Inter", "Bold");

const text = figma.createText();
text.characters = "Hello World";
text.fontSize = 16;
text.fontName = { family: "Inter", style: "Bold" };
```

### AutoLayout Best Practices
Always structure UI components using Figma AutoLayout:
```js
const container = figma.createFrame();
container.name = "Card Container";
container.layoutMode = "VERTICAL"; // or "HORIZONTAL"
container.primaryAxisSizingMode = "AUTO"; // Hug contents
container.counterAxisSizingMode = "FIXED";
container.resize(400, 100);
container.paddingTop = 20;
container.paddingBottom = 20;
container.paddingLeft = 20;
container.paddingRight = 20;
container.itemSpacing = 12;
container.cornerRadius = 16;
container.clipsContent = true;
```

### Colors & Paints
In Figma API, color channels (`r`, `g`, `b`) are normalized floats in range `[0, 1]`, NOT 0-255:
```js
// Pure White: { r: 1, g: 1, b: 1 }
// Accent Purple (#7C3AED): { r: 0.486, g: 0.227, b: 0.929 }
container.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.94, b: 1 } }];
```

---

## 7. Tool Reference

| Tool | Mode | Description |
|------|------|-------------|
| `get_file` | REST | Retrieves file metadata and token-optimized layer hierarchy (`format: 'jsx'`, saves 85%+ tokens). |
| `get_node` | REST | Retrieves specific node subtree in token-optimized Pseudo-JSX, Tree, or JSON format. |
| `figma_get_canvas_layout` | Live | Returns top-level artboard bounding boxes and a calculated safe `suggestedNextPosition` to prevent overlaps. |
| `figma_insert_svg` | Live | Inserts raw SVG vector into canvas/AutoLayout with auto-scale, fill/stroke recoloring, and PNG capture. |
| `figma_find_components` | Live | Finds and catalogs master components, variant matrices, and component properties in the active file. |
| `figma_insert_component_instance` | Live | Creates an instance of a component set/variant, applies text overrides & AutoLayout placement, and returns a PNG capture. |
| `figma_get_variables` | Live | Retrieves variable collections, modes (Light/Dark), and tokens from the active document. |
| `figma_set_variables_mode` | Live | Sets variable mode (Light/Dark/Brand) on a target frame or page with visual screenshot. |
| `figma_execute_code` | Live | Executes JS inside the Figma sandbox as a fresh async function body, with `figma`, `ensureFont`, `getFreePosition` and the `bridge` runtime (persistent modules, durable store, platform workarounds). See §0. |
| `figma_screenshot` | Live | Captures a PNG screenshot of specific `node_ids` or current selection. |
| `figma_get_selection` | Live | Returns properties, coordinates, and text of currently selected canvas nodes. |
| `figma_create_ui_card` | Live | High-level template tool to quickly create a modern card with badge, title, and button (auto-placed). |
| `get_image` | REST | Renders nodes to PNG/SVG/PDF via Figma cloud renderer. |
| `get_styles` | REST | Lists color and text styles from cloud document. |
| `get_components` | REST | Lists design system components and component sets via REST API. |
