'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const attest = require('../lib/attest');

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'audit.log');
}

const fields = (over = {}) => ({
  agentId: 'baby-zack-agent',
  action: 'x402.payment',
  to: '0xabc',
  amountUsd: 25,
  asset: 'USDC',
  network: 'base-sepolia',
  txHash: '0xdeadbeef',
  policyDecision: 'allow',
  ...over,
});

test('keygen returns PEM-encoded ed25519 keypair', () => {
  const { publicKey, privateKey } = attest.keygen();
  assert.match(publicKey, /BEGIN PUBLIC KEY/);
  assert.match(privateKey, /BEGIN PRIVATE KEY/);
});

test('issue -> verify round-trips', () => {
  const { publicKey, privateKey } = attest.keygen();
  const r = attest.issue(fields(), privateKey);
  assert.equal(r.v, 1);
  assert.match(r.receiptId, /^rcpt_[0-9a-f]{16}$/);
  assert.ok(r.sig.length > 40);
  const v = attest.verify(r, publicKey);
  assert.equal(v.ok, true);
});

test('tampering with any signed field fails verification', () => {
  const { publicKey, privateKey } = attest.keygen();
  const r = attest.issue(fields(), privateKey);
  const bad = { ...r, amountUsd: 9999 };
  const v = attest.verify(bad, publicKey);
  assert.equal(v.ok, false);
  assert.match(v.reason, /tampered|mismatch/);
});

test('wrong public key fails verification', () => {
  const { privateKey } = attest.keygen();
  const { publicKey: other } = attest.keygen();
  const r = attest.issue(fields(), privateKey);
  const v = attest.verify(r, other);
  assert.equal(v.ok, false);
});

test('malformed receipts are rejected, not thrown on', () => {
  const { publicKey } = attest.keygen();
  assert.equal(attest.verify(null, publicKey).ok, false);
  assert.equal(attest.verify({ v: 1 }, publicKey).ok, false);
  assert.equal(attest.verify({ ...attest.issue(fields(), attest.keygen().privateKey), v: 2 }, publicKey).ok, false);
});

test('issue with logPath links receipt to the audit chain', () => {
  const { publicKey, privateKey } = attest.keygen();
  const log = tmpLog();
  const r = attest.issue(fields(), privateKey, log);
  assert.ok(r.auditHash);
  const v = attest.verifyAgainstLog(r, publicKey, log);
  assert.equal(v.ok, true);
});

test('verifyAgainstLog fails when the audit log is tampered', () => {
  const { publicKey, privateKey } = attest.keygen();
  const log = tmpLog();
  const r = attest.issue(fields(), privateKey, log);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.amountUsd = 1;
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const v = attest.verifyAgainstLog(r, publicKey, log);
  assert.equal(v.ok, false);
});

test('verifyAgainstLog fails when auditHash is absent from the log', () => {
  const { publicKey, privateKey } = attest.keygen();
  const r = attest.issue(fields(), privateKey, tmpLog()); // different log
  const v = attest.verifyAgainstLog(r, publicKey, tmpLog());
  assert.equal(v.ok, false);
  assert.match(v.reason, /not found/);
});

test('issue requires agentId, action, and to', () => {
  const { privateKey } = attest.keygen();
  assert.throws(() => attest.issue(fields({ agentId: '' }), privateKey), /agentId/);
  assert.throws(() => attest.issue(fields({ action: '' }), privateKey), /action/);
});
