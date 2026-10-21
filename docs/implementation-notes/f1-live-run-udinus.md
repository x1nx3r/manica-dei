# F1 · The `udinus` live run, read after the fact

Source: `evals/goal-loop/runs/udinus-live-2026-10-21/INDEX.md` and the
`sessions/` transcripts pulled from the container's agent-state database.
The raw pull is inventory only; this note is the reading of it.

## Shape of the run

| | |
| --- | --- |
| project / template | `udinus` / `nextjs-starter` |
| workspace | one repository, `app/`; the root is not a repo |
| agent | 0.4.3 at the time of the pull |
| dev | `ses_ea272cc29ffe6H2ZDol8R50iTd`, qwen3.8-flash, 285 messages, $0.5936 |
| QA | `ses_ea23e0c22ffes8ZqLM5n9VRUc7`, glm-5.3-flash, 34 messages, $0.2985 |
| judge | `ses_ea2372db1ffe8HR3nc8hfwwZ7T`, glm-5.3-flash, 2 messages, $0.00047 |
| result | gate passed first try (42/42), QA clean, judge `done`, turns 1/50 |
| state | `md1-0f40d7712be009437cb535d29ae9106999b663ffa8f1e7789a0e131142f2c0b7` |

The dev model was **qwen3.8-flash**, not the baked glm, so cost and quality
comparisons must name the model.

## What worked

- The loop ran end to end on the first turn: dev → gate → QA → judge.
- The gate passed on the first attempt, 42 of 42 checks. The app was real:
  login gate, wrong password, tasks, categories, recurrence all verified in
  screenshots.
- QA ran 13 probes of which 12 derived their own evidence and 1 reported
  `could-not-run`; the record was clean.
- The review surface worked with the workspace shape: 34 files, `app/`
  prefixes, and the `REPO` badge rather than an implied folder.
- The state hash is a composite (`md1-…`) over the one-repo workspace, which is
  the ADR-0009 shape.

## What the judge could not see

The dev's last narration, sent 15 seconds before QA spawned:

> The blocker: PR. I can't open the pull request from this container: gh is not
> authenticated…

The judge never sees the dev's narration — it reads the artifact and the
records, by design. So its `done` is **contract-correct**: the standing goal's
stop condition was the gate, and the gate passed. The undeclared blocker is a
delivery constraint outside the contract.

**Verdict:** the loop's mechanics are sound, and the judge's blind spot is the
design's price, not a defect. But the run shows the cost of having **no
structured channel for "blocked"**: a blocker that the dev can only say in
prose is invisible to the role that decides whether to stop. The prose is in
the trail; nothing routes it into the decision.

## Defects the run exposed

| defect | disposition |
| --- | --- |
| goal strip missing on a page that outlived a restart | fixed in v0.4.4 — `f1-cold-state.md` |
| file pane blank for tree-opened/restored tabs | fixed in v0.4.4 — `f1-cold-state.md` |
| the process guard refused a PID-targeted cleanup | open — see below |
| browser tool `get text` / element refs misbehaved | reported during the run, not reproduced in isolation; no change made |

### The guard false positive

The run issued:

```
kill 4146; … pgrep -f "next dev" || echo …
```

`process-guard.ts` refused it although the kill is PID-targeted: the rule
matches `pgrep -f` and `kill` anywhere in the command, not a pipeline
(`pgrep -f … | xargs kill`, `$(pgrep -f …)`). The fix is to detect the actual
data flow rather than the co-occurrence of two strings. Not shipped.

## Cost, as the meter read it

- glm run rates: fresh $0.15/M, cache read $0.03/M, output + reasoning $0.50/M.
- The picker-goal total was $0.91 at a 97.7% cache ratio.
- deepseek-flash on the same work: about $0.22 off-peak (4.2× less) and $0.44
  at peak.

The dev's $0.59 on qwen3.8-flash is the number that matters. The QA and judge
costs are smaller because their context is the record, not the repository, so
they say little about what the work costs to do.

## What the run argues for next

1. **A structured `blocked` channel** the dev can raise, carried to the judge,
   so a declared blocker can make `stop_when` enforceable rather than narrated.
2. **A `could-not-run` policy**: one probe could not run on a contract clause.
   The run treated it as non-contradicting. That needs a rule, not a default.
3. **The guard's pipeline awareness** (above).
4. **Browser tool `get text` / refs**: reproduce before changing anything.

## The environment drifted under the notes

Verified while writing this note, 2026-10-21 16:49 UTC:

```
docker ps        session-68b471b5   127.0.0.1:32783->4096/tcp   Up 3 hours
docker inspect   created 2026-10-21T13:50:33Z
                 image manus-dei/nextjs-starter@sha256:74dc44f6…
readlink /proc/1/exe   /usr/local/bin/opencode (deleted)
/usr/local/bin/opencode --version   0.4.5
cp /proc/1/exe … && … --version     0.4.4
```

So:

- The container was **re-created** at 13:50 UTC. The raw pull's provenance
  (agent 0.4.3, image `5763a1…`, port 32776) describes the **earlier**
  instance; the name is reused.
- The running server is **0.4.4**, the binary on disk is **0.4.5**. The process
  holds the old, unlinked inode: something copied the new binary into the
  container but did not restart PID 1. `/run/manus/version` does not exist.
- The cold-state fixes are therefore live (they are in 0.4.4); the
  manifest-bearing 0.4.5 is not.
- The port moved again (32769 → 32783), which is the same class of drift that
  can produce a stale page: a tab that keeps an old origin keeps a dead stream
  and failed fetches, and without a resync it never notices.

This is an upgrade-path observation for the manus side, not a fork defect: the
fork publishes the manifest and the artifacts; the activation belongs to deusd
and the entrypoint supervisor (ADR-019 v1).
