#!/usr/bin/env node
const http = require("http");
const path = require("path");
const fs = require("fs");
const { optimizeFigmaData } = require("./optimizer");

const FIGMA_TOKEN = process.env.FIGMA_PERSONAL_ACCESS_TOKEN || process.env.FIGMA_API_KEY || "";

// ==========================================
// Figma Live Plugin Bridge (HTTP Server)
// ==========================================
const BRIDGE_PORT = 8765;
let pendingCommand = null;
let commandResolvers = new Map();
let lastPluginPing = 0;

const bridgeServer = http.createServer((req, res) => {
  // Enable CORS for Figma plugin UI
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === "/poll" && req.method === "GET") {
    lastPluginPing = Date.now();
    if (pendingCommand) {
      const cmd = pendingCommand;
      pendingCommand = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(cmd));
    }

    // Long poll wait up to 10 seconds
    const checkInterval = setInterval(() => {
      if (pendingCommand) {
        clearInterval(checkInterval);
        const cmd = pendingCommand;
        pendingCommand = null;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(cmd));
      }
    }, 100);

    setTimeout(() => {
      clearInterval(checkInterval);
      if (!res.writableEnded) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "idle" }));
      }
    }, 10000);
    return;
  }

  if (req.url === "/result" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const resolver = commandResolvers.get(data.id);
        if (resolver) {
          resolver(data);
          commandResolvers.delete(data.id);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.url === "/execute" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const result = await sendCommandToPlugin(payload, payload.timeoutMs || 35000);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.url === "/status") {
    const isOnline = (Date.now() - lastPluginPing) < 60000;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ connected: isOnline, lastPing: lastPluginPing }));
  }

  res.writeHead(404);
  res.end();
});

let isBridgeMaster = false;

bridgeServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    isBridgeMaster = false;
    console.error(`[Figma MCP Bridge] Port ${BRIDGE_PORT} is already in use. Forwarding commands to existing bridge instance.`);
  } else {
    console.error(`[Figma MCP Bridge] Server error:`, err);
  }
});

bridgeServer.listen(BRIDGE_PORT, "127.0.0.1", () => {
  isBridgeMaster = true;
});

const cleanup = () => {
  try { bridgeServer.close(); } catch (e) {}
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.stdin.on("close", cleanup);

async function sendCommandToPlugin(payload, timeoutMs = 45000) {
  if (!isBridgeMaster) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, timeoutMs })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Bridge proxy error: ${errText}`);
      }
      const data = await res.json();
      if (data.success) return data;
      throw new Error(data.error || "Execution failed in Figma sandbox");
    } catch (err) {
      throw new Error(err.message || "Failed to communicate with Figma Bridge server on :8765");
    }
  }

  return new Promise((resolve, reject) => {
    const id = "cmd_" + Math.random().toString(36).substring(2, 9);
    const cmd = { id, ...payload };
    pendingCommand = cmd;

    const timer = setTimeout(() => {
      commandResolvers.delete(id);
      if (pendingCommand && pendingCommand.id === id) {
        pendingCommand = null;
      }
      reject(new Error("Timeout waiting for Figma Plugin response. Ensure Figma is active and Antigravity Bridge plugin is running."));
    }, timeoutMs);

    commandResolvers.set(id, (response) => {
      clearTimeout(timer);
      if (response.success) {
        resolve(response);
      } else {
        reject(new Error(response.error || "Execution failed in Figma sandbox"));
      }
    });
  });
}

// ==========================================
// Figma REST API Helpers
// ==========================================
function parseFigmaUrlOrKey(input) {
  if (!input) return { fileKey: null, nodeId: null };
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/[^?#]*)?(?:\?[^#]*node-id=([a-zA-Z0-9%:-]+))?/);
  if (urlMatch) {
    let nodeId = urlMatch[2] ? decodeURIComponent(urlMatch[2]).replace(/-/g, ":") : null;
    return { fileKey: urlMatch[1], nodeId: nodeId };
  }
  return { fileKey: trimmed, nodeId: null };
}

async function figmaApiRequest(endpoint, options = {}) {
  if (!FIGMA_TOKEN) {
    throw new Error("FIGMA_PERSONAL_ACCESS_TOKEN is required for Figma Cloud REST API calls. Provide your token in the MCP configuration.");
  }
  const url = `https://api.figma.com/v1${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-Figma-Token": FIGMA_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Figma API error (${response.status} ${response.statusText}): ${errorBody}`);
  }

  return await response.json();
}

// ==========================================
// Tool Definitions & Handler
// ==========================================
const TOOLS = [
  // 1. Live Canvas Tools
  {
    name: "figma_execute_code",
    description: "EXECUTE LIVE JAVASCRIPT inside the open Figma document to create, edit, move, style, color, or delete any canvas elements (requires 'Antigravity Bridge' plugin running in Figma Desktop). Provides full access to `figma` API and `ensureFont(family, style)`. Set 'capture: true' to automatically capture a PNG screenshot of the resulting UI elements for visual feedback loop.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript code to execute in Figma sandbox. Example: const frame = figma.createFrame(); frame.resize(400, 600); frame.name = 'Card'; figma.currentPage.appendChild(frame); figma.currentPage.selection = [frame]; figma.viewport.scrollAndZoomIntoView([frame]); return 'Created frame';"
        },
        description: {
          type: "string",
          description: "Short human-readable description of the action (e.g. 'Create login modal', 'Update brand colors') shown in Figma toasts and logs."
        },
        capture: {
          type: "boolean",
          description: "Set to true to immediately take a PNG screenshot of the selected/created UI elements and return it to the model for visual verification (Visual Feedback Loop)."
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1.5)."
        }
      },
      required: ["code"]
    }
  },
  {
    name: "figma_screenshot",
    description: "Capture a visual PNG screenshot of specific nodes or the current selection in Figma. Highly recommended after UI modifications to inspect layout alignment, contrast, typography, and spacing.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
          description: "Optional comma-separated list of Figma node IDs to screenshot (e.g. '123:456, 123:457'). If omitted, captures current selection or entire page."
        },
        scale: {
          type: "number",
          description: "Export resolution scale factor (default: 1.5)."
        },
        description: {
          type: "string",
          description: "Optional action description for Figma toast and logs."
        }
      }
    }
  },
  {
    name: "figma_get_selection",
    description: "Get information and properties (dimensions, coordinates, text, fills) of the currently selected nodes on the Figma canvas.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "figma_create_ui_card",
    description: "Create a modern, professionally styled UI Card with badge/pill, bold title, subtitle, full-width action button, and AutoLayout in Figma. Automatically captures and returns a visual screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title (default: 'Figma AI Bridge')" },
        subtitle: { type: "string", description: "Card description or subtitle text" },
        badge_text: { type: "string", description: "Optional badge/pill label" },
        button_text: { type: "string", description: "Action button label" },
        bg_color: { type: "string", description: "Hex background color (default: '#F5F0FF')" },
        width: { type: "number", description: "Width in px (default: 400)" }
      }
    }
  },
  {
    name: "figma_find_components",
    description: "Find and inspect components, component sets, variants, and component property definitions in the active Figma file without flooding LLM context. Returns names, variant values, keys, and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to filter components by name, description, or variant name (optional, if empty returns all top components)"
        },
        page_name: {
          type: "string",
          description: "Optional page name filter (e.g. '🎨 Design System' or 'Components')"
        },
        include_variants: {
          type: "boolean",
          description: "Whether to collect and return all available variant property keys and values (default: true)"
        },
        limit: {
          type: "number",
          description: "Maximum number of components to return to prevent token bloat (default: 30)"
        }
      }
    }
  },
  {
    name: "figma_insert_component_instance",
    description: "Create and insert an instance of a master component or component set into the canvas or target AutoLayout container. Supports selecting variants, applying text overrides with auto font loading, and returns a PNG screenshot for visual verification.",
    inputSchema: {
      type: "object",
      properties: {
        component_name: {
          type: "string",
          description: "Name of the master component or ComponentSet to instantiate (e.g. 'Button', 'Card', 'Input')"
        },
        component_id: {
          type: "string",
          description: "Direct node ID of the master component or ComponentSet (optional alternative to component_name)"
        },
        properties: {
          type: "object",
          description: "Key-value map of variant properties and component properties to apply (e.g. {'Type': 'Primary', 'Size': 'MD', 'State': 'Default'})"
        },
        text_overrides: {
          type: "object",
          description: "Key-value map of text overrides for text layers inside the component (e.g. {'Label': 'Submit', 'Description': 'Confirm order'})"
        },
        target_parent_id: {
          type: "string",
          description: "Target container/frame node ID to insert the instance into. If omitted, inserts into current selected frame or active page."
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            index: { type: "number", description: "Child index in AutoLayout parent" }
          },
          description: "Optional placement coordinates or child index in AutoLayout container"
        },
        capture: {
          type: "boolean",
          description: "Whether to automatically capture and return a PNG screenshot of the inserted instance (default: true)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1.5)"
        }
      }
    }
  },
  {
    name: "figma_get_variables",
    description: "Retrieve all Figma Variable collections, modes (e.g. Light/Dark), and design tokens (colors, numbers, strings, booleans) from the active document.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Optional filter by variable collection name (e.g. 'Theme', 'Tokens', 'Spacing')"
        }
      }
    }
  },
  {
    name: "figma_set_variables_mode",
    description: "Switch the active Figma Variables mode (e.g. Dark Mode, Light Mode, Brand theme) for a specific artboard/frame or the entire page.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Name of the variable collection (e.g. 'Theme', 'Mode', 'Brand')"
        },
        mode_name: {
          type: "string",
          description: "Target mode name to activate (e.g. 'Dark', 'Light', 'Compact')"
        },
        target_id: {
          type: "string",
          description: "Target node ID (frame/artboard) to set mode on. If omitted, applies to current selection or active page."
        },
        capture: {
          type: "boolean",
          description: "Whether to capture a PNG screenshot of the target after switching mode (default: true)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1.5)"
        }
      },
      required: ["collection_name", "mode_name"]
    }
  },
  {
    name: "figma_insert_svg",
    description: "Insert raw SVG/vector code directly into Figma canvas or target AutoLayout container with automatic scale-proportional resizing, fill/stroke color overrides, optional component creation, and visual PNG screenshot return.",
    inputSchema: {
      type: "object",
      properties: {
        svg_code: {
          type: "string",
          description: "Raw XML/SVG string (e.g. '<svg xmlns=\"...\" viewBox=\"0 0 24 24\">...</svg>')"
        },
        name: {
          type: "string",
          description: "Optional layer name for the created SVG node (e.g. 'Icon / Shield', 'Brand / Google')"
        },
        width: {
          type: "number",
          description: "Desired width in pixels (e.g. 24, 32, 48)"
        },
        height: {
          type: "number",
          description: "Desired height in pixels (e.g. 24, 32, 48)"
        },
        fill_override: {
          type: "string",
          description: "Specific fill color override (Hex e.g. '#FFFFFF' or RGB) applied to vector shapes with non-empty fills"
        },
        stroke_override: {
          type: "string",
          description: "Specific stroke color override (Hex e.g. '#6366F1' or RGB) applied to vector paths with non-empty strokes"
        },
        color_override: {
          type: "string",
          description: "Universal color override (Hex '#6366F1' or RGB) applied to all active fills and strokes"
        },
        target_parent_id: {
          type: "string",
          description: "Target container/frame node ID to insert the SVG into. If omitted, inserts into current selected frame or active page."
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            index: { type: "number", description: "Child index in AutoLayout parent" }
          },
          description: "Optional placement coordinates or child index in AutoLayout container"
        },
        as_component: {
          type: "boolean",
          description: "Whether to wrap the resulting SVG node into a reusable master ComponentNode (default: false)"
        },
        capture: {
          type: "boolean",
          description: "Whether to automatically capture and return a PNG screenshot of the inserted SVG (default: true)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale factor (default: 2.0)"
        }
      },
      required: ["svg_code"]
    }
  },
  {
    name: "figma_get_canvas_layout",
    description: "Inspect top-level frames and artboards on the active Figma page to prevent overlap. Returns all screen coordinates, bounding box, and a calculated 'suggestedNextPosition' for placing new artboards safely.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["RIGHT", "BOTTOM"],
          description: "Placement direction relative to existing screens ('RIGHT' or 'BOTTOM', default: 'RIGHT')"
        },
        gap: {
          type: "number",
          description: "Spacing in pixels between artboards (default: 80)"
        }
      }
    }
  },

  // 2. Figma REST API Tools (Cloud)
  {
    name: "get_me",
    description: "Verify authenticated user and token validity via Figma Cloud REST API.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_file",
    description: "Get full document metadata and token-optimized layer hierarchy of a Figma file by URL or file key. Automatically prunes noise and converts to semantic Pseudo-JSX/Tree format to save 85%+ tokens.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma file/design URL" },
        depth: { type: "number", description: "Hierarchy depth (default: 2)" },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json", "raw"],
          description: "Output format: 'jsx' (clean semantic Pseudo-JSX, default), 'tree' (indented text tree), 'json' (pruned JSON), or 'raw' (unmodified raw Figma API response)"
        },
        simplify: { type: "boolean", description: "Whether to apply token pruning and vector collapsing (default: true)" },
        include_hidden: { type: "boolean", description: "Whether to include hidden layers (default: false)" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_node",
    description: "Get token-optimized node/component design data for specific nodes in a Figma file. Automatically prunes AST noise, collapses vector icons, and returns clean Pseudo-JSX/Tree format (saves 85%+ tokens).",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        node_ids: { type: "string", description: "Comma-separated list of node IDs (e.g. '1234:5678') or encoded from URL" },
        depth: { type: "number", description: "Subtree depth (default: 3)" },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json", "raw"],
          description: "Output format: 'jsx' (clean semantic Pseudo-JSX, default), 'tree' (indented text tree), 'json' (pruned JSON), or 'raw' (unmodified raw Figma API response)"
        },
        simplify: { type: "boolean", description: "Whether to apply token pruning and vector collapsing (default: true)" },
        include_hidden: { type: "boolean", description: "Whether to include hidden layers (default: false)" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_image",
    description: "Render and export nodes to image URLs (PNG, SVG, JPG, PDF) via Figma Cloud API.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        node_ids: { type: "string", description: "Comma-separated node IDs to render" },
        format: { type: "string", enum: ["png", "jpg", "svg", "pdf"], description: "Image format (default: png)" },
        scale: { type: "number", description: "Image scale factor 1 to 4 (default: 2)" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_image_fills",
    description: "Get download URLs for all images used as fills in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_styles",
    description: "Get all color, text, and effect styles defined in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_components",
    description: "Get all components and component sets in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_comments",
    description: "List all comments and threads on a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "post_comment",
    description: "Post a comment or reply to a Figma file or specific node.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        message: { type: "string", description: "Comment message text" },
        node_id: { type: "string", description: "Optional target node ID" }
      },
      required: ["file_key", "message"]
    }
  }
];

async function handleCallTool(name, args = {}) {
  try {
    switch (name) {
      case "figma_execute_code": {
        const desc = args.description || "Execute JS Code";
        const capture = args.capture === true;
        const scale = args.scale || 1.5;
        const response = await sendCommandToPlugin({
          code: args.code,
          description: desc,
          capture: capture,
          scale: scale
        }, 40000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma Execution Result: ${resText}`
        });

        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      case "figma_screenshot": {
        const desc = args.description || "Figma Screenshot";
        const response = await sendCommandToPlugin({
          type: "SCREENSHOT",
          nodeIds: args.node_ids,
          scale: args.scale || 1.5,
          description: desc
        }, 40000);

        const content = [];
        content.push({
          type: "text",
          text: `Figma Screenshot: ${response.result || "Captured"}`
        });

        if (response.screenshots && Array.isArray(response.screenshots)) {
          for (const item of response.screenshots) {
            if (item.base64) {
              const cleanB64 = item.base64.replace(/^data:image\/\w+;base64,/, "");
              content.push({
                type: "image",
                data: cleanB64,
                mimeType: "image/png"
              });
            }
          }
        } else if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      case "figma_get_selection": {
        const code = `
          const selection = figma.currentPage.selection;
          return selection.map(node => ({
            id: node.id,
            name: node.name,
            type: node.type,
            width: node.width,
            height: node.height,
            x: node.x,
            y: node.y,
            fills: node.fills,
            characters: node.characters
          }));
        `;
        const response = await sendCommandToPlugin({ code, description: "Get Selected Nodes" });
        return {
          content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }]
        };
      }

      case "figma_create_ui_card": {
        const hexToRgb = (hex) => {
          let c = hex.replace("#", "");
          if (c.length === 3) c = c.split("").map(x => x + x).join("");
          const num = parseInt(c, 16);
          return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
        };

        const title = args.title || "Figma AI Bridge";
        const subtitle = args.subtitle || "Real-time two-way bridge between AI assistants and Figma canvas.";
        const badgeText = args.badge_text || "✨ Live Bridge";
        const buttonText = args.button_text || "Explore Features →";
        const bgColor = args.bg_color || "#F5F0FF";
        const width = args.width || 400;

        const rgb = hexToRgb(bgColor);

        const code = `
          const card = figma.createFrame();
          card.name = "UI Card - ${title.replace(/"/g, '\\"')}";
          card.layoutMode = "VERTICAL";
          card.primaryAxisSizingMode = "AUTO";
          card.counterAxisSizingMode = "FIXED";
          card.resize(${width}, 100);
          card.paddingTop = 28;
          card.paddingBottom = 28;
          card.paddingLeft = 28;
          card.paddingRight = 28;
          card.itemSpacing = 16;
          card.cornerRadius = 20;
          card.clipsContent = true;
          card.fills = [{ type: 'SOLID', color: { r: ${rgb.r}, g: ${rgb.g}, b: ${rgb.b} } }];
          card.effects = [{
            type: 'DROP_SHADOW',
            color: { r: 0.1, g: 0.05, b: 0.2, a: 0.08 },
            offset: { x: 0, y: 10 },
            radius: 24,
            spread: 0,
            visible: true,
            blendMode: 'NORMAL'
          }];

          ${badgeText ? `
          const badge = figma.createFrame();
          badge.name = "Badge";
          badge.layoutMode = "HORIZONTAL";
          badge.primaryAxisSizingMode = "AUTO";
          badge.counterAxisSizingMode = "AUTO";
          badge.paddingTop = 4;
          badge.paddingBottom = 4;
          badge.paddingLeft = 10;
          badge.paddingRight = 10;
          badge.cornerRadius = 100;
          badge.clipsContent = true;
          badge.fills = [{ type: 'SOLID', color: { r: 0.90, g: 0.84, b: 0.98 } }];

          const badgeTextNode = figma.createText();
          badgeTextNode.characters = "${badgeText.replace(/"/g, '\\"')}";
          badgeTextNode.fontSize = 11;
          badgeTextNode.fontName = { family: "Inter", style: "Medium" };
          badgeTextNode.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.25, b: 0.75 } }];
          badge.appendChild(badgeTextNode);
          card.appendChild(badge);
          ` : ""}

          const titleText = figma.createText();
          titleText.characters = "${title.replace(/"/g, '\\"')}";
          titleText.fontSize = 22;
          titleText.fontName = { family: "Inter", style: "Bold" };
          titleText.fills = [{ type: 'SOLID', color: { r: 0.15, g: 0.12, b: 0.25 } }];
          card.appendChild(titleText);

          ${subtitle ? `
          const subText = figma.createText();
          subText.characters = "${subtitle.replace(/"/g, '\\"')}";
          subText.fontSize = 14;
          subText.fontName = { family: "Inter", style: "Regular" };
          subText.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.42, b: 0.55 } }];
          subText.layoutAlign = "STRETCH";
          card.appendChild(subText);
          ` : ""}

          ${buttonText ? `
          const btn = figma.createFrame();
          btn.name = "Action Button";
          btn.layoutMode = "HORIZONTAL";
          btn.primaryAxisSizingMode = "FIXED";
          btn.counterAxisSizingMode = "AUTO";
          btn.primaryAxisAlignItems = "CENTER";
          btn.counterAxisAlignItems = "CENTER";
          btn.layoutAlign = "STRETCH";
          btn.paddingTop = 12;
          btn.paddingBottom = 12;
          btn.paddingLeft = 0;
          btn.paddingRight = 0;
          btn.cornerRadius = 12;
          btn.clipsContent = true;
          btn.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.40, b: 0.95 } }];

          const btnText = figma.createText();
          btnText.characters = "${buttonText.replace(/"/g, '\\"')}";
          btnText.fontSize = 14;
          btnText.fontName = { family: "Inter", style: "Medium" };
          btnText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
          btn.appendChild(btnText);
          card.appendChild(btn);
          ` : ""}

          figma.currentPage.appendChild(card);
          const freePos = getFreePosition(${width}, 200, { gap: 80 });
          card.x = freePos.x;
          card.y = freePos.y;
          figma.currentPage.selection = [card];
          figma.viewport.scrollAndZoomIntoView([card]);
          return "Created UI Card with ID: " + card.id;
        `;

        const response = await sendCommandToPlugin({
          code,
          description: `Create card "${title}"`,
          capture: true
        });

        const content = [];
        content.push({ type: "text", text: String(response.result) });
        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      // Design System Tools
      case "figma_find_components": {
        const response = await sendCommandToPlugin({
          type: "FIND_COMPONENTS",
          query: args.query || "",
          page_name: args.page_name,
          include_variants: args.include_variants !== false,
          limit: args.limit || 30
        }, 30000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.result, null, 2)
          }]
        };
      }

      case "figma_insert_component_instance": {
        const capture = args.capture !== false;
        const scale = args.scale || 1.5;
        const response = await sendCommandToPlugin({
          type: "INSERT_COMPONENT_INSTANCE",
          component_name: args.component_name,
          component_id: args.component_id,
          properties: args.properties || {},
          text_overrides: args.text_overrides || {},
          target_parent_id: args.target_parent_id,
          position: args.position,
          capture: capture,
          scale: scale
        }, 40000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma Component Instance Inserted: ${resText}`
        });

        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      case "figma_get_variables": {
        const response = await sendCommandToPlugin({
          type: "GET_VARIABLES",
          collection_name: args.collection_name
        }, 30000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.result, null, 2)
          }]
        };
      }

      case "figma_set_variables_mode": {
        const capture = args.capture !== false;
        const scale = args.scale || 1.5;
        const response = await sendCommandToPlugin({
          type: "SET_VARIABLES_MODE",
          collection_name: args.collection_name,
          mode_name: args.mode_name,
          target_id: args.target_id,
          capture: capture,
          scale: scale
        }, 35000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma Variable Mode Updated: ${resText}`
        });

        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      case "figma_insert_svg": {
        const capture = args.capture !== false;
        const scale = args.scale || 2.0;
        const response = await sendCommandToPlugin({
          type: "INSERT_SVG",
          svg_code: args.svg_code,
          name: args.name,
          width: args.width,
          height: args.height,
          fill_override: args.fill_override,
          stroke_override: args.stroke_override,
          color_override: args.color_override,
          target_parent_id: args.target_parent_id,
          position: args.position,
          as_component: args.as_component === true,
          capture: capture,
          scale: scale
        }, 40000);

        const content = [];
        const resText = typeof response.result === "object" ? JSON.stringify(response.result, null, 2) : String(response.result);
        content.push({
          type: "text",
          text: `Figma SVG Vector Inserted: ${resText}`
        });

        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      case "figma_get_canvas_layout": {
        const response = await sendCommandToPlugin({
          type: "GET_CANVAS_LAYOUT",
          direction: args.direction || "RIGHT",
          gap: args.gap || 80
        }, 30000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.result, null, 2)
          }]
        };
      }

      // REST API
      case "get_me": {
        const data = await figmaApiRequest("/me");
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_file": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const depth = args.depth || 2;
        const data = await figmaApiRequest(`/files/${fileKey}?depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const output = optimizeFigmaData(data, {
          format,
          simplify,
          maxDepth: args.max_depth || 25,
          includeHidden: args.include_hidden === true
        });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_node": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        let nodeIds = args.node_ids || parsed.nodeId;
        if (!nodeIds) throw new Error("No node_ids provided.");
        nodeIds = nodeIds.replace(/-/g, ":");
        const depth = args.depth || 3;
        const data = await figmaApiRequest(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeIds)}&depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const output = optimizeFigmaData(data, {
          format,
          simplify,
          maxDepth: args.max_depth || 25,
          includeHidden: args.include_hidden === true
        });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_image": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        let nodeIds = args.node_ids || parsed.nodeId;
        if (!nodeIds) throw new Error("No node_ids provided.");
        nodeIds = nodeIds.replace(/-/g, ":");
        const format = args.format || "png";
        const scale = args.scale || 2;
        const data = await figmaApiRequest(`/images/${fileKey}?ids=${encodeURIComponent(nodeIds)}&format=${format}&scale=${scale}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_image_fills": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${fileKey}/images`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_styles": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${fileKey}/styles`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_components": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${fileKey}/components`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_comments": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${fileKey}/comments`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "post_comment": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const body = { message: args.message };
        if (args.node_id) body.client_meta = { node_id: args.node_id.replace(/-/g, ":") };
        const data = await figmaApiRequest(`/files/${fileKey}/comments`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Figma Error: ${error.message}` }]
    };
  }
}

// ==========================================
// MCP SDK Loader & Universal Stdio Loop
// ==========================================
function startOfficialSdkServer() {
  const sdkLocations = [
    "@modelcontextprotocol/sdk",
    path.resolve(__dirname, "../google-tasks/node_modules/@modelcontextprotocol/sdk/dist/cjs"),
    path.resolve(__dirname, "node_modules/@modelcontextprotocol/sdk/dist/cjs")
  ];

  for (const loc of sdkLocations) {
    try {
      const serverModule = require(path.join(loc, "server/index.js"));
      const Server = serverModule.Server;
      const StdioServerTransport = require(path.join(loc, "server/stdio.js")).StdioServerTransport;
      const types = require(path.join(loc, "types.js"));

      const server = new Server({
        name: "figma-mcp",
        version: "2.1.0"
      }, {
        capabilities: { tools: {} }
      });

      server.setRequestHandler(types.ListToolsRequestSchema, async () => {
        return { tools: TOOLS };
      });

      server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
        return await handleCallTool(request.params.name, request.params.arguments);
      });

      const transport = new StdioServerTransport();
      server.connect(transport).catch(err => {
        console.error("MCP connection error:", err);
        process.exit(1);
      });
      return true;
    } catch (e) {}
  }
  return false;
}

function startUniversalStdioServer() {
  let buffer = "";

  const sendResponse = (response) => {
    const json = JSON.stringify(response);
    const message = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    process.stdout.write(message);
  };

  const processMessage = async (msg) => {
    if (!msg || typeof msg !== "object") return;
    const { id, method, params } = msg;

    if (method === "initialize") {
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "figma-mcp", version: "2.1.0" }
        }
      });
      return;
    }

    if (method === "notifications/initialized") {
      return; // No response needed
    }

    if (method === "ping") {
      sendResponse({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      sendResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const toolName = params ? params.name : "";
      const toolArgs = params ? params.arguments : {};
      const result = await handleCallTool(toolName, toolArgs);
      sendResponse({ jsonrpc: "2.0", id, result });
      return;
    }

    if (id !== undefined) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      // Content-Length framing
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const header = buffer.substring(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          if (Buffer.byteLength(buffer.substring(bodyStart), "utf8") >= contentLength) {
            const body = buffer.substring(bodyStart, bodyStart + contentLength);
            buffer = buffer.substring(bodyStart + contentLength);
            try {
              const msg = JSON.parse(body);
              processMessage(msg);
            } catch (e) {}
            continue;
          }
        }
      }

      // Line-delimited fallback
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd !== -1 && headerEnd === -1) {
        const line = buffer.substring(0, lineEnd).trim();
        buffer = buffer.substring(lineEnd + 1);
        if (line.length > 0) {
          try {
            const msg = JSON.parse(line);
            processMessage(msg);
          } catch (e) {}
          continue;
        }
      }
      break;
    }
  });
}

// Start either official SDK server or universal stdio engine
if (!startOfficialSdkServer()) {
  startUniversalStdioServer();
}
