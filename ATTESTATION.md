# ProofPay Attestation — signed receipts for agent actions (v0.2 spec)

## Problem
x402 lets agents pay. The audit trail proves *the guardrail* saw the payment.
Neither proves to a **third party** — a buyer, a marketplace, another agent —
that a specific agent really authorized a specific action. Attestation closes
that gap: every covered action produces a signed receipt anyone can verify
with the agent's public key. No shared secrets, no trusted intermediary.

## What gets signed
A receipt is a JSON object. The signature covers the canonical bytes:
`JSON.stringify` of the receipt with keys in the fixed order below and the
`sig` field removed. Signers MUST build receipts via `attest.issue()` (or
replicate its field order exactly); verifiers MUST re-canonicalize with
`attest.canonical()` before checking the signature.

| Field            | Meaning |
|------------------|---------|
| `v`              | Receipt format version (`1`) |
| `receiptId`      | `rcpt_` + 16 hex chars, unique per receipt |
| `agentId`        | The acting agent's stable identity |
| `action`         | What was done, e.g. `x402.payment`, `escrow.release`, `outcome.deliver` |
| `to`             | Destination address / counterparty |
| `amountUsd`      | Amount in USD (number, 2dp) |
| `asset`          | Settlement asset, e.g. `USDC` (null when n/a) |
| `network`        | Settlement network, e.g. `base-sepolia` (null when n/a) |
| `txHash`         | Settlement tx hash (null until settled) |
| `policyDecision` | The spendguard verdict: `allow` / `deny` / `needs_approval` |
| `auditHash`      | `sha256` of the linked audit-trail record — ties the receipt to the tamper-evident log |
| `ts`             | ISO-8601 timestamp of issuance |
| `sig`            | Ed25519 signature (base64) over the canonical bytes |

## Who verifies
Anyone holding the agent's **public key**. Verification is offline and
permissionless:

1. `attest.verify(receipt, publicKeyPem)` — schema check + signature check.
2. `attest.verifyAgainstLog(receipt, publicKeyPem, logPath)` — additionally
   confirms `auditHash` exists in the hash-chained audit log and the chain
   itself is intact, binding the receipt to tamper-evident history.

Key distribution: the agent publishes its public key (e.g. `keys/<agentId>.ed25519.pub`
in this repo, or alongside its profile). First-use trust-on-first-use is
acceptable for low-value flows and MUST be documented by the publisher;
high-value verifiers should pin the key out-of-band.

## Where it lives
- Receipts are plain JSON files — one per action — written wherever the
  operator wants them (`receipts/` by convention, or returned to the caller).
- The audit trail remains the hash-chained JSONL log (`lib/audit.js`);
  `attest.issue()` appends the audit record first, then embeds its hash in
  the receipt, so the two are cryptographically linked in both directions.
- Private keys never leave the operator's machine. They are NOT committed;
  `.gitignore` covers `*.pem` and `keys/*.ed25519` (private halves).

## Cryptography
Ed25519 via Node's built-in `crypto` (stdlib only, zero dependencies — the
repo's standing constraint). Signatures are deterministic per RFC 8032 as
implemented by OpenSSL; canonical bytes are UTF-8.

## Non-goals (v0.2)
Revocation lists, key rotation ceremonies, and multi-sig receipts are
explicitly out of scope. A compromised key is handled by publishing a new
public key and noting the rotation timestamp; verifiers decide their own
trust window.
