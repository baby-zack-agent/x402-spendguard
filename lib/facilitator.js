'use strict';
// Drop-in guard for x402 facilitator servers. Express-style (req, res, next):
// reads { agentId, to, amountUsd, missionId? } from req.body.payment, runs
// decide() BEFORE the facilitator touches the payment, and only calls next()
// when the payment is allowed. Anything else gets a 402/403 with the reasons
// as JSON — and next() is never called. Fail-closed: a missing or malformed
// payment body is denied, never waved through.
const { effectivePolicy } = require('./policy');
const { decide } = require('./decide');
const audit = require('./audit');
const queue = require('./queue');

// policy: loaded policy object (policy.loadPolicy)
// opts: { logPath, queuePath, queue }
//   queue: when true, needs_approval intents are held in the approval queue
//   and the 402 response carries the queueId for `spendguard approve <id>`.
function facilitatorGuard(policy, opts = {}) {
  const logPath = opts.logPath || './audit.log';
  const queuePath = opts.queuePath || queue.defaultQueuePath(logPath);
  const useQueue = !!opts.queue;

  return function guard(req, res, next) {
    const payment = req && req.body && req.body.payment;
    const input = {
      agentId: payment && payment.agentId,
      to: payment && payment.to,
      amountUsd: payment && payment.amountUsd,
      missionId: payment && payment.missionId,
    };

    const eff = effectivePolicy(policy, input.agentId);
    const usage = {
      ...audit.usageFor(input.agentId, logPath),
      velocity: audit.velocityFor(input.agentId, logPath, eff.velocityWindowSec),
      mission: audit.missionUsageFor(input.agentId, input.missionId, logPath),
    };
    const { decision, reasons } = decide(input, eff, usage);

    // Always log the attempt — including blocked ones.
    audit.append({ ...input, decision, reasons }, logPath);

    if (decision === 'allow') {
      return next();
    }
    if (decision === 'needs_approval') {
      if (useQueue) {
        const entry = queue.enqueue({ ...input, reasons }, queuePath);
        return res.status(402).json({
          decision,
          reasons,
          queueId: entry.id,
          message: 'payment held for human approval — run: spendguard approve ' + entry.id,
        });
      }
      return res.status(402).json({ decision, reasons });
    }
    return res.status(403).json({ decision: 'deny', reasons });
  };
}

module.exports = { facilitatorGuard };
