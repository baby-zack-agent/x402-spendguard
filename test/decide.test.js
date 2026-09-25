'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../lib/decide');

const BASE = {
  dailyCap: 50, weeklyCap: 200, monthlyCap: 500, perTxCap: 25,
  allowlist: [], denylist: [], approvalThreshold: 100,
};
const ZERO = { day: 0, week: 0, month: 0 };
const inp = (over = {}) => ({ agentId: 'a1', to: '0xabc', amountUsd: 5, ...over });

test('allows a payment within all caps', () => {
  const r = decide(inp(), BASE, ZERO);
  assert.equal(r.decision, 'allow');
});

test('denies when the daily cap would be exceeded', () => {
  const r = decide(inp({ amountUsd: 10 }), BASE, { day: 45, week: 0, month: 0 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /daily cap/);
});

test('denies when the weekly cap would be exceeded', () => {
  const r = decide(inp({ amountUsd: 10 }), BASE, { day: 0, week: 195, month: 0 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /weekly cap/);
});

test('denies when the monthly cap would be exceeded', () => {
  const r = decide(inp({ amountUsd: 10 }), BASE, { day: 0, week: 0, month: 495 });
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /monthly cap/);
});

test('denies when the per-transaction cap is exceeded', () => {
  const r = decide(inp({ amountUsd: 26 }), BASE, ZERO);
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /per-transaction cap/);
});

test('allowlist: passes for listed recipient, denies for others', () => {
  const eff = { ...BASE, allowlist: ['0xABC'] };
  assert.equal(decide(inp({ to: '0xabc' }), eff, ZERO).decision, 'allow');
  const r = decide(inp({ to: '0xdef' }), eff, ZERO);
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /allowlist/);
});

test('denylist always wins, even against the allowlist', () => {
  const eff = { ...BASE, allowlist: ['0xabc'], denylist: ['0xabc'] };
  const r = decide(inp({ to: '0xabc' }), eff, ZERO);
  assert.equal(r.decision, 'deny');
  assert.match(r.reasons.join(' '), /denylist/);
});

test('triggers needs_approval above the approval threshold', () => {
  const eff = { ...BASE, perTxCap: 500, approvalThreshold: 100 };
  const r = decide(inp({ amountUsd: 150 }), eff, ZERO);
  assert.equal(r.decision, 'needs_approval');
  assert.match(r.reasons.join(' '), /approval/);
});

test('amount exactly at the threshold does not need approval', () => {
  const eff = { ...BASE, dailyCap: 5000, weeklyCap: 5000, monthlyCap: 5000, perTxCap: 500, approvalThreshold: 100 };
  const r = decide(inp({ amountUsd: 100 }), eff, ZERO);
  assert.equal(r.decision, 'allow');
});

test('denies invalid amounts', () => {
  for (const amountUsd of [0, -5, NaN, Infinity, '5', undefined]) {
    const r = decide(inp({ amountUsd }), BASE, ZERO);
    assert.equal(r.decision, 'deny', `expected deny for ${String(amountUsd)}`);
  }
});

test('denies missing agentId or recipient', () => {
  assert.equal(decide({ to: '0xabc', amountUsd: 5 }, BASE, ZERO).decision, 'deny');
  assert.equal(decide({ agentId: 'a1', amountUsd: 5 }, BASE, ZERO).decision, 'deny');
});
