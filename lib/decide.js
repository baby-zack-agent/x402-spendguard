'use strict';
// Pure policy decision function. No I/O, no side effects, no clocks.
// input:  { agentId, to, amountUsd, asset? }
// eff:    merged policy from policy.effectivePolicy(agentId)
// usage:  { day, week, month } — USD already spent by this agent in each
//         rolling window (from audit.usageFor). Only 'allow' decisions count.
function norm(addr) {
  return String(addr || '').toLowerCase();
}

function decide(input, eff, usage) {
  const { agentId, to, amountUsd } = input || {};
  usage = usage || { day: 0, week: 0, month: 0 };

  if (!agentId || typeof agentId !== 'string') {
    return { decision: 'deny', reasons: ['missing agentId'] };
  }
  if (!to || typeof to !== 'string') {
    return { decision: 'deny', reasons: ['missing recipient address'] };
  }
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { decision: 'deny', reasons: ['invalid amountUsd: must be a positive number'] };
  }

  const target = norm(to);
  const deny = eff.denylist.map(norm);
  const allow = eff.allowlist.map(norm);

  // Hard blocks first: explicit deny always wins.
  if (deny.includes(target)) {
    return { decision: 'deny', reasons: [`recipient ${to} is on the denylist`] };
  }
  if (eff.perTxCap != null && amountUsd > eff.perTxCap) {
    return {
      decision: 'deny',
      reasons: [`amount $${amountUsd} exceeds per-transaction cap of $${eff.perTxCap}`],
    };
  }
  if (allow.length > 0 && !allow.includes(target)) {
    return {
      decision: 'deny',
      reasons: [`recipient ${to} is not on the allowlist`],
    };
  }
  if (eff.approvalThreshold != null && amountUsd > eff.approvalThreshold) {
    return {
      decision: 'needs_approval',
      reasons: [`amount $${amountUsd} exceeds approval threshold of $${eff.approvalThreshold} — human approval required`],
    };
  }

  const windows = [
    ['day', 'dailyCap', 'daily'],
    ['week', 'weeklyCap', 'weekly'],
    ['month', 'monthlyCap', 'monthly'],
  ];
  for (const [key, capField, label] of windows) {
    const cap = eff[capField];
    const used = usage[key] || 0;
    if (cap != null && used + amountUsd > cap) {
      return {
        decision: 'deny',
        reasons: [`would exceed ${label} cap of $${cap} (already spent $${used}, this tx $${amountUsd})`],
      };
    }
  }

  return { decision: 'allow', reasons: ['within policy'] };
}

module.exports = { decide };
