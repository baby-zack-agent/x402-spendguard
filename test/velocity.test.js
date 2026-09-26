'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decide } = require('../lib/decide');
const audit = require('../lib/audit');
const { guardedPay, PaymentBlockedError } = require('../lib/middleware');

const BASE = {
  dailyCap: 5000, weeklyCap: 5000, monthlyCap: 5000, perTxCap: 5000,
  allowlist: [], denylist: [], approvalThreshold: 5000,
  velocityMax: 3, velocityWindowSec: 60, missionCap: null,
};
const inp = (over = {}) => ({ agentId: 'a1', to: '0xabc', amountUsd: 5, ...over });

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'audit.log');
}
const POLICY = { version: 1, defaults: { ...BASE }, agents: {} };

test('allows when under the velocity limit', () => {
  const r = decide(inp(), BASE, { velocity: 2 });
  assert.equal(r.decision, 'allow');
});

test('denies with velocity freeze at the limit', () => {
  const r = decide(inp(), BASE, { velocity: 3 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /velocity freeze/);
});

test('denylist still wins over velocity freeze', () => {
  const eff = { ...BASE, denylist: ['0xabc'] };
  const r = decide(inp(), eff, { velocity: 99 });
  assert.match(r.reasons.join(' '), /denylist/);
});

test('velocity disabled when velocityMax is null', () => {
  const r = decide(inp(), { ...BASE, velocityMax: null }, { velocity: 10000 });
  assert.equal(r.decision, 'allow');
});

test('velocityFor counts all decisions including blocked ones', () => {
  const log = tmpLog();
  const now = Date.now();
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 1, decision: 'allow' }, log);
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 1, decision: 'deny', reasons: ['x'] }, log);
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 1, decision: 'needs_approval', reasons: ['y'] }, log);
  audit.append({ agentId: 'other', to: '0x1', amountUsd: 1, decision: 'allow' }, log);
  assert.equal(audit.velocityFor('a1', log, 60, now), 3);
});

test('velocityFor ignores records outside the window', () => {
  const log = tmpLog();
  const now = Date.now();
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 1, decision: 'allow' }, log);
  assert.equal(audit.velocityFor('a1', log, 60, now + 61 * 1000), 0);
  assert.equal(audit.velocityFor('a1', log, 3600, now + 61 * 1000), 1);
});

test('guardedPay freezes an agent after velocityMax payments', async () => {
  const log = tmpLog();
  const pay = guardedPay(POLICY, async () => ({ ok: true }), { logPath: log });
  await pay('a1', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  await assert.rejects(pay('a1', '0xabc', 5), (e) => {
    assert.ok(e instanceof PaymentBlockedError);
    assert.match(e.reasons.join(' '), /velocity freeze/);
    return true;
  });
});

test('frozen agent stays frozen while retrying, thaws after quiet window', async () => {
  const log = tmpLog();
  const pay = guardedPay(POLICY, async () => ({ ok: true }), { logPath: log });
  await pay('a1', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  // Each retry appends another blocked record, keeping the window full.
  await assert.rejects(pay('a1', '0xabc', 5), PaymentBlockedError);
  await assert.rejects(pay('a1', '0xabc', 5), PaymentBlockedError);
  const records = audit.readRecords(log);
  assert.equal(records.length, 5);
  assert.ok(records.every((r) => r.agentId === 'a1'));
  // A different agent is unaffected.
  await pay('a2', '0xabc', 5);
});

test('per-agent velocity override is honored', async () => {
  const log = tmpLog();
  const pol = { version: 1, defaults: { ...BASE }, agents: { vip: { velocityMax: 100 } } };
  const pay = guardedPay(pol, async () => ({ ok: true }), { logPath: log });
  for (let i = 0; i < 10; i++) await pay('vip', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  await pay('a1', '0xabc', 5);
  await assert.rejects(pay('a1', '0xabc', 5), PaymentBlockedError);
});

test('CLI check surfaces velocity usage', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cli-'));
  const polPath = path.join(dir, 'policy.json');
  fs.writeFileSync(polPath, JSON.stringify(POLICY));
  const logPath = path.join(dir, 'audit.log');
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 1, decision: 'allow' }, logPath);
  audit.append({ agentId: 'a1', to: '0x1', amountUsd: 1, decision: 'allow' }, logPath);
  const out = execFileSync('node', ['bin/spendguard', 'check', '--agent', 'a1', '--to', '0xabc', '--amount', '5', '--policy', polPath, '--log', logPath], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'allow');
  assert.equal(parsed.usage.velocity, 2);
});
