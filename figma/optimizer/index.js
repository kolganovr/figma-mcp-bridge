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

  if (format === 'raw' || !simplify || !rawData) {
    return JSON.stringify(rawData, null, 2);
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
    return JSON.stringify(rawData, null, 2);
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

  const header = `<!-- Optimized Figma Layout (${reductionPercent}% Token Reduction | ${Math.round(originalBytes / 1024)} KB -> ${Math.round(optimizedBytes / 1024 * 10) / 10} KB) -->\n`;

  return header + formattedOutput;
}

module.exports = {
  optimizeFigmaData
};
