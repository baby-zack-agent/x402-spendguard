'use strict';
// Framework-agnostic x402 payment guard.
// Wraps any payment function so decide() runs BEFORE money moves.
// Deny: payment is blocked (never invoked) and the attempt is still written
// to the audit trail. needs_approval: blocked by default, or — with
// { queue: true } — held in the persistent approval queue and a pending
// receipt returned instead of throwing. Fail-closed by design.
const { effectivePolicy } = require('./policy');
const { decide } = require('./decide');
const audit = require('./audit');
const queue = require('./queue');

class PaymentBlockedError extends Error {
  constructor(decision, reasons) {
    super(`payment blocked: ${decision} — ${reasons.join('; ')}`);
    this.name = 'PaymentBlockedError';
    this.decision = decision;
    this.reasons = reasons;
  }
}

// Per-call options travel as an object with a missionId key, e.g.
//   pay('agent-1', '0xabc', 5, { missionId: 'nightly-scrape' })
// It is consumed by the guard (never forwarded in ...rest) and passed to
// paymentFn inside the first argument object.
function splitCallOpts(rest) {
  if (
    rest.length > 0 &&
    rest[0] !== null &&
    typeof rest[0] === 'object' &&
    !Array.isArray(rest[0]) &&
    Object.prototype.hasOwnProperty.call(rest[0], 'missionId')
  ) {
    return [{ missionId: rest[0].missionId }, rest.slice(1)];
  }
  return [{}, rest];
}

// policy: loaded policy object (policy.loadPolicy)
// paymentFn: async ({ agentId, to, amountUsd, missionId }, ...rest) => result
// opts: { logPath, queue, queuePath }
//   queue: hold needs_approval intents instead of throwing; returns a pending
//   receipt { pending: true, id, ... }. Resolve with queue.approve/deny.
// Returns an async function with the same call shape as your x402 pay step.
function guardedPay(policy, paymentFn, opts = {}) {
  if (typeof paymentFn !== 'function') {
    throw new TypeError('paymentFn must be a function');
  }
  const logPath = opts.logPath || './audit.log';
  const useQueue = !!opts.queue;
  const queuePath = opts.queuePath || queue.defaultQueuePath(logPath);

  return async function guarded(agentId, to, amountUsd, ...rest) {
    const [callOpts, fwdRest] = splitCallOpts(rest);
    const missionId = callOpts.missionId;

    const eff = effectivePolicy(policy, agentId);
    const usage = {
      ...audit.usageFor(agentId, logPath),
      velocity: audit.velocityFor(agentId, logPath, eff.velocityWindowSec),
      mission: audit.missionUsageFor(agentId, missionId, logPath),
    };
    const input = { agentId, to, amountUsd, missionId };
    const { decision, reasons } = decide(input, eff, usage);

    // Always log the attempt — including blocked ones.
    audit.append({ ...input, decision, reasons }, logPath);

    if (decision === 'allow') {
      return paymentFn({ agentId, to, amountUsd, missionId }, ...fwdRest);
    }
    if (decision === 'needs_approval' && useQueue) {
      const entry = queue.enqueue({ ...input, reasons }, queuePath);
      return { pending: true, id: entry.id, agentId, to, amountUsd, missionId, reasons };
    }
    throw new PaymentBlockedError(decision, reasons);
  };
}

// Convenience wrapper: guardedPay with the approval queue enabled.
// needs_approval returns a pending receipt { pending: true, id, ... } instead
// of throwing. Resolve entries with queue.approve(id, paymentFn) /
// queue.deny(id), or via the CLI: spendguard queue | approve | deny.
function guardedPayQueued(policy, paymentFn, opts = {}) {
  return guardedPay(policy, paymentFn, { ...opts, queue: true });
}

module.exports = { guardedPay, guardedPayQueued, PaymentBlockedError };
