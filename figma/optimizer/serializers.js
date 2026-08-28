/**
 * Serializers for Optimized Figma AST: Pseudo-JSX, Indented Tree, and JSON (CommonJS)
 */

function escapeJsxText(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Variant keys become attribute names, and Figma allows spaces / punctuation in
// them ("Size (px)"), which would produce unparseable pseudo-JSX.
function toAttrName(key) {
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z_]+/, '');
  return safe || 'prop';
}

/**
 * Serializes a pruned Figma node tree to clean, semantic Pseudo-JSX
 */
function serializeToJsx(node, indent = 0) {
  if (!node) return '';

  const spaces = '  '.repeat(indent);
  const tag = getJsxTagName(node);
  const props = [];

  // Node id comes first and is never omitted: every follow-up call the agent can
  // make (get_node, get_image, target_parent_id, figma.getNodeById) needs it, and
  // without it the only way to obtain one was a second full fetch in tree format.
  if (node.id) {
    props.push(`id="${escapeAttr(node.id)}"`);
  }

  // Name (omit if generic like "Frame 1" or "Vector")
  if (node.name && !isGenericName(node.name, node.type)) {
    props.push(`name="${escapeAttr(node.name)}"`);
  }

  // Dimensions
  if (node.width && node.height) {
    if (node.type === 'ICON' && node.width === node.height) {
      props.push(`size="${node.width}"`);
    } else {
      props.push(`w="${node.width}"`);
      props.push(`h="${node.height}"`);
    }
  }

  // Coordinates (only for root or absolute positioning)
  if (typeof node.x === 'number' && typeof node.y === 'number') {
    props.push(`x="${node.x}"`);
    props.push(`y="${node.y}"`);
  }

  // AutoLayout
  if (node.layout) {
    props.push(node.layout === 'HORIZONTAL' ? 'row' : 'col');
    if (node.gap) props.push(`gap="${node.gap}"`);
    if (node.pad) props.push(`pad="${node.pad}"`);
    if (node.align) props.push(`align="${node.align}"`);
    if (node.justify) props.push(`justify="${node.justify}"`);
    if (node.wrap) props.push('wrap');
  }

  // Sizing
  if (node.sizingH) props.push(`sizingH="${node.sizingH}"`);
  if (node.sizingV) props.push(`sizingV="${node.sizingV}"`);

  // Styles
  if (node.type === 'TEXT') {
    if (node.color || node.bg) props.push(`color="${escapeAttr(node.color || node.bg)}"`);
  } else {
    if (node.bg) props.push(`bg="${escapeAttr(node.bg)}"`);
  }

  if (node.stroke) props.push(`stroke="${escapeAttr(node.stroke)}"`);
  if (node.strokeWidth) props.push(`strokeWidth="${node.strokeWidth}"`);
  if (node.radius) props.push(`radius="${node.radius}"`);
  if (typeof node.opacity === 'number') props.push(`opacity="${node.opacity}"`);

  // Text specifics
  if (node.type === 'TEXT') {
    if (node.font) props.push(`font="${escapeAttr(node.font)}"`);
  }

  // Component Variants
  if (node.variants) {
    for (const [k, v] of Object.entries(node.variants)) {
      props.push(`${toAttrName(k)}="${escapeAttr(v)}"`);
    }
  }

  const propsStr = props.length > 0 ? ' ' + props.join(' ') : '';

  // Leaf TEXT node
  if (node.type === 'TEXT') {
    const textContent = escapeJsxText(node.text || '');
    if (textContent.includes('\n')) {
      return `${spaces}<${tag}${propsStr}>\n${spaces}  ${textContent.split('\n').join(`\n${spaces}  `)}\n${spaces}</${tag}>`;
    }
    return `${spaces}<${tag}${propsStr}>${textContent}</${tag}>`;
  }

  // Self-closing node (no children)
  if (!node.children || node.children.length === 0) {
    return `${spaces}<${tag}${propsStr} />`;
  }

  // Node with children
  const childrenJsx = node.children
    .map(child => serializeToJsx(child, indent + 1))
    .filter(Boolean)
    .join('\n');

  return `${spaces}<${tag}${propsStr}>\n${childrenJsx}\n${spaces}</${tag}>`;
}

function getJsxTagName(node) {
  if (node.type === 'ICON') return 'Icon';
  if (node.type === 'TEXT') return 'Text';
  if (node.type === 'INSTANCE') return 'Instance';
  if (node.type === 'COMPONENT') return 'Component';
  if (node.type === 'COMPONENT_SET') return 'ComponentSet';
  if (node.type === 'FRAME' || node.type === 'SECTION') return 'Frame';
  if (node.type === 'GROUP') return 'Group';
  if (node.type === 'RECTANGLE') return 'Box';
  if (node.type === 'CANVAS') return 'Page';
  if (node.type === 'DOCUMENT') return 'Document';
  return 'Node';
}

function isGenericName(name, type) {
  if (!name) return true;
  const lower = name.toLowerCase();
  return lower === 'frame' || lower === 'group' || lower === 'rectangle' || lower === 'vector' || /^frame \d+$/.test(lower) || /^group \d+$/.test(lower);
}

/**
 * Serializes a pruned Figma node tree to an Indented Text Tree format
 */
function serializeToTree(node, indent = 0) {
  if (!node) return '';

  const spaces = '  '.repeat(indent);
  const typeTag = `[${node.type || 'NODE'}]`;
  const nameStr = node.name ? ` "${node.name}"` : '';
  const idStr = node.id ? ` #${node.id}` : '';

  const attrs = [];
  if (node.layout) {
    attrs.push(node.layout === 'HORIZONTAL' ? 'row' : 'col');
    if (node.gap) attrs.push(`gap=${node.gap}`);
    if (node.pad) attrs.push(`pad=${node.pad}`);
    if (node.align) attrs.push(`align=${node.align}`);
    if (node.justify) attrs.push(`justify=${node.justify}`);
  }

  if (node.width && node.height) {
    attrs.push(`(${node.width}x${node.height})`);
  }

  if (node.bg) attrs.push(`bg=${node.bg}`);
  if (node.stroke) attrs.push(`stroke=${node.stroke}`);
  if (node.radius) attrs.push(`r=${node.radius}`);

  if (node.type === 'TEXT') {
    if (node.font) attrs.push(`font="${node.font}"`);
  }

  const attrsStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  let line = `${spaces}${typeTag}${nameStr}${idStr}${attrsStr}`;

  if (node.type === 'TEXT' && node.text) {
    const cleanText = node.text.replace(/\r?\n/g, ' ');
    const preview = cleanText.length > 40 ? cleanText.slice(0, 37) + '...' : cleanText;
    line += `: "${preview}"`;
  }

  if (!node.children || node.children.length === 0) {
    return line;
  }

  const childrenLines = node.children
    .map(child => serializeToTree(child, indent + 1))
    .filter(Boolean)
    .join('\n');

  return `${line}\n${childrenLines}`;
}

/**
 * Serializes pruned AST to compact JSON
 */
function serializeToJson(node) {
  return JSON.stringify(node, null, 2);
}

module.exports = {
  serializeToJsx,
  serializeToTree,
  serializeToJson
};
