# F1 — the goal loop: implementation plan

Executable plan for the decision in `docs/adr/0006-goal-loop.md`. Ordered
milestones; each lands green before the next. Every milestone names its files
and its tests.

This part of the feature is abstract — the size rubric, the ask rubric, and
the judge's judgement are prompt-level and cannot be unit-tested. §7 is
therefore not optional: the abstract half needs an **eval harness**, and the
mechanical half needs tests exhaustive enough that the eval only has to cover
judgement, not plumbing.

Background: `PLAN.md` F1, `docs/adr/0006-goal-loop.md`.

---

## 0. The shape

```
goal set ─▶ SCOPE ─▶ COMMIT ──authorized──▶ WORK ─▶ GATES ─▶ JUDGE ─┬─ continue ─▶ WORK
   ▲          │         │                            │              ├─ done ─────▶ stop
   │     (question)  (question:                  (fail: output       ├─ blocked ─▶ question
   │          │      "run unattended?")           is the prompt)    └─ wait ────▶ park
   └──────────┴────────────────────────────────────────────────────
```

The judge runs only when a goal exists **and** is authorized. Without both,
`runLoop` behaves exactly as it does today. The gates run before the judge;
a failing gate short-circuits it and its bounded output becomes the
continuation.

---

## 1. M1 — Goal state (persisted)

The durable record. Nothing else works until a goal can be stored, read, and
distinguished from "authorized".

**Files**

| File | Change |
|---|---|
| `packages/core/src/session/sql.ts` | a `GoalTable` beside `TodoTable` (`:100`) |
| `packages/core/src/database/migration/*.ts` | a new migration (timestamped; never edit an applied one) |
| `packages/opencode/src/session/goal.ts` | a `Goal` service, mirroring `todo.ts` |

**Schema.** `session_id` (PK), `goal`, `size`, `size_reason`, `contract` (the
five fields — outcome, verification, constraints, boundaries, stop_when — as
JSON), `gates` (the executable form of `verification`: command, timeout,
max_retries, attempts, last_exit_code, last_output_tail; JSON), `authorized_at`
(nullable), `turn_budget`, `turns_used`, `last_verdict`, `status`,
`time_created`, `time_updated`.

**Acceptance.** A goal round-trips. A goal with no `authorized_at` is
distinguishable and never loops. `turns_used` and `last_verdict` persist. The
contract's five fields and the gate list round-trip intact.

**Tests** (`packages/opencode/test/session/goal.test.ts`)

- set → get round-trips every field
- a fresh goal has `authorized_at == null`
- `authorized_at` is set exactly once and is not cleared by a re-read
- `turns_used` increments and persists
- `last_verdict` persists
- two sessions have independent goals
- deleting a session removes its goal (FK behaviour)
- migration applies from empty and from the prior schema

---

## 2. M2 — The scratchpad

**Files**

| File | Change |
|---|---|
| `packages/opencode/src/session/session.ts` | generalize `plan()` (`:331`) into a scratchpad path |
| `packages/opencode/src/session/scratchpad.ts` | read / write / upsert-section |

**Acceptance.** A per-session markdown file with stable sections; survives
compaction untouched.

**Tests** (`packages/opencode/test/session/scratchpad.test.ts`)

- write then read round-trips
- the path is deterministic for a session and distinct across sessions
- every named section is present after init (Goal, Size, Contract,
  Assumptions, Subgoals, Open questions, Decisions)
- `upsertSection` replaces a section and leaves siblings byte-identical
- a section with no cap grows: a 20 KB assumption list is written and read
  whole (the "hefty" requirement, asserted rather than assumed)
- **compaction invariant**: run compaction, then assert the scratchpad file
  is byte-identical (this is the whole reason it is a file)

---

## 3. M3 — The judge, split pure from effect

The parser is the single most important thing to test exhaustively, because a
mis-parse silently ends or extends a run.

**Files**

| File | Change |
|---|---|
| `packages/core/src/session/goal/judge.ts` | `buildJudgePrompt()` and `parseVerdict()`, both pure |
| `packages/opencode/src/session/goal-judge.ts` | the model call, wrapping the pure pair |

**Acceptance.** All four verdicts parse; anything malformed fails **open**
(`continue`).

**Tests** (`packages/core/test/session/goal/judge.test.ts`)

*parseVerdict — every accepted shape*
- `{"verdict":"done","reason":"x"}` → `done`
- `{"verdict":"blocked","reason":"x"}` → `blocked`
- `{"verdict":"continue","reason":"x"}` → `continue`
- `{"verdict":"wait","wait_on_session":"s"}` → `wait`
- `{"verdict":"wait","wait_on_pid":123}` → `wait`
- `{"verdict":"wait","wait_for_seconds":600}` → `wait`
- legacy `{"done":true}` → `done`; `{"done":false}` → `continue`

*parseVerdict — the failures that must not break a run*
- malformed JSON → `continue` (fail-open)
- empty string → `continue`
- an unknown verdict string → `continue`
- JSON with no verdict and no `done` → `continue`
- a reasoning preamble before the JSON object → parses the object
- the JSON wrapped in a ```json fence → parses
- extra unknown fields → ignored, verdict honoured
- `wait` with none of the three keys → `continue` (a `wait` with nothing to
  wait on must not park forever)

*buildJudgePrompt — bounded and complete*
- includes the goal, the contract, and the last response
- includes the assumption ledger when present, omits the block when absent
- does **not** include the whole transcript (assert a size ceiling)
- the contract is present verbatim

---

## 4. M4 — Gates and loop wiring

Two changes at the exit of `runLoop` (`session/prompt.ts:1088`, `:1111-1130`):
run the gates first, then consult the judge.

**Files**

| File | Change |
|---|---|
| `packages/opencode/src/session/goal-gate.ts` | run a gate command, capture exit code + bounded output tail, track retries |
| `packages/opencode/src/session/prompt.ts` | before the break: gates, then the goal/judge |
| `packages/opencode/test/session/goal-gate.test.ts` | the runner, pure |
| `packages/opencode/test/session/goal-loop.test.ts` | the loop, with an injected fake judge |

**Acceptance.** No goal → today's behaviour, byte-for-byte. Goal + authorized →
gates run before the judge; a failing gate short-circuits the judge and its
output tail is the continuation; the four verdicts act as specified; the budget
is the floor; consecutive judge failures trip the circuit breaker.

**Tests** — the loop is driven with a **fake judge**, so these are
deterministic.

*Gates*
- a passing gate → the judge runs
- a failing gate → the judge is **not** called; the continuation carries the
  output tail
- a gate that fails past `max_retries` → the loop stops as `blocked`
- a gate that passes after failing once → `attempts` resets and the judge runs
- gates run in the session workspace, not the process directory

*Regression (the one that must never break)*
- **no goal set → the loop exits exactly as before.** Asserted against the
  current exit condition, not a snapshot.

*Authorization*
- goal set, not authorized → the loop does not continue
- goal set, authorized → the gates and judge are consulted on exit

*Verdict effects*
- `continue` → a new user message is appended and the turn runs again
- `done` → the loop exits, the goal is marked done
- `blocked` → the `question` tool is invoked and the loop parks
- `wait` → the loop parks without spending a turn; resumes on the barrier

*Budget and the circuit breaker*
- turns equal to the budget → the loop stops
- one under the budget → it continues
- the budget is per goal and survives a re-read
- consecutive parse failures → pause, naming the judge config
- consecutive transport failures → pause, naming the judge config
- a single failure → `continue` (fail-open)

*The cache invariant (the load-bearing one)*
- across a continuation, the **system prompt prefix is byte-identical**.
  Assert the prefix, not a hash of the whole request, and not a snapshot.

*The scratchpad*
- `turns_used` and `last_verdict` are written to the goal each turn
- the scratchpad's Subgoals section is updated on `continue`

---

## 5. M5 — Scope, commit, and the `goal` tool

**Files**

| File | Change |
|---|---|
| `packages/opencode/src/session/prompt/*.txt` | the scope and commit prompts |
| `packages/opencode/src/tool/goal.ts` | the `goal` tool: the agent's kickoff — writes goal, size, contract, gates |
| `packages/opencode/src/session/goal.ts` | the authorization write |
| `packages/opencode/test/session/goal-commit.test.ts` | — |

**Acceptance.** A fresh goal goes scope → commit → authorized → loop. A goal
that never gets authorization never loops. The contract's `verification` becomes
the gate the loop runs.

**Tests**

- the `goal` tool writes goal, size, contract, and gates in one call
- the tool refuses a contract with an empty `verification`
- answering the commit question sets `authorized_at`
- declining leaves it null and the session idle
- the authorization survives a service restart (re-read from disk)
- a second turn does not re-ask once authorized
- the scratchpad is written at commit with Goal, Size, and Contract
- a size of `huge` routes to a split proposal, not to work

---

## 6. M6 — Guarded integration

One real run, end to end, behind the existing guard.

**Files**: `packages/opencode/test/session/goal-loop.integration.test.ts`

**Tests** (`MANUS_INTEGRATION=1`, skipped otherwise)

- a trivial goal with a real model completes: scope → commit → loop → `done`
- the judge is a real model call and its verdict is honoured
- a goal whose contract cannot be met ends `blocked` and asks, rather than
  looping to the budget
- the shared browser is usable during a run (the two features compose)

---

## 7. M7 — The eval harness (the abstract half)

There is no eval infrastructure in the fork today. This milestone adds a
small one, because **the size rubric, the ask rubric, and the judge's
judgement are prompt-level and cannot be unit-tested.** A unit test can prove
the parser handles `blocked`; it cannot prove the judge *recognises* a blocked
run.

**Files**: `evals/goal-loop/` — a runner, a golden set, a scorer.

**Shape.** Each case is `{ input, expected }`, run against a real model,
scored. These are evals (probabilistic, scored), not tests (deterministic,
pass/fail). Run them on model changes and on prompt changes; report the score
rather than gating CI on a threshold that will flake.

**The three suites**

*Size classification* — `{ task statement } → expected size`
- a fully-specified one-file fix → `small`
- a feature with a few reversible choices → `medium`
- a feature touching auth, with a migration → `large`
- "make the app better" → `huge` (must propose a split, not start)

*Ask rubric* — `{ task statement } → expected questions`
- a task that determines everything → **zero** questions
- a task missing one load-bearing fact → exactly one
- a task requiring an irreversible action → a question, even though the
  action is inferable
- a task answerable from the repo alone → zero (the agent reads the repo
  instead of asking)

*Judge quality* — `{ contract, transcript } → expected verdict`
- the deliverable exists and is shown → `done`
- the agent says "done" but the deliverable is absent → not `done`
- the agent explains the goal is impossible → `blocked`, not `done`
- work remains with a clear next step → `continue`
- the agent is waiting on a build → `wait`
- the agent is confidently wrong, having declared done with no evidence →
  not `done` (this is the case the whole loop exists to catch)

**Why these three.** They are the three places the feature can be *wrong
without failing*. Everything else fails loudly; these fail silently, which is
exactly why the user asked for tests here.

---

## 8. Order and dependencies

```
M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6
                   └─▶ M7 (can start once M3 lands; needs M4 to score)
```

M1–M4 are the spine and are unit-testable. M5 is prompt work with thin tests.
M6 proves composition. M7 is the only honest coverage for the abstract half
and should not be skipped.

---

## 9. Explicitly not built, and not tested

- No daemon-side loop, no cron, no scheduler (ADR-0006, Out of scope).
- No spend-cap enforcement; the turn budget is the only floor.
- No cross-session memory or skill learning.
- No navigation allowlist, no external service.
- No change to the human's RFB transport.

---

## 10. Open risks

- **The judge is a model call per stop.** Cost and latency scale with the
  budget. M7's judge suite should report cost per case, not just accuracy.
- **A gate command can be wrong or hang.** It runs with a timeout, its output
  is bounded, and a gate that cannot pass stops the loop as `blocked` rather
  than looping — but the contract is only ever as good as its `verification`.
  This is why `verification` must be a command, and why a goal that cannot
  name one is a scoping failure.
- **Cache-stability is fragile.** Any future change that injects the
  scratchpad mid-conversation breaks it; M4's prefix test is the guard.
- **The eval harness is new infrastructure.** It is the smallest thing that
  covers judgement; resist growing it into a framework before there is a
  second consumer.
- **Size self-assessment can be wrong.** The human can override, and the
  scratchpad records the reason, so a bad call is visible rather than silent.
