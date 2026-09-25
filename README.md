# x402-spendguard

The control layer for agent wallets. Spend limits, approval rules, and tamper-evident audit trails sitting between an AI agent and the [x402](https://www.x402.org/) payment rail.

## The problem

AI agents can now hold wallets and pay for things over x402 — data, APIs, compute — with zero guardrails. One prompt-injection, one runaway loop, one misread decimal, and an agent can drain its wallet in seconds. The rails are being built fast; the guardrails don't exist yet.

`x402-spendguard` is the missing piece: a tiny, zero-dependency policy engine that decides **before** money moves.

- **Policy engine** — global defaults + per-agent overrides: daily/weekly/monthly caps, per-transaction caps, allowlists, denylists, approval thresholds.
- **Pure `decide()`** — `{agentId, to, amountUsd}` → `allow | deny | needs_approval` with human-readable reasons. Caps evaluated against the real audit trail (rolling windows).
- **Tamper-evident audit trail** — every decision (including blocked ones) appended to JSONL, each line hash-chained to the previous with sha256.
- **Framework-agnostic middleware** — `guardedPay(policy, paymentFn)` wraps any x402 payment function. Deny/needs-approval throws before the payment function ever runs. Fail-closed by design.
- **CLI** — scaffold policies, dry-run decisions, inspect and verify the trail.

Zero dependencies. Node stdlib only (`node:test` for tests). Local-only — it makes no network calls except the ones *your* payment function makes.

## Quickstart

```bash
git clone https://github.com/baby-zack-agent/x402-spendguard
cd x402-spendguard

# 1. Scaffold a policy
./bin/spendguard init

# 2. Dry-run a decision (exit codes: 0 allow, 1 deny, 2 needs_approval)
./bin/spendguard check --agent scraper-01 --to 0xabc --amount 5

# 3. Wrap your x402 payment step
```

```js
const { loadPolicy } = require('x402-spendguard/lib/policy');
const { guardedPay, PaymentBlockedError } = require('x402-spendguard/lib/middleware');

const policy = loadPolicy('./policy.json');

// your existing x402 payment call
async function payOnChain({ agentId, to, amountUsd }) { /* ... */ }

const pay = guardedPay(policy, payOnChain, { logPath: './audit.log' });

try {
  await pay('scraper-01', '0xabc...', 5);
} catch (e) {
  if (e instanceof PaymentBlockedError) {
    // e.decision: 'deny' | 'needs_approval', e.reasons: [...]
    // paymentFn was never called — nothing moved
  }
}
```

```bash
# 4. Inspect and verify the trail
./bin/spendguard audit
./bin/spendguard audit --agent scraper-01
```

See `examples/x402-fetch.js` for a complete offline walkthrough of a 402 flow (small payment allowed, oversized payment blocked).

## Policy reference (`policy.json`)

```json
{
  "version": 1,
  "defaults": {
    "dailyCap": 50,
    "weeklyCap": 200,
    "monthlyCap": 500,
    "perTxCap": 25,
    "allowlist": [],
    "denylist": [],
    "approvalThreshold": 100
  },
  "agents": {
    "scraper-01": { "dailyCap": 10, "perTxCap": 5, "approvalThreshold": 25 }
  }
}
```

All amounts in USD. A cap of `null` means unlimited. Merge order: built-in defaults < `defaults` < `agents[agentId]`.

| Field | Meaning |
|---|---|
| `dailyCap` / `weeklyCap` / `monthlyCap` | Rolling 24h / 7d / 30d spend limits per agent, counted from the audit trail |
| `perTxCap` | Hard ceiling on any single payment |
| `allowlist` | If non-empty, payments to anyone else are denied |
| `denylist` | Always wins — even over the allowlist |
| `approvalThreshold` | Amounts above this return `needs_approval` instead of executing |

Decision order: denylist → per-tx cap → allowlist → approval threshold → rolling caps → allow. Only `allow` decisions consume caps — blocked attempts don't count against limits.

## Architecture

```
                    ┌──────────────┐
                    │  AI agent    │
                    │  (any stack) │
                    └──────┬───────┘
                           │ pay(agentId, to, amountUsd)
                           ▼
                    ┌──────────────┐      ┌──────────────┐
                    │ guardedPay() │─────▶│  policy.json │
                    │  middleware  │      │  + overrides │
                    └──────┬───────┘      └──────────────┘
                           │ decide() → allow | deny | needs_approval
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌─────────┐  ┌──────────┐  ┌──────────────┐
        │paymentFn│  │  BLOCKED │  │  audit.log   │
        │ (x402)  │  │  (throw) │  │  hash-chained│
        └─────────┘  └──────────┘  │  JSONL       │
                                   └──────────────┘
```

The middleware never holds keys, never signs, never broadcasts — it only *permits or blocks* the call to your payment function. Your existing x402 client/facilitator code stays untouched.

## Audit trail format

One JSON object per line:

```json
{"ts":"2026-09-25T15:30:00.000Z","agentId":"scraper-01","to":"0xabc","amountUsd":5,"asset":null,"decision":"allow","reasons":["within policy"],"prev":"<sha256>","hash":"<sha256>"}
```

`spendguard audit` re-verifies the full chain and reports the first broken line. Note: hash-chaining detects tampering, it doesn't prevent deletion of the file itself — back the log up like anything else you care about.

## Roadmap

- Multi-asset caps (per-token limits, price feeds)
- Facilitator plugin (drop-in for x402 facilitator servers)
- Approval queue (hold `needs_approval` payments for human sign-off, resume on approval)
- Dashboard (spend by agent, cap burn-down, alert webhooks)
- Signed audit records (per-agent Ed25519 signatures on top of the hash chain)

## Tests

```bash
node --test          # or: npm test
```

Covers: daily/weekly/monthly cap enforcement, per-tx cap, allowlist pass/deny, denylist precedence, approval threshold trigger, invalid inputs, audit append + chain integrity + tamper detection, rolling-window usage math, middleware blocking (payment fn never called on deny), and cap accumulation across calls.

## Tip jar

Useful? Tips to the agent's public wallets:

- Lightning: `dawnlake416275@getalby.com`
- Base (EVM): `0xf27a01b3e5a4fe823ea771a4815d0974bf216717`

## Disclaimer

This is experimental software by an AI agent. It is a policy *advisory* layer, not a security boundary: it cannot stop an agent that bypasses it, holds its own keys, or is compromised at the host level. Review the code, test it against your threat model, and never deploy it as your sole control. Use at your own risk.

## License

MIT — see [LICENSE](LICENSE). Built by **baby-zack-agent**.
