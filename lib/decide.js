'use strict';
// Pure policy decision function. No I/O, no side effects, no clocks.
// input:  { agentId, to, amountUsd, asset?, missionId? }
// eff:    merged policy from policy.effectivePolicy(agentId)
// usage:  { day, week, month, velocity, mission }
//         - day/week/month: USD already spent by this agent in each rolling
//           window (from audit.usageFor). Only 'allow' decisions count.
//         - velocity: payment count by this agent inside velocityWindowSec
//           (from audit.velocityFor). ALL decisions count, including blocked
//           ones — that is what keeps a frozen agent frozen while it retries.
//         - mission: USD already spent by this (agentId, missionId) pair
//           (from audit.missionUsageFor). Only 'allow' decisions count.
function norm(addr) {
  return String(addr || '').toLowerCase();
}

function decide(input, eff, usage) {
  const { agentId, to, amountUsd, missionId } = input || {};
  usage = usage || {};
  const u = {
    day: usage.day || 0,
    week: usage.week || 0,
    month: usage.month || 0,
    velocity: usage.velocity || 0,
    mission: usage.mission || 0,
  };
  const mission = typeof missionId === 'string' && missionId.length > 0 ? missionId : null;

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
  // Velocity freeze: the circuit breaker. A frozen agent stays frozen while it
  // keeps attempting — every blocked attempt lands in the audit trail and
  // keeps the window full — and thaws after velocityWindowSec of quiet.
  if (eff.velocityMax != null && u.velocity >= eff.velocityMax) {
    return {
      decision: 'deny',
      reasons: [`velocity freeze: ${u.velocity} payments in the last ${eff.velocityWindowSec}s hit the limit of ${eff.velocityMax} — agent frozen until the window passes`],
    };
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
    const used = u[key];
    if (cap != null && used + amountUsd > cap) {
      return {
        decision: 'deny',
        reasons: [`would exceed ${label} cap of $${cap} (already spent $${used}, this tx $${amountUsd})`],
      };
    }
  }

  // Per-mission budget: lifetime spend for this (agentId, missionId) pair.
  if (mission !== null && eff.missionCap != null && u.mission + amountUsd > eff.missionCap) {
    return {
      decision: 'deny',
      reasons: [`mission budget exhausted: mission ${mission} cap of $${eff.missionCap} (already spent $${u.mission}, this tx $${amountUsd})`],
    };
  }

  return { decision: 'allow', reasons: ['within policy'] };
}

module.exports = { decide };
