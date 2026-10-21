# F1 · The loop's three live-fire hardenings

Shipped: PR #19 (`da5a44f8a`), released in v0.4.3
Read with: `docs/adr/0006-goal-loop.md`, and `f1-live-run-udinus.md`

Three failures from the live corpus, each with the same shape: the mechanism
existed, but a boundary the design depended on was not enforced where the model
could reach it.

## 1 — Self-safe process kills

**What happened.** QA ran `pkill -9 -f 'next'`. The pattern matched its own
shell, the pass died, and the loop paid a burned round and a dev turn.

**What changed.** `ProcessGuard` (`packages/core/src/tool/process-guard.ts`)
refuses `pkill -f`, `killall -r`, and `pgrep -f | kill` in both bash tools (v1
`packages/opencode/src/tool/shell.ts`, v2 `packages/core/src/tool/bash.ts`). The
refusal names the safe path: a PID, or `pkill -x <exact>`. QA's brief carries
the rule as well, so the role reads the constraint before it acts.

**Residual, found in `udinus`.** The rule matches the co-occurrence of the
strings, not the data flow. A command that used a PID for the kill and `pgrep -f`
only for an echo was refused:

```
kill 4146; … pgrep -f "next dev" || echo …
```

The fix is pipeline awareness — `pgrep -f … | xargs kill` and
`$(pgrep -f …)` are the shapes worth refusing — not a wider string list.
Not shipped.

## 2 — Durable loop denials

**What happened.** ADR-0006 calls the judge tool-less and QA non-editing. The
deployed operator config allowed both, and because permissions are
last-match-wins, the global allows repealed the roles' denials. QA wrote ten
probe files through a boundary the ADR calls inviolate.

**What changed.** `agent/agent.ts` re-asserts the judge's deny-all and QA's
`edit`/`write`/`patch` denies **after** the operator config is merged, so the
last match is the role's own. The pins run under an allow-all config: the judge
has no tools, QA cannot edit, and bash stays available to both.

The ordering is the decision. A denial that can be overridden by the layer
beneath it is a comment, not a boundary.

## 3 — Runnable verifications only

**What happened.** A goal carried a verification clause ending "…, plus browser
screenshots…". The dev could not run prose, the gate could not check it, and two
rounds burned before the loop moved on.

**What changed.** `tool/goal-verification` refuses prose at the goal tool and
points descriptive clauses to `constraints`. A verification is a command the
gate can run; anything else belongs in the contract's constraints, where it is
read rather than executed.

## Verification at the time

- typecheck: 0 errors.
- core: **1220 / 0**, including the guard pins (refusals, allowances, refusal
  text).
- opencode: **966 / 0** across session, snapshot, agent, tool — including the
  tool-less judge and non-editing QA under allow-all, the prose refusal end to
  end, and the helper cases.

No new surface, no secret, no dependency.

## What the live run then showed

`udinus` ran on 0.4.3 with all three in place. The pass was clean; the guard
false positive above was the one mechanical refusal of the run, and it was a
false one. That is the right way for this class to fail — loud and wrong beats
silent and wrong — but it still cost a retry, which is why the pipeline fix
stays on the list.
