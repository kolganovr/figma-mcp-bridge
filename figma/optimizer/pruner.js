/**
 * AST Tree Pruner & Vector/Icon Collapser for Figma REST API Data (CommonJS)
 */

const {
  formatPaints,
  formatTypography,
  formatPadding,
  formatCornerRadius
} = require('./styles.js');

const VECTOR_TYPES = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'ELLIPSE',
  'POLYGON',
  'LINE',
  'REGULAR_POLYGON'
]);

/**
 * Checks if a node and all its sub-children are purely vector artwork / icons.
 *
 * Small size alone is NOT evidence of icon-ness: avatars, swatches, toggles,
 * 40px inputs and dividers are all small leaves, and collapsing them to <Icon>
 * threw away their real type, layout and radius. A leaf now has to be an actual
 * vector type, or be icon-named AND small — never small on its own.
 */
function isVectorOrIconCluster(node) {
  if (!node) return false;

  if (VECTOR_TYPES.has(node.type)) {
    return true;
  }

  const nameLower = (node.name || '').toLowerCase();
  const isIconNamed = /^(ic_|icon|logo|glyph|vector|svg|arrow|chevron)[\s_\-/]?/i.test(nameLower);

  const width = node.absoluteBoundingBox?.width || node.size?.x || 0;
  const height = node.absoluteBoundingBox?.height || node.size?.y || 0;
  const isSmall = width > 0 && height > 0 && width <= 64 && height <= 64;

  if (!node.children || node.children.length === 0) {
    // A childless FRAME/RECTANGLE/INSTANCE is real content, not an icon,
    // unless its own name declares otherwise.
    return isIconNamed && isSmall && node.type !== 'TEXT';
  }

  // Check if any descendant is a TEXT node
  let hasText = false;
  let hasOnlyVectors = true;
  let hasRealVector = false;

  function scan(n) {
    if (n.type === 'TEXT') {
      hasText = true;
      return;
    }
    if (VECTOR_TYPES.has(n.type)) {
      hasRealVector = true;
    } else if (n.type !== 'GROUP' && n.type !== 'FRAME' && n.type !== 'INSTANCE') {
      hasOnlyVectors = false;
    }
    if (n.children && Array.isArray(n.children)) {
      for (const child of n.children) {
        scan(child);
        if (hasText) return;
      }
    }
  }

  scan(node);

  if (hasText) return false;

  // A container only collapses when it genuinely wraps vector artwork — a frame
  // of nested frames with no vector in it anywhere is a layout, not an icon.
  return (isIconNamed || isSmall) && hasOnlyVectors && hasRealVector;
}

/**
 * Recursively prunes and simplifies a Figma node AST
 */
function pruneNode(node, depth = 0, options = {}) {
  if (!node || typeof node !== 'object') return null;

  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 25;
  const includeHidden = options.includeHidden === true;

  // 1. Skip hidden layers
  if (node.visible === false && !includeHidden) {
    return null;
  }

  // 2. Depth limit truncation
  if (depth > maxDepth) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      truncated: true
    };
  }

  const width = Math.round(node.absoluteBoundingBox?.width || node.size?.x || 0);
  const height = Math.round(node.absoluteBoundingBox?.height || node.size?.y || 0);

  // 3. Vector / Icon Collapsing: Collapse complex vector hierarchies into a single compact node
  if (isVectorOrIconCluster(node)) {
    const fill = formatPaints(node.fills);
    const stroke = formatPaints(node.strokes);

    return {
      id: node.id,
      name: node.name,
      type: 'ICON',
      width,
      height,
      fill: fill || undefined,
      stroke: stroke || undefined,
      strokeWidth: node.strokeWeight ? Math.round(node.strokeWeight) : undefined
    };
  }

  // 4. Extract Essential Core Properties
  const pruned = {
    id: node.id,
    name: node.name,
    type: node.type
  };

  // Dimensions
  if (width > 0 || height > 0) {
    pruned.width = width;
    pruned.height = height;
  }

  // AutoLayout & Positioning
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    pruned.layout = node.layoutMode; // "HORIZONTAL" | "VERTICAL"

    if (node.itemSpacing && node.itemSpacing > 0) {
      pruned.gap = Math.round(node.itemSpacing);
    }

    const pad = formatPadding(node);
    if (pad) pruned.pad = pad;

    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== 'MIN') {
      pruned.align = node.counterAxisAlignItems; // "CENTER" | "MAX" | "BASELINE"
    }

    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== 'MIN') {
      pruned.justify = node.primaryAxisAlignItems; // "CENTER" | "MAX" | "SPACE_BETWEEN"
    }

    if (node.layoutWrap === 'WRAP') {
      pruned.wrap = true;
    }
  } else {
    // Non-autolayout: preserve coordinates for top-level or absolute elements
    if (depth <= 1 || node.layoutPositioning === 'ABSOLUTE') {
      pruned.x = Math.round(node.absoluteBoundingBox?.x || 0);
      pruned.y = Math.round(node.absoluteBoundingBox?.y || 0);
    }
  }

  // Sizing Modes
  if (node.layoutSizingHorizontal && node.layoutSizingHorizontal !== 'FIXED') {
    pruned.sizingH = node.layoutSizingHorizontal; // "HUG" | "FILL"
  }
  if (node.layoutSizingVertical && node.layoutSizingVertical !== 'FIXED') {
    pruned.sizingV = node.layoutSizingVertical; // "HUG" | "FILL"
  }

  // Styles (Fills, Strokes, Radius)
  const bg = formatPaints(node.fills);
  if (bg) pruned.bg = bg;

  const stroke = formatPaints(node.strokes);
  if (stroke) {
    pruned.stroke = stroke;
    if (node.strokeWeight && node.strokeWeight > 0) {
      pruned.strokeWidth = Math.round(node.strokeWeight);
    }
  }

  const radius = formatCornerRadius(node);
  if (radius) pruned.radius = radius;

  if (typeof node.opacity === 'number' && node.opacity < 0.99) {
    pruned.opacity = Math.round(node.opacity * 100) / 100;
  }

  if (node.clipsContent === true) {
    pruned.clipsContent = true;
  }

  // Text Properties
  if (node.type === 'TEXT') {
    pruned.text = node.characters || '';
    const font = formatTypography(node.style);
    if (font) pruned.font = font;
  }

  // Component & Instance Properties
  if (node.componentId) {
    pruned.componentId = node.componentId;
  }
  if (node.variantProperties && Object.keys(node.variantProperties).length > 0) {
    pruned.variants = node.variantProperties;
  }
  if (node.componentProperties && Object.keys(node.componentProperties).length > 0) {
    pruned.properties = node.componentProperties;
  }

  // Children Traversal
  if (node.children && Array.isArray(node.children)) {
    const prunedChildren = [];
    for (const child of node.children) {
      const p = pruneNode(child, depth + 1, options);
      if (p) prunedChildren.push(p);
    }
    if (prunedChildren.length > 0) {
      pruned.children = prunedChildren;
    }
  }

  return pruned;
}

module.exports = {
  isVectorOrIconCluster,
  pruneNode
};
