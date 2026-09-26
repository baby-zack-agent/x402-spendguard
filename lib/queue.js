'use strict';
// Persistent human-approval queue for payments that decide() flagged
// needs_approval. Stored as a JSON array in a file next to the audit log.
// Fail-closed: a queued payment never executes without a recorded approval,
// and every resolution (approve/deny) is hash-chained into the audit trail.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const audit = require('./audit');

function defaultQueuePath(logPath) {
  return path.join(path.dirname(path.resolve(logPath)), 'spendguard-queue.json');
}

function readQueue(queuePath) {
  let raw;
  try {
    raw = fs.readFileSync(queuePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('queue file corrupt: not valid JSON');
  }
  if (!Array.isArray(data)) throw new Error('queue file corrupt: expected a JSON array');
  return data;
}

function writeQueue(queuePath, entries) {
  const tmp = `${queuePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, queuePath);
}

// intent: { agentId, to, amountUsd, asset?, missionId?, reasons? }
function enqueue(intent, queuePath) {
  if (!intent || !intent.agentId || !intent.to) {
    throw new Error('enqueue requires { agentId, to, amountUsd }');
  }
  const entries = readQueue(queuePath);
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    ts: new Date().toISOString(),
    status: 'pending',
    agentId: intent.agentId,
    to: intent.to,
    amountUsd: intent.amountUsd,
    asset: intent.asset || null,
    missionId: intent.missionId || null,
    reasons: intent.reasons || [],
  };
  entries.push(entry);
  writeQueue(queuePath, entries);
  return entry;
}

function list(queuePath) {
  return readQueue(queuePath).filter((e) => e.status === 'pending');
}

function get(queuePath, id) {
  return readQueue(queuePath).find((e) => e.id === id) || null;
}

// Remove and return a pending entry, or null.
function take(queuePath, id) {
  const entries = readQueue(queuePath);
  const i = entries.findIndex((e) => e.id === id);
  if (i === -1) return null;
  const [entry] = entries.splice(i, 1);
  writeQueue(queuePath, entries);
  return entry;
}

// Full approval: dequeue, hash-chain an allow record into the audit trail,
// then execute the payment. For use inside the agent process that owns the
// paymentFn. Throws if the entry is missing/not pending or paymentFn is absent.
async function approve(queuePath, logPath, id, paymentFn) {
  if (typeof paymentFn !== 'function') {
    throw new TypeError('paymentFn must be a function');
  }
  const entry = take(queuePath, id);
  if (!entry) throw new Error(`no pending queue entry ${id}`);
  audit.append({
    agentId: entry.agentId,
    to: entry.to,
    amountUsd: entry.amountUsd,
    asset: entry.asset,
    missionId: entry.missionId,
    decision: 'allow',
    reasons: [`approved from queue ${id}`],
  }, logPath);
  const result = await paymentFn({
    agentId: entry.agentId,
    to: entry.to,
    amountUsd: entry.amountUsd,
    missionId: entry.missionId,
  });
  return { entry, result };
}

// Human-in-the-loop approval decision (e.g. `spendguard approve <id>`):
// dequeue, hash-chain an 'approved' record into the audit trail, and hand the
// intent back for execution in the operator's own payment pipeline. The CLI
// never moves money it cannot see — execution stays fail-closed in your process
// via approve(id, paymentFn).
function recordApproval(queuePath, logPath, id) {
  const entry = take(queuePath, id);
  if (!entry) throw new Error(`no pending queue entry ${id}`);
  audit.append({
    agentId: entry.agentId,
    to: entry.to,
    amountUsd: entry.amountUsd,
    asset: entry.asset,
    missionId: entry.missionId,
    decision: 'approved',
    reasons: [`approved from queue ${id} by operator — execute via your payment pipeline`],
  }, logPath);
  return entry;
}

// Deny: dequeue, hash-chain a deny record, discard the intent. The payment
// never executes.
function deny(queuePath, logPath, id) {
  const entry = take(queuePath, id);
  if (!entry) throw new Error(`no pending queue entry ${id}`);
  audit.append({
    agentId: entry.agentId,
    to: entry.to,
    amountUsd: entry.amountUsd,
    asset: entry.asset,
    missionId: entry.missionId,
    decision: 'deny',
    reasons: [`denied from queue ${id}`],
  }, logPath);
  return entry;
}

module.exports = { defaultQueuePath, enqueue, list, get, approve, recordApproval, deny };
