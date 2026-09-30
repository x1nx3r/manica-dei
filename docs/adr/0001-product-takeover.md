# ADR-0001: Product takeover of opencode; upstream is pull-only

Status: accepted · Date: 2026-09-30
Companion record: manus-dei `docs/adr/007-product-fork.md` (read-only)

## Context

me-when-agents began as a clone of `anomalyco/opencode` (MIT) — originally
framed as "our fork" with an upstream merge cadence. The product vision
makes the UI deeply coupled to manus-dei (preview tabs, session trail,
spend, snapshot, identity, possibly file editing): exactly the kind of
divergence a tracking fork must re-merge forever. MIT means the codebase
can simply be taken and built upon.

## Decision

This repository is a **product takeover** of an MIT codebase — not an
enhanced upstream and not a tracking fork.

- `main` is the product line; all work lands here.
- `dev` mirrors `anomalyco/opencode` and stays **fetch-only**: never pushed
  to, never merged wholesale into `main`.
- The upstream relationship is **pull-only cherry-picks** — security fixes
  especially — taken at our discretion, on no schedule.
- This repo's CI builds and releases the linux-x64 server binary and the
  web UI bundle from `main`; the manus-dei template pins **these** releases.
- Package trimming is a deferred avenue, not an early action (see PLAN.md).
- Identity restarts on this repo (version `0.1.0`-style); the MIT `LICENSE`
  and upstream copyright notice are retained — the only license obligation
  a takeover carries.

## Consequences

- Security response for the entire session payload (server + UI) is ours,
  discharged as pull-only cherry-picks from upstream.
- manus-aware features live here without apology; the only discipline is
  direction: this repo may depend on manus-dei's *documented API*, never
  its source, and manus-dei is read-only to agents here.
- Branch layout at acceptance: `main` = `dev` = `5d993994a`
  (upstream `2fa3363c9` + lockfile renewal).
