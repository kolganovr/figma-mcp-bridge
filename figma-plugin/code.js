figma.showUI(__html__, { width: 360, height: 480, themeColors: true });

let autoZoomEnabled = true;

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

// Auto-load standard Inter fonts
async function ensureFont(family = "Inter", style = "Regular") {
  try {
    await figma.loadFontAsync({ family, style });
  } catch (e) {
    try {
      await figma.loadFontAsync({ family: "Roboto", style: "Regular" });
    } catch (e2) {}
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

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'SET_AUTO_ZOOM') {
    autoZoomEnabled = msg.value === true;
    return;
  }

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
      const fn = new AsyncFunction('figma', 'ensureFont', 'notify', 'log', `
        ${code}
      `);

      const result = await fn(figma, ensureFont, notifyCanvas, logToUi);

      let screenshot = null;
      let targetName = null;
      let targetId = null;

      const selection = figma.currentPage.selection;
      if (selection.length > 0 && autoZoom && autoZoomEnabled) {
        figma.viewport.scrollAndZoomIntoView(selection);
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
  } else if (msg.type === 'SCREENSHOT') {
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
};
