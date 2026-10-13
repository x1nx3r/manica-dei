# F1 — goal loop, context handoff

> **OBSOLETE.** A working note from the step-2 session (2026-10-13), kept for the
> record only — it describes step 2 as uncommitted, and it is not. Step 2 shipped
> as `ba6690cb4`; step 3 followed. Read `docs/adr/0006-goal-loop.md`,
> `f1-goal-loop-qa.md` and `f1-goal-loop-relay.md` instead of this file.

## Where things are

- Repo: `/home/x1nx3r/prototypes/manus-dei/ref/me-when-agents` — **our fork** of
  opencode. Branch `feat/goal-loop`, last commit `4c48caed5`.
- **Uncommitted: the step-2 patch** (the QA pass) — ~1222 insertions / 211
  deletions, 17 modified files + 3 new. Verified green except one test (below).
- Safety copy of the pre-fix state: `/tmp/opencode/qa-prefix/` (the tracked diff
  plus the three untracked files).
- `/tmp/opencode/` also holds: `qa-prefix/`, `wordle/` (the earlier live
  workspace), `eval-big-2.log`, and saved eval databases.

## The design, settled

`docs/adr/0006-goal-loop.md` is the authority. The shape in one line: **nobody
signs what they made.**

- **The chain:** dev → QA → judge → user. dev makes the artifact (QA signs);
  QA makes the record (the judge signs); the judge makes the verdict (the user
  signs). The eval signs the whole chain. QA and the judge must not merge — the
  rule applied recursively.
- **The user is at the two ends only:** the kickoff pins the outcome *and how
  they will check it*; the handoff may reject. In between, the three roles work
  alone. No human in the middle — that is the autonomy goal.
- **Three diets:** dev sees everything; QA sees the contract, the diff, the
  artifact, the gate's output — **never the transcript, the prose, or the
  scratchpad**; the judge sees the contract, the gate's output and **QA's
  record** — never the artifact, never the dev's story.
- **Sycophancy is the engine.** Each role is pleased by its own aim (dev by
  delivering, QA by breaking it, the judge by being right). Pointed, not fought.
- **The record** is per acceptance criterion: the probe and its outcome. Silence
  is abstention, not a pass. Two kinds of probe — the contract's own checks, and
  **probes QA derives** (the holdout, re-derived each round).
- **A probe counts only if** it is executed, can fail (test-integrity replay),
  reads the effect from the system of record, and is **reachable** — a changed
  symbol nothing calls is a contradiction.
- **The judge frames, it does not compose** (decided after review). The three-part
  relay is labels around QA's own fields; every clause must trace to the record.
- **Give the observation, withhold the probe's command** (decided). The dev needs
  "the queue is empty when a request is six days old"; it does not need the
  command, which it could tune to.
- **`derived` is mandatory for `clean`** (decided by the user). A pass made only
  of the author's own checks is an abstention.
- **Prefer a fact over a rule.** Hand the judge something true (a captured gate
  result, a diff hash, a record) before writing more prose.

## Done, on the branch

| commit | what |
|---|---|
| `cbfdd565a` | ADR-0006 rewritten around the judging strategy |
| `bd4df7f71` | the judge keys done on the **outcome**, and blocks on the stop condition |
| `37ee28e2e` | the human ratifies the contract at commit |
| `74bfff222` | the judge is handed the gate's own output |
| `62580a2af` | ADR-0006 rewritten as **a chain of signatures** |
| `55861620e` | step 1: the phase machine (`dev｜qa｜judge`) + the state handle |
| `4c48caed5` | the QA pass draft (`docs/implementation-notes/f1-goal-loop-qa.md`) |

Study material in `ref/` (all gitignored): `VERIFICATION-REFERENCE.md`, the six
checkouts (`coding-quality-loop`, `dev-loop`, `adversarial-code-loop`,
`agent-research-book`, `agentpatternscatalog`, `loop-protocol`), and `papers/`
— 13 papers as PDF **and** parsed text, with `papers/README.md` carrying the
licenses and the corrections from the full read.

## The immediate next step

The step-2 patch is **green except one test**:

```
packages/core                     46 pass  0 fail
packages/opencode (5 goal files)  46 pass  0 fail
bun turbo typecheck               21/21
migration --check                 synced
goal-loop.integration               5 pass  1 fail
```

The failure is a **timeout, not logic**: `a goal runs to done` finished in
5291 ms against bun's default **5000 ms** per-test limit, and the test behind it
finished at 5011 ms. The QA pass added a model call plus a server boot to an e2e
already at the edge.

1. Raise the per-test timeout on
   `packages/opencode/test/session/goal-loop.integration.test.ts` to ~30 s.
2. Re-run that file. Green → commit and push the step-2 patch.

## Then, step 3

The judge's three-part `handoff` relay (§5 of the QA draft): QA tested / your
implementation / the likely cause, **framed not composed**, minus the probe's
command. The patch deliberately does not contain it.

## How to run things here

- Tests: `bun test` **in the package directory** (`packages/core`,
  `packages/opencode`). Typecheck: `bun turbo typecheck` **at the root**.
- **Never pipe a spawn-happy test through `tail`.** `timeout` kills `bun`, but a
  spawned server child keeps the pipe open and the read never returns — that is
  what hung this work twice. Redirect to a file, then read the file.
- Migrations: `bun run script/migration.ts --name <name>` from `packages/core`,
  then `--check`. Sequential; never edit an applied migration.
- Known pre-existing failures: **6 Cloudflare gateway tests** in
  `packages/opencode` (unrelated), and 2 schema event-manifest tests.
- The fork's conventions live in `AGENTS.md` files at the root and per package.

## Working with the user

- **Document first, then code.** The ADR and the implementation notes come before
  the patch, and the user reviews the draft (§ the QA draft is an example).
- **Ask before committing to a flagged decision.** Stop and report when stuck
  rather than iterating silently.
- **Short answers.** No looping. The user will push back on a frame, and the
  pushback is usually right — check the artifact rather than conceding or
  defending.
- **The score is worthless; the transcript is the evidence.** Same rule the eval
  is built on.
