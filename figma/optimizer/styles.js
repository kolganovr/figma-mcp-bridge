/**
 * Style & Color Formatters for Figma Context Optimizer (CommonJS)
 */

function toHexByte(n) {
  const v = Math.max(0, Math.min(255, Math.round(n * 255)));
  return v.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Converts Figma color object {r, g, b, a} to Hex or CSS string.
 *
 * The REST API carries transparency in TWO independent places: `color.a` on the
 * colour itself and `opacity` on the Paint wrapping it. `color.a` is emitted on
 * every solid paint (almost always 1), so reading only it silently discarded
 * every paint-level opacity — a 20% scrim came back as opaque #000000.
 * They multiply, exactly like Figma composites them.
 */
function formatColor(color, opacity = 1) {
  if (!color || typeof color !== 'object') return null;

  const r = toHexByte(color.r || 0);
  const g = toHexByte(color.g || 0);
  const b = toHexByte(color.b || 0);
  const channelAlpha = typeof color.a === 'number' ? color.a : 1;
  const paintAlpha = typeof opacity === 'number' ? opacity : 1;
  const a = channelAlpha * paintAlpha;

  if (a < 0.99) {
    const alphaRound = Math.round(a * 100) / 100;
    return `rgba(${Math.round((color.r || 0) * 255)}, ${Math.round((color.g || 0) * 255)}, ${Math.round((color.b || 0) * 255)}, ${alphaRound})`;
  }

  return `#${r}${g}${b}`;
}

/**
 * Formats a Figma Paint object (Solid, Gradient, Image)
 */
function formatPaint(paint) {
  if (!paint || paint.visible === false) return null;

  if (paint.type === 'SOLID') {
    const opacity = typeof paint.opacity === 'number' ? paint.opacity : 1;
    return formatColor(paint.color, opacity);
  }

  if (paint.type && paint.type.startsWith('GRADIENT_')) {
    const type = paint.type.toLowerCase().replace('gradient_', '');
    const gradientOpacity = typeof paint.opacity === 'number' ? paint.opacity : 1;
    if (paint.gradientStops && Array.isArray(paint.gradientStops)) {
      const stops = paint.gradientStops.map(s => {
        const col = formatColor(s.color, gradientOpacity);
        const pos = Math.round((s.position || 0) * 100);
        return `${col} ${pos}%`;
      }).join(', ');
      return `${type}-gradient(${stops})`;
    }
    return `${type}-gradient(...)`;
  }

  if (paint.type === 'IMAGE') {
    return `image(${paint.imageRef || 'ref'})`;
  }

  return paint.type ? paint.type.toLowerCase() : null;
}

/**
 * Formats an array of fills/strokes into a compact string or single value
 */
function formatPaints(paints) {
  if (!paints || !Array.isArray(paints) || paints.length === 0) return null;
  const active = paints.filter(p => p.visible !== false).map(formatPaint).filter(Boolean);
  if (active.length === 0) return null;
  return active.length === 1 ? active[0] : active.join('; ');
}

/**
 * Formats typography properties into a single readable CSS-like shorthand
 */
function formatTypography(style) {
  if (!style || typeof style !== 'object') return null;

  const parts = [];
  if (style.fontFamily) parts.push(style.fontFamily);
  if (style.fontWeight && style.fontWeight !== 400) {
    const weightMap = { 300: 'Light', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
    parts.push(weightMap[style.fontWeight] || style.fontWeight);
  }
  if (style.italic) parts.push('Italic');
  if (style.fontSize) parts.push(`${Math.round(style.fontSize)}px`);
  // Only omit line-height when it matches the implicit 1.2 default; with no
  // fontSize to compare against, `fontSize * 1.2` was NaN and the check always
  // passed, emitting a redundant lh= on every such node.
  if (style.lineHeightPx) {
    const implicitLh = typeof style.fontSize === 'number' ? Math.round(style.fontSize * 1.2) : null;
    if (implicitLh === null || Math.round(style.lineHeightPx) !== implicitLh) {
      parts.push(`lh=${Math.round(style.lineHeightPx)}px`);
    }
  }
  if (style.letterSpacing && Math.abs(style.letterSpacing) > 0.01) {
    parts.push(`ls=${Math.round(style.letterSpacing * 100) / 100}px`);
  }
  if (style.textAlignHorizontal && style.textAlignHorizontal !== 'LEFT') {
    parts.push(`align=${style.textAlignHorizontal.toLowerCase()}`);
  }

  return parts.join(' ');
}

/**
 * Formats padding values into CSS-like shorthand: "16", "12, 16", or "12, 16, 14, 16"
 */
function formatPadding(node) {
  const top = Math.round(node.paddingTop || 0);
  const right = Math.round(node.paddingRight || 0);
  const bottom = Math.round(node.paddingBottom || 0);
  const left = Math.round(node.paddingLeft || 0);

  if (top === 0 && right === 0 && bottom === 0 && left === 0) return null;

  if (top === right && right === bottom && bottom === left) {
    return `${top}`;
  }
  if (top === bottom && left === right) {
    return `${top}, ${left}`;
  }
  return `${top}, ${right}, ${bottom}, ${left}`;
}

/**
 * Formats corner radius into a compact string
 */
function formatCornerRadius(node) {
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    return `${Math.round(node.cornerRadius)}`;
  }
  if (node.rectangleCornerRadii && Array.isArray(node.rectangleCornerRadii)) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii.map(r => Math.round(r || 0));
    if (tl || tr || br || bl) {
      if (tl === tr && tr === br && br === bl) return `${tl}`;
      return `${tl}, ${tr}, ${br}, ${bl}`;
    }
  }
  return null;
}

module.exports = {
  formatColor,
  formatPaint,
  formatPaints,
  formatTypography,
  formatPadding,
  formatCornerRadius
};
