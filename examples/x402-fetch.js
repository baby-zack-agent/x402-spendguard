'use strict';
// Example: wrapping a fetch-based x402 payment flow with spendguard.
// This is fully offline — the "server" and "payment" are stubs so you can see
// the guard in action. In production, swap payOnChain for your real x402
// payment call (e.g. x402 client / facilitator settle).
const path = require('node:path');
const { loadPolicy } = require('../lib/policy');
const { guardedPay, PaymentBlockedError } = require('../lib/middleware');

const policy = loadPolicy(path.join(__dirname, '..', 'policy.example.json'));
const LOG = path.join(__dirname, '..', 'example-audit.log');

// --- stub: the paywalled API. First call returns 402, retry-with-proof succeeds.
function paywalledApi(paymentProof) {
  if (!paymentProof) {
    return { status: 402, payTo: '0xf27a01b3e5a4fe823ea771a4815d0974bf216717', amountUsd: 2.5, asset: 'USDC' };
  }
  return { status: 200, data: 'premium weather data: 72F and sunny' };
}

// --- stub: your real x402 payment step goes here (sign + broadcast / facilitator).
async function payOnChain({ agentId, to, amountUsd }) {
  // ... x402 client settle logic ...
  return { txHash: '0xstub', agentId, to, amountUsd, settled: true };
}

async function fetchPremiumData(agentId) {
  const first = paywalledApi(null);
  if (first.status !== 402) return first.data;

  // The guard sits between the agent and the payment step.
  const pay = guardedPay(policy, payOnChain, { logPath: LOG });
  const receipt = await pay(agentId, first.payTo, first.amountUsd);
  const second = paywalledApi(receipt.txHash);
  return second.data;
}

async function main() {
  const agentId = process.argv[2] || 'researcher-02';

  // 1. Small payment — allowed.
  try {
    console.log('small payment:', await fetchPremiumData(agentId));
  } catch (e) {
    console.log('small payment blocked:', e.message);
  }

  // 2. Oversized payment — blocked by per-tx cap, payment fn never runs.
  const pay = guardedPay(policy, payOnChain, { logPath: LOG });
  try {
    await pay(agentId, '0xf27a01b3e5a4fe823ea771a4815d0974bf216717', 500);
    console.log('large payment: unexpectedly allowed');
  } catch (e) {
    if (e instanceof PaymentBlockedError) {
      console.log(`large payment blocked as designed: ${e.decision} — ${e.reasons.join('; ')}`);
    } else throw e;
  }

  console.log(`\naudit trail written to ${LOG} — inspect with: npx spendguard audit --log ${LOG}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
