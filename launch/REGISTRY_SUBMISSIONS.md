# Registry submissions — x402-spendguard v0.2.0

## Filed (live PRs)

### 1. x402.org ecosystem (coinbase/x402) — PR #354
- **URL**: https://github.com/coinbase/x402/pull/354
- **What**: `typescript/site/app/ecosystem/partners-data/x402-spendguard/metadata.json` + logo at `typescript/site/public/logos/x402-spendguard-logo.png`, category **Infrastructure & Tooling**
- **Status**: open, awaiting maintainer review (typical ~5 business days per their docs)
- **Watch for**: merge conflicts if their partners-data restructures; review comments asking for a live demo URL (we have the repo demo/).

### 2. awesome-x402 (xpaysh/awesome-x402) — PR #1635
- **URL**: https://github.com/xpaysh/awesome-x402/pull/1635
- **What**: entry under **🔒 Security & Audits → Spending Controls & Policy Enforcement**
- **Entry text**:
  `- [x402-spendguard](https://github.com/baby-zack-agent/x402-spendguard) - Control layer for AI agent wallets: velocity freeze stops runaway loops, approval queues hold big payments for human sign-off, per-mission budgets cap long-running agents. Pure \`decide()\` before money moves, hash-chained audit trail. Zero dependencies, MIT. Built by an AI agent, for AI agents. ([demo](https://github.com/baby-zack-agent/x402-spendguard/tree/master/demo))`
- **Status**: open, awaiting maintainer merge

### 3. GitHub topics — DONE
Set via API on `baby-zack-agent/x402-spendguard`:
`agent-safety, ai-agents, crypto, guardrails, mcp, payments, stablecoins, x402`

## Not filed — needs Tika or follow-up work

### 4. awesome-mcp (punkpeye/awesome-mcp-servers, 95k stars) — HOLD
Not filed: the list only accepts actual MCP servers, and the MCP server wrapper isn't built yet. **Follow-up**: build the MCP wrapper (expose `decide`/`check`/`queue` as MCP tools), then file the PR. This is also the highest-leverage impress-OpenAI move.

### 5. x402-guild directory — DRAFT (needs Tika's word to file)
They accept submissions via GitHub Issue (not PR). Draft issue body below — file at https://github.com/x402-guild/x402-guild/issues/new when approved:

---
**Project name and URL**: x402-spendguard — https://github.com/baby-zack-agent/x402-spendguard
**One-sentence description**: Control layer for AI agent wallets on x402: velocity freeze, approval queues, per-mission budgets, and a hash-chained audit trail — decide() runs before money moves.
**Category**: `infrastructure-tooling`
**Networks supported**: chain-agnostic (policy layer; works with any x402 facilitator/settlement network)
**Readiness**: `experimental`
---

### 6. npm — STILL POLICY-BLOCKED
- Retried 2026-09-26 via `~/workspace/tools/npm-raw-put.mjs`: `403 policy_denied` (`zz_managed_internal_spaces_package_registries`, `PUT /<pkg> not permitted by policy`).
- Stopped per instructions — not fighting it. Install path stays `git clone` until the registry policy reopens. Retry weekly.
