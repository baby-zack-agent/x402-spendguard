'use strict';
// Framework-agnostic x402 payment guard.
// Wraps any payment function so decide() runs BEFORE money moves.
// Deny/needs_approval: payment is blocked (never invoked) and the attempt is
// still written to the audit trail. Fail-closed by design.
const { effectivePolicy } = require('./policy');
const { decide } = require('./decide');
const audit = require('./audit');

class PaymentBlockedError extends Error {
  constructor(decision, reasons) {
    super(`payment blocked: ${decision} — ${reasons.join('; ')}`);
    this.name = 'PaymentBlockedError';
    this.decision = decision;
    this.reasons = reasons;
  }
}

// policy: loaded policy object (policy.loadPolicy)
// paymentFn: async ({ agentId, to, amountUsd }, ...rest) => result
// opts: { logPath }
// Returns an async function with the same call shape as your x402 pay step.
function guardedPay(policy, paymentFn, opts = {}) {
  if (typeof paymentFn !== 'function') {
    throw new TypeError('paymentFn must be a function');
  }
  const logPath = opts.logPath || './audit.log';

  return async function guarded(agentId, to, amountUsd, ...rest) {
    const eff = effectivePolicy(policy, agentId);
    const usage = audit.usageFor(agentId, logPath);
    const { decision, reasons } = decide({ agentId, to, amountUsd }, eff, usage);

    // Always log the attempt — including blocked ones.
    audit.append({ agentId, to, amountUsd, decision, reasons }, logPath);

    if (decision !== 'allow') {
      throw new PaymentBlockedError(decision, reasons);
    }
    return paymentFn({ agentId, to, amountUsd }, ...rest);
  };
}

module.exports = { guardedPay, PaymentBlockedError };
