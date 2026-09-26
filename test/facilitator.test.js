'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { facilitatorGuard } = require('../lib/facilitator');
const audit = require('../lib/audit');
const queue = require('../lib/queue');

const POLICY = {
  version: 1,
  defaults: {
    dailyCap: 5000, weeklyCap: 5000, monthlyCap: 5000, perTxCap: 5000,
    allowlist: [], denylist: ['0xbad'], approvalThreshold: 10,
    velocityMax: null, missionCap: null,
  },
  agents: {},
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-f-'));
}

// Minimal Express-style mocks.
function mocks(payment) {
  const req = { body: payment === undefined ? {} : { payment } };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  let nextCalls = 0;
  const next = () => { nextCalls++; };
  return { req, res, next, nextCalls: () => nextCalls };
}

test('allowed payment calls next() and logs allow', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const guard = facilitatorGuard(POLICY, { logPath: lp });
  const m = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 5 });
  guard(m.req, m.res, m.next);
  assert.equal(m.nextCalls(), 1);
  assert.equal(m.res.statusCode, null);
  const records = audit.readRecords(lp);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'allow');
});

test('denied payment responds 403 and never calls next()', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const guard = facilitatorGuard(POLICY, { logPath: lp });
  const m = mocks({ agentId: 'a1', to: '0xbad', amountUsd: 5 });
  guard(m.req, m.res, m.next);
  assert.equal(m.nextCalls(), 0);
  assert.equal(m.res.statusCode, 403);
  assert.equal(m.res.body.decision, 'deny');
  assert.ok(m.res.body.reasons.join(' ').match(/denylist/));
  const records = audit.readRecords(lp);
  assert.equal(records[0].decision, 'deny');
});

test('needs_approval without queue responds 402 and never calls next()', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const guard = facilitatorGuard(POLICY, { logPath: lp });
  const m = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 50 });
  guard(m.req, m.res, m.next);
  assert.equal(m.nextCalls(), 0);
  assert.equal(m.res.statusCode, 402);
  assert.equal(m.res.body.decision, 'needs_approval');
  assert.equal(m.res.body.queueId, undefined);
});

test('needs_approval with queue:true enqueues and returns queueId', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const qp = path.join(dir, 'q.json');
  const guard = facilitatorGuard(POLICY, { logPath: lp, queuePath: qp, queue: true });
  const m = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 50, missionId: 'm9' });
  guard(m.req, m.res, m.next);
  assert.equal(m.nextCalls(), 0);
  assert.equal(m.res.statusCode, 402);
  assert.match(m.res.body.queueId, /^[0-9a-f]{16}$/);
  const pending = queue.list(qp);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].missionId, 'm9');
});

test('missing payment body is denied fail-closed', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const guard = facilitatorGuard(POLICY, { logPath: lp });
  for (const bad of [undefined, null, {}, { agentId: 'a1' }]) {
    const m = mocks(bad);
    guard(m.req, m.res, m.next);
    assert.equal(m.nextCalls(), 0, `next() must not be called for ${JSON.stringify(bad)}`);
    assert.equal(m.res.statusCode, 403);
    assert.equal(m.res.body.decision, 'deny');
  }
});

test('velocity freeze applies through the facilitator', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const pol = { version: 1, defaults: { ...POLICY.defaults, velocityMax: 2, velocityWindowSec: 60 }, agents: {} };
  const guard = facilitatorGuard(pol, { logPath: lp });
  for (let i = 0; i < 2; i++) {
    const m = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 1 });
    guard(m.req, m.res, m.next);
    assert.equal(m.nextCalls(), 1);
  }
  const m = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 1 });
  guard(m.req, m.res, m.next);
  assert.equal(m.nextCalls(), 0);
  assert.equal(m.res.statusCode, 403);
  assert.match(m.res.body.reasons.join(' '), /velocity freeze/);
});

test('missionId flows through the facilitator into decide and the trail', () => {
  const dir = tmpDir();
  const lp = path.join(dir, 'audit.log');
  const pol = { version: 1, defaults: { ...POLICY.defaults, missionCap: 10 }, agents: {} };
  const guard = facilitatorGuard(pol, { logPath: lp });
  const m1 = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 6, missionId: 'mx' });
  guard(m1.req, m1.res, m1.next);
  assert.equal(m1.nextCalls(), 1);
  const m2 = mocks({ agentId: 'a1', to: '0xabc', amountUsd: 6, missionId: 'mx' });
  guard(m2.req, m2.res, m2.next);
  assert.equal(m2.nextCalls(), 0);
  assert.match(m2.res.body.reasons.join(' '), /mission budget exhausted/);
  const records = audit.readRecords(lp);
  assert.equal(records[0].missionId, 'mx');
});
