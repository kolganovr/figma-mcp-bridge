/**
 * Context Optimizer Entry Point for Figma MCP Bridge (CommonJS)
 */

const { pruneNode } = require('./pruner.js');
const { serializeToJsx, serializeToTree, serializeToJson } = require('./serializers.js');

/**
 * Optimizes Figma REST API payload to token-efficient JSX, Tree, or JSON format
 *
 * @param {Object} rawData - Response from Figma REST API (get_file or get_node)
 * @param {Object} options
 * @param {'jsx'|'tree'|'json'|'raw'} [options.format='jsx'] - Target serialization format
 * @param {boolean} [options.simplify=true] - Whether to apply pruning & vector collapsing
 * @param {number} [options.maxDepth=25] - Maximum tree traversal depth
 * @param {boolean} [options.includeHidden=false] - Whether to include hidden layers
 * @returns {string} Formatted output string ready for LLM prompt context
 */
function optimizeFigmaData(rawData, options = {}) {
  const format = (options.format || 'jsx').toLowerCase();
  const simplify = options.simplify !== false;

  // Unindented on purpose: pretty-printing the escape hatch cost ~30% more
  // tokens than the payload it was escaping to.
  if (format === 'raw' || !simplify || !rawData) {
    return JSON.stringify(rawData);
  }

  const rawJsonStr = JSON.stringify(rawData);
  const originalBytes = Buffer.byteLength(rawJsonStr, 'utf8');

  // Handle both get_file (rawData.document) and get_node (rawData.nodes)
  let targetNodes = [];

  if (rawData.nodes && typeof rawData.nodes === 'object') {
    for (const [nodeId, nodeObj] of Object.entries(rawData.nodes)) {
      if (nodeObj && nodeObj.document) {
        targetNodes.push(nodeObj.document);
      }
    }
  } else if (rawData.document) {
    targetNodes = [rawData.document];
  } else if (rawData.type && rawData.id) {
    targetNodes = [rawData];
  }

  if (targetNodes.length === 0) {
    return JSON.stringify(rawData);
  }

  const prunedTrees = targetNodes
    .map(node => pruneNode(node, 0, options))
    .filter(Boolean);

  let formattedOutput = '';

  if (format === 'tree') {
    formattedOutput = prunedTrees.map(tree => serializeToTree(tree, 0)).join('\n\n');
  } else if (format === 'json') {
    formattedOutput = serializeToJson(prunedTrees.length === 1 ? prunedTrees[0] : prunedTrees);
  } else {
    // Default: 'jsx'
    formattedOutput = prunedTrees.map(tree => serializeToJsx(tree, 0)).join('\n\n');
  }

  const optimizedBytes = Buffer.byteLength(formattedOutput, 'utf8');
  const reductionPercent = originalBytes > 0
    ? Math.round((1 - (optimizedBytes / originalBytes)) * 1000) / 10
    : 0;

  // Document-level metadata used to be dropped on the floor: only `document` was
  // read, so `get_file` never delivered the "file metadata" its description
  // promised. Summarised rather than inlined — the full maps are large and the
  // agent can pull them with get_styles / get_components when it needs them.
  const metaParts = [];
  if (rawData.name) metaParts.push(`file="${rawData.name}"`);
  if (rawData.lastModified) metaParts.push(`lastModified=${rawData.lastModified}`);
  if (rawData.version) metaParts.push(`version=${rawData.version}`);
  const componentCount = rawData.components ? Object.keys(rawData.components).length : 0;
  const styleCount = rawData.styles ? Object.keys(rawData.styles).length : 0;
  if (componentCount) metaParts.push(`components=${componentCount}`);
  if (styleCount) metaParts.push(`styles=${styleCount}`);

  const meta = metaParts.length ? `<!-- ${metaParts.join(' ')} -->\n` : '';
  const header = `<!-- Optimized Figma Layout (${reductionPercent}% smaller than the raw API response | ${Math.round(originalBytes / 1024)} KB -> ${Math.round(optimizedBytes / 1024 * 10) / 10} KB) -->\n`;

  return meta + header + formattedOutput;
}

module.exports = {
  optimizeFigmaData
};
