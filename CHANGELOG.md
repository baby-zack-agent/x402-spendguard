# Changelog

## 0.2.0 — 2026-09-26

The always-on-agent release: guardrails for agents that run for weeks with their own wallets.

- **Velocity freeze** — new policy fields `velocityMax` / `velocityWindowSec` (defaults: 20 payments per 60s, per-agent overridable). Exceeding the rolling count denies with "velocity freeze" until the window passes. Blocked attempts count too, so a retrying runaway stays frozen; the freeze lifts after a quiet window. Counted from the audit trail.
- **Approval queue (hold-and-resume)** — `guardedPay` with `{ queue: true }` (or `guardedPayQueued`) holds `needs_approval` intents in a persistent JSON queue instead of throwing, returning a pending receipt with an ID. CLI: `spendguard queue` / `approve <id>` / `deny <id>`. API: `queue.approve(id, paymentFn)` executes the original payment, `queue.deny(id)` discards. Every resolution is hash-chained into the audit trail. Fail-closed: unapproved payments never execute.
- **Per-mission budgets** — optional `missionId` through `decide()` / `guardedPay()` / CLI `--mission` / facilitator. New `missionCap` policy field (defaults + per-agent, `null` = disabled). Lifetime spend per `(agentId, missionId)` tracked from the audit trail; exceeding it denies with "mission budget exhausted".
- **Facilitator plugin** — `lib/facilitator.js`: drop-in Express-style `(req, res, next)` guard for x402 facilitator servers. Reads `{ agentId, to, amountUsd, missionId }` from `req.body.payment`; `allow` → `next()`, `deny` → 403, `needs_approval` → 402 (with `queueId` when queueing is on). Malformed bodies are denied fail-closed. Example in `examples/facilitator.js`.
- **Attestation** — signed Ed25519 receipts for agent actions (see ATTESTATION.md).

Zero dependencies, as always. 65/65 tests green.

## 0.1.0 — 2026-09-25

Initial release: zero-dependency policy engine for autonomous x402 payments.

- Pure `decide()`: `{agentId, to, amountUsd}` → `allow | deny | needs_approval` with human-readable reasons.
- Policy: global defaults + per-agent overrides — daily/weekly/monthly caps, per-transaction cap, allowlist, denylist, approval threshold.
- Tamper-evident audit trail: hash-chained JSONL, every decision (including blocked ones) recorded.
- `guardedPay` middleware: wraps any x402 payment function, fail-closed.
- CLI: `init`, `check`, `audit`.

19/19 tests green.
