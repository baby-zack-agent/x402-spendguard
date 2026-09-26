'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decide } = require('../lib/decide');
const audit = require('../lib/audit');
const { guardedPay } = require('../lib/middleware');

const BASE = {
  dailyCap: 5000, weeklyCap: 5000, monthlyCap: 5000, perTxCap: 5000,
  allowlist: [], denylist: [], approvalThreshold: 5000,
  velocityMax: null, missionCap: 100,
};
const inp = (over = {}) => ({ agentId: 'a1', to: '0xabc', amountUsd: 5, ...over });
function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'audit.log');
}
const POLICY = { version: 1, defaults: { ...BASE }, agents: {} };

test('allows within the mission budget', () => {
  const r = decide(inp({ missionId: 'm1' }), BASE, { mission: 60 });
  assert.equal(r.decision, 'allow');
});

test('denies when the mission budget would be exhausted', () => {
  const r = decide(inp({ amountUsd: 50, missionId: 'm1' }), BASE, { mission: 60 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /mission budget exhausted/);
  assert.match(r.reasons.join(' '), /m1/);
});

test('mission cap ignored when no missionId is given', () => {
  const r = decide(inp(), BASE, { mission: 10000 });
  assert.equal(r.decision, 'allow');
});

test('mission cap disabled when null', () => {
  const r = decide(inp({ missionId: 'm1' }), { ...BASE, missionCap: null }, { mission: 10000 });
  assert.equal(r.decision, 'allow');
});

test('mission budgets are per (agent, mission) pair', () => {
  const log = tmpLog();
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 40, missionId: 'm1', decision: 'allow' }, log);
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 40, missionId: 'm2', decision: 'allow' }, log);
  audit.append({ agentId: 'a2', to: '0x1', amountUsd: 40, missionId: 'm1', decision: 'allow' }, log);
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 40, missionId: 'm1', decision: 'deny', reasons: ['x'] }, log);
  assert.equal(audit.missionUsageFor('a1', 'm1', log), 40);
  assert.equal(audit.missionUsageFor('a1', 'm2', log), 40);
  assert.equal(audit.missionUsageFor('a2', 'm1', log), 40);
  assert.equal(audit.missionUsageFor('a1', undefined, log), 0);
});

test('guardedPay enforces mission caps end to end', async () => {
  const log = tmpLog();
  const pay = guardedPay(POLICY, async () => ({ ok: true }), { logPath: log });
  await pay('a1', '0xabc', 40, { missionId: 'm1' });
  await pay('a1', '0xabc', 40, { missionId: 'm1' });
  await assert.rejects(
    pay('a1', '0xabc', 40, { missionId: 'm1' }),
    (e) => { assert.match(e.reasons.join(' '), /mission budget exhausted/); return true; }
  );
  // Same agent, different mission: unaffected.
  await pay('a1', '0xabc', 40, { missionId: 'm2' });
  // No mission: unaffected by mission caps.
  await pay('a1', '0xabc', 40);
});

test('missionId reaches paymentFn and the audit trail', async () => {
  const log = tmpLog();
  let seen = null;
  const pay = guardedPay(POLICY, async (p) => { seen = p; return { ok: true }; }, { logPath: log });
  await pay('a1', '0xabc', 5, { missionId: 'nightly' });
  assert.equal(seen.missionId, 'nightly');
  const records = audit.readRecords(log);
  assert.equal(records[0].missionId, 'nightly');
  assert.ok(audit.verify(log).ok);
});

test('extra rest args still forward after the mission opts object', async () => {
  const log = tmpLog();
  let seenRest = null;
  const pay = guardedPay(POLICY, async (p, ...rest) => { seenRest = rest; return { ok: true }; }, { logPath: log });
  await pay('a1', '0xabc', 5, { missionId: 'm1' }, 'extra1', 'extra2');
  assert.deepEqual(seenRest, ['extra1', 'extra2']);
});

test('plain-object rest arg without missionId is not swallowed', async () => {
  const log = tmpLog();
  let seenRest = null;
  const pay = guardedPay(POLICY, async (p, ...rest) => { seenRest = rest; return { ok: true }; }, { logPath: log });
  await pay('a1', '0xabc', 5, { memo: 'hello' });
  assert.deepEqual(seenRest, [{ memo: 'hello' }]);
});

test('per-agent missionCap override is honored', () => {
  const eff = { ...BASE, missionCap: 100 };
  const vip = { ...eff, missionCap: 1000 };
  assert.equal(decide(inp({ missionId: 'm', amountUsd: 500 }), vip, { mission: 0 }).decision, 'allow');
  assert.equal(decide(inp({ missionId: 'm', amountUsd: 500 }), eff, { mission: 0 }).decision, 'deny');
});
