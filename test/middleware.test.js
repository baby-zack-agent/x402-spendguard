'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guardedPay, PaymentBlockedError } = require('../lib/middleware');
const audit = require('../lib/audit');

const POLICY = {
  version: 1,
  defaults: {
    dailyCap: 50, weeklyCap: 200, monthlyCap: 500, perTxCap: 25,
    allowlist: [], denylist: [], approvalThreshold: 100,
  },
  agents: {},
};

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'audit.log');
}

test('allowed payment invokes paymentFn and logs allow', async () => {
  const log = tmpLog();
  let calls = 0;
  const pay = guardedPay(POLICY, async ({ agentId, to, amountUsd }) => {
    calls++;
    return { ok: true, agentId, to, amountUsd };
  }, { logPath: log });

  const res = await pay('a1', '0xabc', 5);
  assert.equal(calls, 1);
  assert.equal(res.ok, true);
  const records = audit.readRecords(log);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'allow');
});

test('denied payment never invokes paymentFn but is still logged', async () => {
  const log = tmpLog();
  let calls = 0;
  const pay = guardedPay(POLICY, async () => { calls++; }, { logPath: log });

  await assert.rejects(pay('a1', '0xabc', 500), (e) => {
    assert.ok(e instanceof PaymentBlockedError);
    assert.equal(e.decision, 'deny');
    return true;
  });
  assert.equal(calls, 0);
  const records = audit.readRecords(log);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'deny');
});

test('needs_approval blocks payment and logs the attempt', async () => {
  const log = tmpLog();
  let calls = 0;
  const big = {
    ...POLICY,
    defaults: { ...POLICY.defaults, perTxCap: 1000, approvalThreshold: 100 },
  };
  const pay = guardedPay(big, async () => { calls++; }, { logPath: log });

  await assert.rejects(pay('a1', '0xabc', 150), (e) => {
    assert.ok(e instanceof PaymentBlockedError);
    assert.equal(e.decision, 'needs_approval');
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(audit.readRecords(log)[0].decision, 'needs_approval');
});

test('rolling daily cap accumulates across guarded calls', async () => {
  const log = tmpLog();
  let calls = 0;
  const pay = guardedPay(POLICY, async () => { calls++; return { ok: true }; }, { logPath: log });

  await pay('a1', '0xabc', 20);
  await pay('a1', '0xabc', 20);
  await assert.rejects(pay('a1', '0xabc', 20), (e) => e instanceof PaymentBlockedError);
  assert.equal(calls, 2); // third call consumed no money
  const decisions = audit.readRecords(log).map((r) => r.decision);
  assert.deepEqual(decisions, ['allow', 'allow', 'deny']);
});
