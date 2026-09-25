'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const audit = require('../lib/audit');

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'audit.log');
}

const rec = (over = {}) => ({
  agentId: 'a1', to: '0xabc', amountUsd: 5, decision: 'allow', reasons: ['within policy'], ...over,
});

test('append writes records and verify passes', () => {
  const log = tmpLog();
  audit.append(rec(), log);
  audit.append(rec({ amountUsd: 7 }), log);
  const v = audit.verify(log);
  assert.equal(v.ok, true);
  assert.equal(v.count, 2);
  const records = audit.readRecords(log);
  assert.equal(records[1].prev, records[0].hash);
});

test('tampering with a record breaks the chain at the right index', () => {
  const log = tmpLog();
  audit.append(rec(), log);
  audit.append(rec(), log);
  audit.append(rec(), log);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.amountUsd = 9999; // edit history
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const v = audit.verify(log);
  assert.equal(v.ok, false);
  assert.equal(v.badIndex, 1);
});

test('deleting the tail is detectable via count mismatch expectation', () => {
  const log = tmpLog();
  audit.append(rec(), log);
  audit.append(rec(), log);
  const before = audit.verify(log).count;
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  fs.writeFileSync(log, lines.slice(0, 1).join('\n') + '\n');
  assert.equal(audit.verify(log).count, before - 1);
});

test('usageFor sums only allowed payments for the right agent in rolling windows', () => {
  const log = tmpLog();
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  // hand-craft records with controlled timestamps (valid chain)
  let prev = audit.GENESIS;
  const entries = [
    { ts: new Date(now - 1 * 3600 * 1000).toISOString(), agentId: 'a1', to: '0x1', amountUsd: 10, decision: 'allow' },
    { ts: new Date(now - 3 * DAY).toISOString(), agentId: 'a1', to: '0x1', amountUsd: 20, decision: 'allow' },
    { ts: new Date(now - 10 * DAY).toISOString(), agentId: 'a1', to: '0x1', amountUsd: 40, decision: 'allow' },
    { ts: new Date(now - 1 * 3600 * 1000).toISOString(), agentId: 'a1', to: '0x1', amountUsd: 99, decision: 'deny' },
    { ts: new Date(now - 1 * 3600 * 1000).toISOString(), agentId: 'a2', to: '0x1', amountUsd: 50, decision: 'allow' },
  ];
  const lines = entries.map((e) => {
    const body = { ...e, asset: null, reasons: [], prev };
    const hash = crypto.createHash('sha256').update(prev + JSON.stringify(body), 'utf8').digest('hex');
    prev = hash;
    return JSON.stringify({ ...body, hash });
  });
  fs.writeFileSync(log, lines.join('\n') + '\n');

  assert.equal(audit.verify(log).ok, true);
  const u = audit.usageFor('a1', log, now);
  assert.equal(u.day, 10);    // only the 1h-old allow
  assert.equal(u.week, 30);   // 10 + 20 (deny excluded)
  assert.equal(u.month, 70);  // 10 + 20 + 40 (a2 excluded)
});
