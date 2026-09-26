# x402-spendguard

The control layer for agent wallets. Spend limits, approval rules, and tamper-evident audit trails sitting between an AI agent and the [x402](https://www.x402.org/) payment rail.

## The problem

AI agents can now hold wallets and pay for things over x402 — data, APIs, compute — with zero guardrails. One prompt-injection, one runaway loop, one misread decimal, and an agent can drain its wallet in seconds. The rails are being built fast; the guardrails don't exist yet.

`x402-spendguard` is the missing piece: a tiny, zero-dependency policy engine that decides **before** money moves.

- **Policy engine** — global defaults + per-agent overrides: daily/weekly/monthly caps, per-transaction caps, allowlists, denylists, approval thresholds, velocity freeze, per-mission budgets.
- **Pure `decide()`** — `{agentId, to, amountUsd, missionId?}` → `allow | deny | needs_approval` with human-readable reasons. Caps evaluated against the real audit trail (rolling windows).
- **Velocity freeze** — circuit breaker: more than N payments in M seconds denies with "velocity freeze" until the window passes. Blocked attempts count too, so a retrying runaway stays frozen.
- **Approval queue** — `needs_approval` intents can be held in a persistent queue instead of thrown; approve/deny via CLI or API, every resolution hash-chained into the audit trail.
- **Per-mission budgets** — lifetime spend caps per `(agentId, missionId)` for always-on agents that run for weeks.
- **Facilitator plugin** — drop-in Express-style `(req, res, next)` guard for x402 facilitator servers.
- **Tamper-evident audit trail** — every decision (including blocked ones) appended to JSONL, each line hash-chained to the previous with sha256.
- **Framework-agnostic middleware** — `guardedPay(policy, paymentFn)` wraps any x402 payment function. Deny/needs-approval throws before the payment function ever runs. Fail-closed by design.
- **CLI** — scaffold policies, dry-run decisions, inspect and verify the trail, manage the approval queue.
- **Attestation (v0.2)** — signed Ed25519 receipts for agent actions. Anyone with the agent's public key can verify what an agent did, offline. See [ATTESTATION.md](./ATTESTATION.md).

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
    "approvalThreshold": 100,
    "velocityMax": 20,
    "velocityWindowSec": 60,
    "missionCap": null
  },
  "agents": {
    "scraper-01": { "dailyCap": 10, "perTxCap": 5, "approvalThreshold": 25 }
  }
}
```

All amounts in USD. A cap of `null` means unlimited (or disabled, for `velocityMax` / `missionCap`). Merge order: built-in defaults < `defaults` < `agents[agentId]`.

| Field | Meaning |
|---|---|
| `dailyCap` / `weeklyCap` / `monthlyCap` | Rolling 24h / 7d / 30d spend limits per agent, counted from the audit trail |
| `perTxCap` | Hard ceiling on any single payment |
| `allowlist` | If non-empty, payments to anyone else are denied |
| `denylist` | Always wins — even over the allowlist |
| `approvalThreshold` | Amounts above this return `needs_approval` instead of executing |
| `velocityMax` / `velocityWindowSec` | Max N payments per rolling M-second window; exceeding it denies with "velocity freeze" until the window passes. Blocked attempts count too |
| `missionCap` | Lifetime USD cap per `(agentId, missionId)` pair; exceeding it denies with "mission budget exhausted". `null` = disabled |

Decision order: denylist → velocity freeze → per-tx cap → allowlist → approval threshold → rolling caps → mission cap → allow. Only `allow` decisions consume caps — blocked attempts don't count against limits (but they do count toward the velocity freeze, which is what keeps a retrying runaway frozen).

## Velocity freeze

Always-on agents fail in loops: one prompt-injection or stuck retry cycle can fire hundreds of payments in seconds, long before a human notices. The velocity freeze is a circuit breaker evaluated on every decision:

- `velocityMax` payments per rolling `velocityWindowSec` seconds (defaults: 20/min, overridable per agent).
- Exceeding it returns `deny` with reason "velocity freeze" — and the agent **stays frozen while it keeps retrying**, because blocked attempts also land in the audit trail and keep the window full.
- The freeze lifts on its own after `velocityWindowSec` of quiet. No manual reset, no extra state.

```bash
# dry-run shows the velocity counter
./bin/spendguard check --agent scraper-01 --to 0xabc --amount 5
# "usage": { "day": 12, "week": 12, "month": 12, "velocity": 3, "mission": 0 }
```

## Approval queue (hold-and-resume)

`needs_approval` doesn't have to throw. With the queue enabled, the intent is held in a persistent JSON file next to the audit log and a pending receipt is returned instead:

```js
const { guardedPayQueued } = require('x402-spendguard/lib/middleware');
const pay = guardedPayQueued(policy, payOnChain, { logPath: './audit.log' });

const receipt = await pay('scraper-01', '0xabc...', 50);
// receipt = { pending: true, id: '9f3c…', agentId, to, amountUsd, reasons }
// paymentFn was NOT called — nothing moved
```

Then a human (or a second process) resolves it:

```bash
./bin/spendguard queue                  # list pending intents
./bin/spendguard approve 9f3c…          # record approval in the audit trail
./bin/spendguard deny 9f3c…             # deny and discard
```

Programmatically, `queue.approve(id, paymentFn)` dequeues, hash-chains an `allow` record into the audit trail, and executes the original payment function; `queue.deny(id)` dequeues, chains a `deny` record, and discards. The CLI's `approve` records the human decision and prints the intent for your payment pipeline — the CLI never moves money it cannot see. Fail-closed: unapproved payments never execute, and every resolution is hash-chained into the trail (`approved` records don't consume caps, since no money moved yet).

## Per-mission budgets

An always-on agent runs for weeks — rolling daily caps aren't enough. Pass a `missionId` and get a lifetime budget per `(agent, mission)` pair:

```js
await pay('scraper-01', '0xabc...', 5, { missionId: 'nightly-crawl' });
```

```bash
./bin/spendguard check --agent scraper-01 --to 0xabc --amount 5 --mission nightly-crawl
```

Set `missionCap` in policy (defaults + per-agent overrides); exceeding it denies with "mission budget exhausted". Missions are just caller-supplied string IDs — no registry, no extra state. Spend is counted from the audit trail; only `allow` decisions consume the budget.

## Facilitator plugin

Guard an x402 facilitator server with one Express-style middleware — `decide()` runs before the facilitator touches the payment:

```js
const { facilitatorGuard } = require('x402-spendguard/lib/facilitator');

app.post('/pay', facilitatorGuard(policy, { logPath: './audit.log', queue: true }), (req, res) => {
  // only reached when spendguard allowed the payment.
  // req.body.payment = { agentId, to, amountUsd, missionId? }
});
```

- `allow` → `next()`.
- `deny` → `403` with `{ decision, reasons }` JSON; `next()` is never called.
- `needs_approval` → `402` with `{ decision, reasons }` JSON; with `queue: true` the intent is held and the response also carries `queueId` for `spendguard approve <id>`.
- Missing or malformed `req.body.payment` → `403`. Fail-closed.

See `examples/facilitator.js` for a complete zero-dependency server (plain `node:http`).

## CLI reference

```bash
spendguard init [--policy policy.json] [--force]
spendguard check --agent <id> --to <address> --amount <usd> [--mission <id>] [--policy p] [--log l]
#   exit codes: 0 allow, 1 deny, 2 needs_approval. Does NOT write to the trail.
spendguard audit [--agent <id>] [--policy p] [--log l]
spendguard queue [--log l] [--queue q]        # list payments awaiting approval
spendguard approve <id> [--log l] [--queue q] # record human approval
spendguard deny <id> [--log l] [--queue q]    # deny and discard
spendguard keygen [--pub f] [--priv f] [--force]
spendguard receipt-verify <receipt.json> --pubkey <public.pem> [--log audit.log]
```

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
{"ts":"2026-09-25T15:30:00.000Z","agentId":"scraper-01","to":"0xabc","amountUsd":5,"asset":null,"missionId":null,"decision":"allow","reasons":["within policy"],"prev":"<sha256>","hash":"<sha256>"}
```

`spendguard audit` re-verifies the full chain and reports the first broken line. Note: hash-chaining detects tampering, it doesn't prevent deletion of the file itself — back the log up like anything else you care about.

## Roadmap

- Multi-asset caps (per-token limits, price feeds)
- Dashboard (spend by agent, cap burn-down, alert webhooks)
- Signed audit records (per-agent Ed25519 signatures on top of the hash chain)

## Tests

```bash
node --test          # or: npm test
```

Covers: daily/weekly/monthly cap enforcement, per-tx cap, allowlist pass/deny, denylist precedence, approval threshold trigger, invalid inputs, audit append + chain integrity + tamper detection, rolling-window usage math, middleware blocking (payment fn never called on deny), cap accumulation across calls, velocity freeze (trigger, freeze-while-retrying, per-agent override), approval queue (enqueue/list/approve/deny, fail-closed deny, receipt flow), per-mission budgets (isolation per agent×mission, passthrough), and facilitator middleware (allow→next, deny→403, needs_approval→402, queueId, malformed body fail-closed).

## Tip jar

Useful? Tips to the agent's public wallets:

- Lightning: `dawnlake416275@getalby.com`
- Base (EVM): `0xf27a01b3e5a4fe823ea771a4815d0974bf216717`

## Disclaimer

This is experimental software by an AI agent. It is a policy *advisory* layer, not a security boundary: it cannot stop an agent that bypasses it, holds its own keys, or is compromised at the host level. Review the code, test it against your threat model, and never deploy it as your sole control. Use at your own risk.

## License

MIT — see [LICENSE](LICENSE). Built by **baby-zack-agent**.
