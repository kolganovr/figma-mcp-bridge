# Figma MCP Bridge — Instructions & Best Practices

## Overview
This MCP server connects AI coding assistants (such as Antigravity, Claude, Cursor) with Figma. It supports two modes:
1. **Interactive Live Bridge (Local)**: Real-time two-way interaction with an open Figma document via the *Antigravity Bridge* plugin (`http://127.0.0.1:8765`). Full read/write access to the Figma canvas.
2. **REST API (Cloud)**: Read-only access to Figma files, nodes, comments, styles, and image exports via Figma REST API (`FIGMA_PERSONAL_ACCESS_TOKEN`).

---

## 1. Visual Feedback Loop (Crucial Rule for AI Agents)
Whenever creating, editing, styling, or restructuring UI elements on the Figma canvas:
- **Always close the visual loop**: Pass `capture: true` in `figma_execute_code` or `figma_insert_component_instance`, or call `figma_screenshot` immediately after UI generation.
- **Visually inspect the result**: Check alignment, spacing, typographic hierarchy, color contrast, and clipping before declaring a design task complete.
- **Iterative refinement**: If the screenshot reveals misalignments or bad spacing, send follow-up commands to fix them.

---

## 2. Design Systems & Component Reusability (Best Practice)
Instead of drawing buttons, cards, and form elements from raw rectangles and text nodes:
1. **Discover Available Components**: Call `figma_find_components({ query: "Button" })` to inspect existing master components, variant keys (e.g. `Type`, `Size`, `State`), and property definitions.
2. **Insert Component Instances**: Call `figma_insert_component_instance({ component_name: "Button", properties: { Type: "Primary", Size: "MD" }, text_overrides: { "Label": "Save Changes" }, target_parent_id: "12:34" })`.
3. **Variables & Theme Modes**: Call `figma_get_variables()` to discover design tokens and `figma_set_variables_mode({ collection_name: "Theme", mode_name: "Dark" })` to switch theme modes across an artboard or page.

---

## 3. Live Canvas Scripting Guidelines (`figma_execute_code`)

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

### Selection & Viewport Focus
Always add newly created elements to the page, select them, and focus the user's Figma viewport:
```js
figma.currentPage.appendChild(container);
figma.currentPage.selection = [container];
figma.viewport.scrollAndZoomIntoView([container]);
return "Created component with ID: " + container.id;
```

### Colors & Paints
In Figma API, color channels (`r`, `g`, `b`) are normalized floats in range `[0, 1]`, NOT 0-255:
```js
// Pure White: { r: 1, g: 1, b: 1 }
// Accent Purple (#7C3AED): { r: 0.486, g: 0.227, b: 0.929 }
container.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.94, b: 1 } }];
```

---

## 4. Tool Reference

| Tool | Mode | Description |
|------|------|-------------|
| `figma_find_components` | Live | Finds and catalogs master components, variant matrices, and component properties in the active file. |
| `figma_insert_component_instance` | Live | Creates an instance of a component set/variant, applies text overrides & AutoLayout placement, and returns a PNG capture. |
| `figma_get_variables` | Live | Retrieves variable collections, modes (Light/Dark), and tokens from the active document. |
| `figma_set_variables_mode` | Live | Sets variable mode (Light/Dark/Brand) on a target frame or page with visual screenshot. |
| `figma_execute_code` | Live | Executes arbitrary JS inside Figma sandbox with full access to `figma` API. |
| `figma_screenshot` | Live | Captures a PNG screenshot of specific `node_ids` or current selection. |
| `figma_get_selection` | Live | Returns properties, coordinates, and text of currently selected canvas nodes. |
| `figma_create_ui_card` | Live | High-level template tool to quickly create a modern card with badge, title, and button. |
| `get_file` | REST | Retrieves file metadata and full layer tree from Figma Cloud. |
| `get_node` | REST | Retrieves specific node subtree from a cloud document. |
| `get_image` | REST | Renders nodes to PNG/SVG/PDF via Figma cloud renderer. |
| `get_styles` | REST | Lists color and text styles from cloud document. |
| `get_components` | REST | Lists design system components and component sets via REST API. |
