'use strict';
// Append-only JSONL audit trail with a tamper-evident hash chain.
// Each record embeds the sha256 of the previous record's hash, so any edit
// to history breaks verify(). Stdlib crypto only.
const fs = require('node:fs');
const crypto = require('node:crypto');

const GENESIS = 'GENESIS';

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function readRecords(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`audit log corrupt at line ${i + 1}`);
    }
  });
}

// Hash covers the whole record except the hash field itself.
function canonical(entry) {
  const { hash, ...body } = entry;
  return JSON.stringify(body);
}

function computeHash(entry, prev) {
  return sha256(prev + canonical(entry));
}

function append(record, logPath) {
  const records = readRecords(logPath);
  const prev = records.length ? records[records.length - 1].hash : GENESIS;
  const entry = {
    ts: new Date().toISOString(),
    agentId: record.agentId,
    to: record.to,
    amountUsd: record.amountUsd,
    asset: record.asset || null,
    missionId: record.missionId || null,
    decision: record.decision,
    reasons: record.reasons || [],
    prev,
  };
  entry.hash = computeHash(entry, prev);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function verify(logPath) {
  const records = readRecords(logPath);
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.prev !== prev) {
      return { ok: false, count: records.length, badIndex: i, reason: 'prev-hash link broken' };
    }
    if (computeHash(rec, rec.prev) !== rec.hash) {
      return { ok: false, count: records.length, badIndex: i, reason: 'hash mismatch — record was tampered with' };
    }
    prev = rec.hash;
  }
  return { ok: true, count: records.length };
}

// Rolling spend for one agent. Only 'allow' decisions consume caps —
// denied or needs_approval payments never executed, so they don't count.
function usageFor(agentId, logPath, now = Date.now()) {
  const records = readRecords(logPath);
  const sums = { day: 0, week: 0, month: 0 };
  const DAY = 24 * 3600 * 1000;
  for (const r of records) {
    if (r.agentId !== agentId) continue;
    if (r.decision !== 'allow') continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    const age = now - t;
    const amt = Number(r.amountUsd) || 0;
    if (age < DAY) sums.day += amt;
    if (age < 7 * DAY) sums.week += amt;
    if (age < 30 * DAY) sums.month += amt;
  }
  for (const k of Object.keys(sums)) sums[k] = Math.round(sums[k] * 100) / 100;
  return sums;
}

// Payment count for one agent inside a rolling window (seconds). Counts EVERY
// decision — including blocked ones — so a runaway agent can't dodge the
// velocity freeze by failing, and stays frozen while it keeps retrying.
function velocityFor(agentId, logPath, windowSec, now = Date.now()) {
  if (!windowSec || windowSec <= 0) return 0;
  const records = readRecords(logPath);
  const windowMs = windowSec * 1000;
  let count = 0;
  for (const r of records) {
    if (r.agentId !== agentId) continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    if (now - t < windowMs) count++;
  }
  return count;
}

// Lifetime spend for one (agentId, missionId) pair. Only 'allow' decisions
// count — blocked or queued payments never moved money.
function missionUsageFor(agentId, missionId, logPath) {
  if (!missionId) return 0;
  const records = readRecords(logPath);
  let sum = 0;
  for (const r of records) {
    if (r.agentId !== agentId) continue;
    if (r.decision !== 'allow') continue;
    if (r.missionId !== missionId) continue;
    sum += Number(r.amountUsd) || 0;
  }
  return Math.round(sum * 100) / 100;
}

module.exports = { append, verify, usageFor, velocityFor, missionUsageFor, readRecords, computeHash, canonical, GENESIS };
