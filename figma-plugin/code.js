figma.showUI(__html__, { width: 360, height: 390, themeColors: true });

let autoZoomEnabled = true;
let smartPlacementEnabled = true;

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

async function exportNodeToPngBase64(node, scale = 1.5) {
  if (!node) return null;
  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale }
    });
    return bytesToBase64(bytes);
  } catch (err) {
    return null;
  }
}

// Helper to safely apply text overrides to nested text layers inside an instance
async function applyTextOverrides(container, overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  const textNodes = container.findAll ? container.findAll(n => n.type === 'TEXT') : [];
  
  for (const [key, val] of Object.entries(overrides)) {
    const targetKey = key.trim().toLowerCase();
    for (const textNode of textNodes) {
      const nodeName = (textNode.name || '').trim().toLowerCase();
      const nodeChars = (textNode.characters || '').trim().toLowerCase();
      
      if (nodeName === targetKey || nodeChars === targetKey || nodeName.includes(targetKey)) {
        try {
          if (textNode.fontName === figma.mixed) {
            const len = textNode.characters.length;
            for (let i = 0; i < len; i++) {
              const font = textNode.getRangeFontName(i, i + 1);
              if (font && font.family) {
                await ensureFont(font.family, font.style);
              }
            }
          } else if (textNode.fontName) {
            await ensureFont(textNode.fontName.family, textNode.fontName.style);
          }
          textNode.characters = String(val);
        } catch (e) {
          // Continue with next text node
        }
      }
    }
  }
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
    if (hex.length >= 6) {
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      return { r, g, b };
    }
  }

  const rgbMatch = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10) / 255,
      g: parseInt(rgbMatch[2], 10) / 255,
      b: parseInt(rgbMatch[3], 10) / 255
    };
  }

  return null;
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

// Smart Canvas Placement Engine: Calculate free position on canvas avoiding overlaps
function getFreeCanvasPosition(width = 400, height = 800, options = {}) {
  const gap = typeof options.gap === 'number' ? options.gap : 80;
  const direction = (options.direction || 'RIGHT').toUpperCase();
  const page = figma.currentPage;
  const topNodes = page.children.filter(n => n.visible !== false);

  if (topNodes.length === 0) {
    return { x: 0, y: 0 };
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of topNodes) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y < minY) minY = n.y;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }

  if (direction === 'BOTTOM') {
    return {
      x: isFinite(minX) ? Math.round(minX) : 0,
      y: isFinite(maxY) ? Math.round(maxY + gap) : 0
    };
  }

  return {
    x: isFinite(maxX) ? Math.round(maxX + gap) : 0,
    y: isFinite(minY) ? Math.round(minY) : 0
  };
}

// Auto-position node if placed at default (0, 0) or overlapping other top-level nodes
function autoPositionIfColliding(node, gap = 80) {
  if (!node || node.parent !== figma.currentPage) return;
  const otherNodes = figma.currentPage.children.filter(n => n !== node && n.visible !== false);
  if (otherNodes.length === 0) return;

  function isColliding(x, y, w, h) {
    for (const o of otherNodes) {
      const overlapX = (x < o.x + o.width) && (x + w > o.x);
      const overlapY = (y < o.y + o.height) && (y + h > o.y);
      if (overlapX && overlapY) return true;
    }
    return false;
  }

  if ((node.x === 0 && node.y === 0) || isColliding(node.x, node.y, node.width, node.height)) {
    const freePos = getFreeCanvasPosition(node.width, node.height, { gap });
    node.x = freePos.x;
    node.y = freePos.y;
  }
}

figma.ui.onmessage = async (msg) => {
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
    const { id, code, description, capture, scale = 1.5, autoZoom = true, startTime } = msg;
    const actionLabel = description || "AI Command Execution";

    let runningToast = null;
    try {
      runningToast = figma.notify(`🤖 ${actionLabel}...`, { timeout: 30000 });
    } catch (e) {}

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

    try {
      await ensureFont("Inter", "Regular");
      await ensureFont("Inter", "Medium");
      await ensureFont("Inter", "Bold");

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction('figma', 'ensureFont', 'notify', 'log', 'getFreePosition', 'getFreeCanvasPosition', `
        ${code}
      `);

      const result = await fn(figma, ensureFont, notifyCanvas, logToUi, getFreeCanvasPosition, getFreeCanvasPosition);

      let screenshot = null;
      let targetName = null;
      let targetId = null;

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

      if (capture) {
        const targetNode = selection.length > 0 ? selection[0] : figma.currentPage;
        targetName = targetNode.name || "Canvas";
        targetId = targetNode.id;
        screenshot = await exportNodeToPngBase64(targetNode, scale);
      }

      if (runningToast) runningToast.cancel();
      if (capture && screenshot) {
        figma.notify(`✅ ${actionLabel} + 📸 capture sent to AI`, { timeout: 3000 });
      } else {
        figma.notify(`✅ ${actionLabel} — done!`, { timeout: 2500 });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: result !== undefined ? result : "Execution finished successfully",
        screenshot: screenshot,
        targetName: targetName,
        targetId: targetId,
        startTime: startTime
      });
    } catch (err) {
      if (runningToast) runningToast.cancel();
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
        const b64 = await exportNodeToPngBase64(target, scale);
        screenshots.push({
          id: target.id,
          name: target.name || "Node",
          base64: b64
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
    const { id, query = '', page_name, include_variants = true, limit = 30, startTime } = msg;
    const actionLabel = `Find Components${query ? ` ("${query}")` : ''}`;

    try {
      const searchPages = page_name
        ? figma.root.children.filter(p => p.name.toLowerCase() === page_name.toLowerCase())
        : figma.root.children;

      const q = query.trim().toLowerCase();
      const results = [];

      for (const page of searchPages) {
        const allNodes = page.findAll(n => n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && n.parent && n.parent.type !== 'COMPONENT_SET'));

        for (const node of allNodes) {
          const name = node.name || '';
          const desc = node.description || '';
          const isComponentSet = node.type === 'COMPONENT_SET';

          // Extract variants & properties map
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

            // Fallback: extract variants from child component variantProperties
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

          // Check search query matching
          let matches = true;
          if (q) {
            const inName = name.toLowerCase().includes(q);
            const inDesc = desc.toLowerCase().includes(q);
            let inVariants = false;
            if (variantsMap) {
              for (const [k, vals] of Object.entries(variantsMap)) {
                if (k.toLowerCase().includes(q) || vals.some(v => String(v).toLowerCase().includes(q))) {
                  inVariants = true;
                  break;
                }
              }
            }
            matches = inName || inDesc || inVariants;
          }

          if (matches) {
            const item = {
              id: node.id,
              name: name,
              type: node.type,
              key: node.key,
              page: page.name,
              description: desc || undefined
            };

            if (include_variants && isComponentSet && variantsMap) {
              item.variants = variantsMap;
            }
            if (propDefinitions) {
              item.properties = propDefinitions;
            }

            results.push(item);
            if (results.length >= limit) break;
          }
        }
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
    let runningToast = null;
    try {
      runningToast = figma.notify(`🎨 Inserting component...`, { timeout: 15000 });
    } catch (e) {}

    try {
      await ensureFont("Inter", "Regular");
      await ensureFont("Inter", "Medium");
      await ensureFont("Inter", "Bold");

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
          for (const child of master.children) {
            if (child.type === 'COMPONENT' && child.variantProperties) {
              let match = true;
              for (const [k, v] of Object.entries(properties)) {
                const childValKey = Object.keys(child.variantProperties).find(
                  ck => ck.toLowerCase() === k.toLowerCase()
                );
                if (childValKey && String(child.variantProperties[childValKey]).toLowerCase() !== String(v).toLowerCase()) {
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
        }

        if (!bestChild) {
          bestChild = master.defaultVariant || master.children[0];
        }

        if (!bestChild || bestChild.type !== 'COMPONENT') {
          throw new Error(`Failed to resolve valid variant in ComponentSet "${master.name}"`);
        }

        instance = bestChild.createInstance();

        // Apply remaining properties via setProperties
        if (properties && Object.keys(properties).length > 0) {
          try {
            instance.setProperties(properties);
          } catch (pe) {
            // Some variant properties already matched
          }
        }
      } else {
        throw new Error(`Target node "${master.name}" is of type "${master.type}", not a COMPONENT or COMPONENT_SET.`);
      }

      // 3. Apply Text Overrides
      if (text_overrides && typeof text_overrides === 'object' && Object.keys(text_overrides).length > 0) {
        // Try Component Property Text Overrides first
        for (const [k, v] of Object.entries(text_overrides)) {
          try {
            instance.setProperties({ [k]: String(v) });
          } catch (e) {}
        }
        // Direct nested text layer traversal
        await applyTextOverrides(instance, text_overrides);
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
      if (capture) {
        screenshot = await exportNodeToPngBase64(instance, scale);
      }

      if (runningToast) runningToast.cancel();
      figma.notify(`✅ Inserted ${instance.name}${capture && screenshot ? ' + 📸 capture' : ''}`, { timeout: 3000 });

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
          variantProperties: instance.variantProperties || undefined
        },
        screenshot: screenshot,
        targetName: instance.name,
        targetId: instance.id,
        startTime: startTime
      });
    } catch (err) {
      if (runningToast) runningToast.cancel();
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
  // 5. Design System: Get Variables & Tokens
  // ==========================================
  else if (msg.type === 'GET_VARIABLES') {
    const { id, collection_name, startTime } = msg;
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

      for (const col of filteredCollections) {
        collData.push({
          id: col.id,
          name: col.name,
          defaultModeId: col.defaultModeId,
          modes: col.modes.map(m => ({ modeId: m.modeId, name: m.name })),
          variableIds: col.variableIds
        });

        // Collect variables belonging to this collection
        const colVars = variables.filter(v => v.variableCollectionId === col.id);
        for (const v of colVars) {
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
          tokens: tokensData
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
      if (capture) {
        screenshot = await exportNodeToPngBase64(targetNode, scale);
      }

      figma.notify(`🌓 Theme switched to "${targetMode.name}" on ${targetNode.name}`, { timeout: 3000 });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: `Successfully set mode "${targetMode.name}" (${targetMode.modeId}) for collection "${col.name}" on "${targetNode.name}"`,
        screenshot: screenshot,
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
    let runningToast = null;
    try {
      runningToast = figma.notify(`📐 Inserting vector SVG...`, { timeout: 15000 });
    } catch (e) {}

    try {
      if (!svg_code || typeof svg_code !== 'string' || !svg_code.includes('<svg')) {
        throw new Error("Invalid or empty svg_code. Must be a valid <svg ...>...</svg> XML string.");
      }

      // 1. Create node from SVG
      const rawNode = figma.createNodeFromSvg(svg_code);
      rawNode.name = name || "SVG Vector";

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
      if (capture) {
        screenshot = await exportNodeToPngBase64(finalNode, scale);
      }

      if (runningToast) runningToast.cancel();
      figma.notify(`✅ Vector inserted: ${finalNode.name}${capture && screenshot ? ' + 📸 capture' : ''}`, { timeout: 3000 });

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
        targetName: finalNode.name,
        targetId: finalNode.id,
        startTime: startTime
      });
    } catch (err) {
      if (runningToast) runningToast.cancel();
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
  // 8. Canvas Layout & Smart Bounds
  // ==========================================
  else if (msg.type === 'GET_CANVAS_LAYOUT') {
    const { id, direction = 'RIGHT', gap = 80, startTime } = msg;
    const actionLabel = "Get Canvas Layout";

    try {
      const page = figma.currentPage;
      const topNodes = page.children.filter(n => n.visible !== false);

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const artboards = [];

      for (const n of topNodes) {
        if (n.x < minX) minX = n.x;
        if (n.x + n.width > maxX) maxX = n.x + n.width;
        if (n.y < minY) minY = n.y;
        if (n.y + n.height > maxY) maxY = n.y + n.height;

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

      const suggestedPos = getFreeCanvasPosition(400, 800, { direction, gap });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          pageName: page.name,
          totalArtboards: artboards.length,
          artboards: artboards,
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
};
