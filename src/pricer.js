const fs = require('fs');
const path = require('path');

let pricingTable = null;

function loadPricing() {
  if (pricingTable) return pricingTable;
  const pricingPath = path.join(__dirname, '..', 'pricing.json');
  pricingTable = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
  return pricingTable;
}

function getClaudePrice(modelName) {
  const table = loadPricing();
  const model = (modelName || '').toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const entry of table.claude) {
    if (entry.pattern === 'default') continue;
    // Forward match: full model id contains the pattern (e.g. 'claude-sonnet-4-20250514' includes 'claude-sonnet-4').
    // Reverse match: short alias is contained by the pattern (e.g. pattern 'claude-sonnet-4' includes alias 'sonnet').
    // Rank by pattern.length so longer / more specific patterns always win.
    const matches = model.includes(entry.pattern) ||
      (model.length >= 3 && entry.pattern.includes(model));
    if (matches && entry.pattern.length > bestLen) {
      best = entry;
      bestLen = entry.pattern.length;
    }
  }
  if (!best) best = table.claude.find(e => e.pattern === 'default');
  return best;
}

function getGeminiPrice(modelName) {
  const table = loadPricing();
  const model = (modelName || '').toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const entry of table.gemini) {
    if (entry.pattern === 'default') continue;
    // Same bidirectional matching as getClaudePrice.
    const matches = model.includes(entry.pattern) ||
      (model.length >= 3 && entry.pattern.includes(model));
    if (matches && entry.pattern.length > bestLen) {
      best = entry;
      bestLen = entry.pattern.length;
    }
  }
  if (!best) best = table.gemini.find(e => e.pattern === 'default');
  return best;
}

function calcClaudeCost(modelName, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  const price = getClaudePrice(modelName);
  const M = 1_000_000;
  let cost = (inputTokens / M) * price.input + (outputTokens / M) * price.output;
  if (price.cacheRead != null) cost += (cacheReadTokens / M) * price.cacheRead;
  if (price.cacheWrite != null) cost += (cacheWriteTokens / M) * price.cacheWrite;
  return cost;
}

function calcGeminiCost(modelName, inputTokens, outputTokens) {
  const price = getGeminiPrice(modelName);
  const M = 1_000_000;
  return (inputTokens / M) * price.input + (outputTokens / M) * price.output;
}

// How much cache reads saved vs paying full input price
function calcCacheSavings(modelName, cacheReadTokens) {
  const price = getClaudePrice(modelName);
  if (!price || price.cacheRead == null) return 0;
  const M = 1_000_000;
  const withoutCache = (cacheReadTokens / M) * price.input;
  const withCache = (cacheReadTokens / M) * price.cacheRead;
  return withoutCache - withCache;
}

module.exports = { calcClaudeCost, calcGeminiCost, calcCacheSavings, getClaudePrice, getGeminiPrice };
