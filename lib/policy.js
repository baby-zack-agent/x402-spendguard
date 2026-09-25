'use strict';
// Policy schema, validation, and per-agent resolution.
// Amounts are USD. A cap of null/undefined means unlimited.
const fs = require('node:fs');

const DEFAULTS = {
  dailyCap: 50,
  weeklyCap: 200,
  monthlyCap: 500,
  perTxCap: 25,
  allowlist: [],
  denylist: [],
  approvalThreshold: 100,
};

const NUMERIC_FIELDS = ['dailyCap', 'weeklyCap', 'monthlyCap', 'perTxCap', 'approvalThreshold'];
const LIST_FIELDS = ['allowlist', 'denylist'];

function isValidCap(v) {
  return v === null || v === undefined ||
    (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

function validateSection(section, where) {
  const errors = [];
  for (const f of NUMERIC_FIELDS) {
    if (section[f] !== undefined && !isValidCap(section[f])) {
      errors.push(`${where}.${f} must be a non-negative number or null (unlimited)`);
    }
  }
  for (const f of LIST_FIELDS) {
    if (section[f] !== undefined && !Array.isArray(section[f])) {
      errors.push(`${where}.${f} must be an array of recipient addresses`);
    }
  }
  return errors;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['policy must be an object'];
  }
  const errors = [];
  errors.push(...validateSection(policy.defaults || {}, 'defaults'));
  const agents = policy.agents || {};
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    errors.push('agents must be an object keyed by agent id');
  } else {
    for (const [id, ov] of Object.entries(agents)) {
      if (!ov || typeof ov !== 'object' || Array.isArray(ov)) {
        errors.push(`agents.${id} must be an object`);
        continue;
      }
      errors.push(...validateSection(ov, `agents.${id}`));
    }
  }
  return errors;
}

// Merge order: built-in defaults < policy.defaults < agents[agentId].
function effectivePolicy(policy, agentId) {
  const merged = {
    ...DEFAULTS,
    ...(policy.defaults || {}),
    ...((policy.agents || {})[agentId] || {}),
  };
  merged.allowlist = (merged.allowlist || []).map(String);
  merged.denylist = (merged.denylist || []).map(String);
  return merged;
}

function loadPolicy(path) {
  const raw = fs.readFileSync(path, 'utf8');
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (e) {
    throw new Error(`policy file is not valid JSON: ${e.message}`);
  }
  const errors = validatePolicy(policy);
  if (errors.length) {
    throw new Error('invalid policy: ' + errors.join('; '));
  }
  return policy;
}

module.exports = { DEFAULTS, loadPolicy, validatePolicy, effectivePolicy };
