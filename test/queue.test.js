'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queue = require('../lib/queue');
const audit = require('../lib/audit');
const { guardedPay, guardedPayQueued, PaymentBlockedError } = require('../lib/middleware');

const POLICY = {
  version: 1,
  defaults: {
    dailyCap: 5000, weeklyCap: 5000, monthlyCap: 5000, perTxCap: 5000,
    allowlist: [], denylist: [], approvalThreshold: 10,
    velocityMax: null, missionCap: null,
  },
  agents: {},
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-q-'));
}

test('enqueue + list round-trips a pending intent', () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  assert.deepEqual(queue.list(qp), []);
  const e = queue.enqueue({ agentId: 'a1', to: '0xabc', amountUsd: 50, missionId: 'm1', reasons: ['over threshold'] }, qp);
  assert.equal(e.status, 'pending');
  assert.match(e.id, /^[0-9a-f]{16}$/);
  const listed = queue.list(qp);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].missionId, 'm1');
});

test('approve executes paymentFn and hash-chains an allow record', async () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  const lp = path.join(dir, 'audit.log');
  const e = queue.enqueue({ agentId: 'a1', to: '0xabc', amountUsd: 50, reasons: ['r'] }, qp);
  let calledWith = null;
  const { entry, result } = await queue.approve(qp, lp, e.id, async (p) => {
    calledWith = p;
    return { tx: '0xdead' };
  });
  assert.equal(entry.id, e.id);
  assert.deepEqual(calledWith, { agentId: 'a1', to: '0xabc', amountUsd: 50, missionId: null });
  assert.deepEqual(result, { tx: '0xdead' });
  assert.deepEqual(queue.list(qp), []);
  const records = audit.readRecords(lp);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'allow');
  assert.match(records[0].reasons.join(' '), /approved from queue/);
  assert.ok(audit.verify(lp).ok);
});

test('approve requires paymentFn and a pending entry', async () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  const lp = path.join(dir, 'audit.log');
  await assert.rejects(queue.approve(qp, lp, 'nope', async () => ({})), /no pending queue entry/);
  const e = queue.enqueue({ agentId: 'a1', to: '0xabc', amountUsd: 1 }, qp);
  await assert.rejects(queue.approve(qp, lp, e.id, null), TypeError);
});

test('deny discards the intent and hash-chains a deny record', () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  const lp = path.join(dir, 'audit.log');
  const e = queue.enqueue({ agentId: 'a1', to: '0xabc', amountUsd: 50 }, qp);
  const entry = queue.deny(qp, lp, e.id);
  assert.equal(entry.id, e.id);
  assert.deepEqual(queue.list(qp), []);
  const records = audit.readRecords(lp);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'deny');
  assert.match(records[0].reasons.join(' '), /denied from queue/);
  assert.ok(audit.verify(lp).ok);
});

test('deny on missing id throws and writes nothing', () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  const lp = path.join(dir, 'audit.log');
  assert.throws(() => queue.deny(qp, lp, 'nope'), /no pending queue entry/);
  assert.deepEqual(audit.readRecords(lp), []);
});

test('recordApproval records the human decision without executing', () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  const lp = path.join(dir, 'audit.log');
  const e = queue.enqueue({ agentId: 'a1', to: '0xabc', amountUsd: 50 }, qp);
  const entry = queue.recordApproval(qp, lp, e.id);
  assert.equal(entry.id, e.id);
  assert.deepEqual(queue.list(qp), []);
  const records = audit.readRecords(lp);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'approved');
  // 'approved' is not 'allow': it must not consume caps.
  assert.equal(audit.usageFor('a1', lp).day, 0);
  assert.ok(audit.verify(lp).ok);
});

test('guardedPay with queue:true returns a receipt instead of throwing', async () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const qp = path.join(dir, 'q.json');
  let calls = 0;
  const pay = guardedPay(POLICY, async () => { calls++; return { ok: true }; }, { logPath: lp, queuePath: qp, queue: true });
  const receipt = await pay('a1', '0xabc', 50);
  assert.equal(receipt.pending, true);
  assert.match(receipt.id, /^[0-9a-f]{16}$/);
  assert.equal(calls, 0, 'paymentFn must not run before approval');
  assert.equal(queue.list(qp).length, 1);
  // The needs_approval attempt is still in the audit trail.
  const records = audit.readRecords(lp);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'needs_approval');
});

test('guardedPayQueued is the queue-enabled convenience wrapper', async () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const qp = path.join(dir, 'q.json');
  const pay = guardedPayQueued(POLICY, async () => ({ ok: true }), { logPath: lp, queuePath: qp });
  const receipt = await pay('a1', '0xabc', 50);
  assert.equal(receipt.pending, true);
  // Full cycle: approve executes the original paymentFn.
  let executed = 0;
  const { result } = await queue.approve(qp, lp, receipt.id, async () => { executed++; return { ok: true }; });
  assert.equal(executed, 1);
  assert.equal(result.ok, true);
});

test('deny still throws with queue enabled — fail closed', async () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const qp = path.join(dir, 'q.json');
  const pol = { version: 1, defaults: { ...POLICY.defaults, denylist: ['0xbad'] }, agents: {} };
  const pay = guardedPayQueued(pol, async () => ({ ok: true }), { logPath: lp, queuePath: qp });
  await assert.rejects(pay('a1', '0xbad', 5), PaymentBlockedError);
  assert.deepEqual(queue.list(qp), [], 'denied payments must not enter the queue');
});

test('queue ids are unique across entries', () => {
  const dir = tmpDir();
  const qp = path.join(dir, 'q.json');
  const ids = new Set();
  for (let i = 0; i < 25; i++) {
    ids.add(queue.enqueue({ agentId: 'a1', to: '0xabc', amountUsd: 1 }, qp).id);
  }
  assert.equal(ids.size, 25);
});
