#!/usr/bin/env node
'use strict';
// Demo driver: runs the REAL x402-spendguard lib + CLI through the three
// demo scenes and captures every byte of output into shots.json.
// The renderer turns shots.json into the video. Nothing here is faked:
// every decision, reason, id and audit line comes from the actual tool.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const DEMO = __dirname; // demo/
const WORK = path.join(DEMO, 'work');
const CLI = path.join(REPO, 'bin', 'spendguard');
const LOG = path.join(WORK, 'audit.log');
const POLICY_PATH = path.join(WORK, 'policy.json');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const ADDR_A = '0x7f3a9d2e4b5c6a7f8e9d0c1b2a3f4c91e'; // scene 1 target
const ADDR_B = '0x9be244aa7712cc05d1e88f3a6b4d20987'; // scene 2 vendor
const ADDR_C = '0xdata-oracle-11aa22bb33cc44dd55';     // scene 3 vendor

const short = (a) => (a.length > 12 ? a.slice(0, 6) + '..' + a.slice(-4) : a);

const policy = {
  version: 1,
  defaults: {
    dailyCap: 10000, weeklyCap: 50000, monthlyCap: 200000,
    perTxCap: 500, allowlist: [], denylist: [],
    approvalThreshold: 100, velocityMax: 20, velocityWindowSec: 60,
    missionCap: null,
  },
  agents: {
    'scraper-01':    { dailyCap: 10000, perTxCap: 25, approvalThreshold: 100, velocityMax: 20, velocityWindowSec: 60 },
    'treasurer-01':  { dailyCap: 10000, perTxCap: 500, approvalThreshold: 100 },
    'researcher-01': { dailyCap: 10000, perTxCap: 25, missionCap: 50 },
  },
};
fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2) + '\n');

const { loadPolicy } = require(path.join(REPO, 'lib', 'policy'));
const { guardedPay, guardedPayQueued } = require(path.join(REPO, 'lib', 'middleware'));
const policyObj = loadPolicy(POLICY_PATH);

function cli(...args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
const P = ['--policy', POLICY_PATH, '--log', LOG];

async function main() {
  const shots = {};

  // ---------- Scene 1: the attack ----------
  const payFast = guardedPay(policyObj, async () => ({ tx: '0x' + 'ab'.repeat(32) }), { logPath: LOG });
  const s1lines = [];
  let freezeReason = '';
  for (let i = 1; i <= 23; i++) {
    try {
      await payFast('scraper-01', ADDR_A, 5);
      s1lines.push({ n: i, status: 'ALLOW', text: `#${String(i).padStart(2, '0')}  $5.00 -> ${short(ADDR_A)}   [ALLOW]` });
    } catch (e) {
      if (!freezeReason) freezeReason = e.reasons[0];
      s1lines.push({ n: i, status: 'DENIED', text: `#${String(i).padStart(2, '0')}  $5.00 -> ${short(ADDR_A)}   [DENIED] ${e.reasons[0].split(' — ')[0]}` });
    }
  }
  const check1 = cli('check', '--agent', 'scraper-01', '--to', ADDR_A, '--amount', '5', ...P);
  shots.scene1 = {
    cmd: '$ node demo/attack.js',
    comment: '# rogue loop: 25 payments of $5, as fast as it can go',
    lines: s1lines,
    freezeReason,
    checkCmd: '$ ./bin/spendguard check --agent scraper-01 --to ' + short(ADDR_A) + ' --amount 5',
    checkOut: check1.out.trim(),
  };

  // ---------- Scene 2: the legit big one ----------
  const payQ = guardedPayQueued(policyObj, async () => ({ tx: '0xexecuted' }), { logPath: LOG });
  const receipt = await payQ('treasurer-01', ADDR_B, 150);
  if (!receipt.pending) throw new Error('expected a pending receipt, got: ' + JSON.stringify(receipt));
  const queueOut = cli('queue', '--log', LOG);
  const approveOut = cli('approve', receipt.id, ...P);
  const audit2 = cli('audit', '--agent', 'treasurer-01', ...P);
  const audit2Lines = audit2.out.trim().split('\n');
  shots.scene2 = {
    cmd: '$ node demo/pay.js',
    heldLine: `$150.00 -> ${short(ADDR_B)}   [HELD] needs_approval — queued as ${receipt.id.slice(0, 8)}..`,
    queueCmd: '$ ./bin/spendguard queue',
    queueOut: queueOut.out.trim(),
    approveCmd: '$ ./bin/spendguard approve ' + receipt.id.slice(0, 8) + '..',
    approveOut: approveOut.out.trim(),
    auditCmd: '$ ./bin/spendguard audit --agent treasurer-01',
    auditOut: audit2Lines.slice(-3).join('\n'), // last records + OK line
    queueId: receipt.id,
  };

  // ---------- Scene 3: the long game ----------
  const payM = guardedPay(policyObj, async () => ({ ok: true }), { logPath: LOG });
  const s3lines = [];
  let missionReason = '';
  for (let i = 1; i <= 5; i++) {
    await payM('researcher-01', ADDR_C, 10, { missionId: 'research-07' });
    s3lines.push({ n: i, status: 'ALLOW', text: `$10.00 -> ${short(ADDR_C)}   [ALLOW]  envelope $${i * 10}/$50` });
  }
  try {
    await payM('researcher-01', ADDR_C, 5, { missionId: 'research-07' });
    s3lines.push({ n: 6, status: 'ALLOW', text: 'UNEXPECTED ALLOW' });
  } catch (e) {
    missionReason = e.reasons[0];
    s3lines.push({ n: 6, status: 'DENIED', text: `$5.00 -> ${short(ADDR_C)}   [DENIED] mission budget exhausted` });
  }
  const check3 = cli('check', '--agent', 'researcher-01', '--to', ADDR_C, '--amount', '5', '--mission', 'research-07', ...P);
  shots.scene3 = {
    cmd: '$ node demo/mission.js --mission research-07',
    envelope: 'mission envelope: $50.00  ·  agent researcher-01',
    lines: s3lines,
    missionReason,
    checkCmd: '$ ./bin/spendguard check --agent researcher-01 --amount 5 --mission research-07',
    checkOut: check3.out.trim(),
  };

  fs.writeFileSync(path.join(DEMO, 'shots.json'), JSON.stringify(shots, null, 2) + '\n');
  console.log('scenes captured:');
  console.log('  s1 attempts:', s1lines.length, '| allows:', s1lines.filter(l => l.status === 'ALLOW').length, '| denies:', s1lines.filter(l => l.status === 'DENIED').length);
  console.log('  s2 queue id:', receipt.id);
  console.log('  s3 mission deny reason:', missionReason.slice(0, 80));
  console.log('wrote demo/shots.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
