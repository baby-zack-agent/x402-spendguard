'use strict';
// Signed receipts for agent actions (v0.2).
// Every covered action produces a JSON receipt signed with the agent's
// Ed25519 key. Anyone with the public key can verify it offline — no shared
// secrets, no trusted intermediary. See ATTESTATION.md for the full spec.
// Stdlib crypto only (zero dependencies).
const crypto = require('node:crypto');
const audit = require('./audit');

// Fixed field order for canonical bytes. Signers and verifiers MUST agree.
const FIELDS = ['v', 'receiptId', 'agentId', 'action', 'to', 'amountUsd',
  'asset', 'network', 'txHash', 'policyDecision', 'auditHash', 'ts'];

function canonical(receipt) {
  const body = {};
  for (const k of FIELDS) body[k] = k in receipt ? receipt[k] : null;
  return JSON.stringify(body);
}

function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// fields: { agentId, action, to, amountUsd, asset?, network?, txHash?,
//           policyDecision, auditHash? }
// When logPath is given, the audit record is appended first and its hash
// becomes the receipt's auditHash, linking receipt <-> tamper-evident log.
function issue(fields, privateKeyPem, logPath) {
  if (!fields || typeof fields.agentId !== 'string' || !fields.agentId) {
    throw new Error('attest.issue: agentId is required');
  }
  if (!fields.action || !fields.to) {
    throw new Error('attest.issue: action and to are required');
  }
  let auditHash = fields.auditHash || null;
  if (logPath) {
    const entry = audit.append({
      agentId: fields.agentId,
      to: fields.to,
      amountUsd: fields.amountUsd,
      asset: fields.asset || null,
      decision: fields.policyDecision,
      reasons: [`attested:${fields.action}`],
    }, logPath);
    auditHash = entry.hash;
  }
  const receipt = {
    v: 1,
    receiptId: 'rcpt_' + crypto.randomBytes(8).toString('hex'),
    agentId: fields.agentId,
    action: fields.action,
    to: fields.to,
    amountUsd: Math.round(Number(fields.amountUsd) * 100) / 100,
    asset: fields.asset || null,
    network: fields.network || null,
    txHash: fields.txHash || null,
    policyDecision: fields.policyDecision,
    auditHash,
    ts: new Date().toISOString(),
  };
  const sig = crypto.sign(null, Buffer.from(canonical(receipt), 'utf8'),
    crypto.createPrivateKey(privateKeyPem));
  receipt.sig = sig.toString('base64');
  return receipt;
}

function verify(receipt, publicKeyPem) {
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, reason: 'not an object' };
  }
  for (const k of ['v', 'receiptId', 'agentId', 'action', 'to', 'ts', 'sig']) {
    if (!(k in receipt)) return { ok: false, reason: `missing field: ${k}` };
  }
  if (receipt.v !== 1) return { ok: false, reason: 'unsupported version' };
  let sig;
  try {
    sig = Buffer.from(receipt.sig, 'base64');
  } catch {
    return { ok: false, reason: 'sig is not valid base64' };
  }
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(canonical(receipt), 'utf8'),
      crypto.createPublicKey(publicKeyPem), sig);
  } catch {
    return { ok: false, reason: 'public key unusable' };
  }
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch — receipt was tampered with or wrong key' };
}

// verify() plus: the receipt's auditHash must exist in the log and the
// hash chain must be intact.
function verifyAgainstLog(receipt, publicKeyPem, logPath) {
  const v = verify(receipt, publicKeyPem);
  if (!v.ok) return v;
  const chain = audit.verify(logPath);
  if (!chain.ok) {
    return { ok: false, reason: `audit chain broken at line ${chain.badIndex + 1}` };
  }
  if (!receipt.auditHash) {
    return { ok: false, reason: 'receipt carries no auditHash link' };
  }
  const found = audit.readRecords(logPath).some((r) => r.hash === receipt.auditHash);
  if (!found) {
    return { ok: false, reason: 'auditHash not found in the audit log' };
  }
  return { ok: true };
}

module.exports = { keygen, issue, verify, verifyAgainstLog, canonical, FIELDS };
