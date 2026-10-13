# F1 — step 4: measure the loop

Draft for review. Steps 2 and 3 shipped (`ba6690cb4`, `489f7b53e`). This is the
eval that licenses them — and it is currently blind to both.

Read with `evals/goal-loop/README.md`, `evals/goal-loop/meta/rubric.md`, and
`sessions/goal-loop`. ADR-0006 says the eval signs the whole chain, and that the
score is worthless while the transcript is the evidence.

---

## 1. Where the eval stands

The machinery is real and was used: a **meta-agent** on GLM 5.3 flash drives an
**inner** session on DeepSeek v4.1 flash through the documented API, plays a
persona against `fixtures/hris/`, and returns a scorecard
(`evals/goal-loop/run.ts`). Three runs exist in the record, and one of them
produced the finding the loop was then redesigned around: a green gate over an
`escalate()` that nothing called.

What it scores (`meta/rubric.md`):

| half | dimensions |
|---|---|
| the agent | `size`, `questions`, `contract`, `drift` |
| the judge | `verdict`, `evidence` |
| the outcome | `gate`, `cost` |

**There is no row for QA.** Two stochastic layers and a rubric written before the
reviewer existed.

And the observer **cannot see it even if the rubric asked**: `.opencode/tool/drive.ts`
reads `/session/${inner}/message` only. The QA pass runs in a **child session** —
that is what makes its context fresh — and a child has its own id, so the
meta-agent reads the dev's transcript and never the reviewer's.

So today's scorecard would report a run in which QA never derived a probe, or
derived one that reads nothing, as a clean success — the exact failure the loop
exists to prevent.

## 2. What must change

Three things, and they are the three links step 2 and 3 added.

**The observation channel.** `GET /session/:sessionID/children` is a documented
route (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:82`).
The `drive` tool gains one action that lists the inner session's children and
returns the reviewer's transcript — the **diet** it was given (the contract, the
diff, the gate's output) and the **record** it returned. That is the reviewer's
own evidence, over the API, with no knowledge of our schema.

It also lets the meta-agent check the load-bearing claim directly: the reviewer's
prompt must not contain the dev's prose or the scratchpad.

**Two rows in the rubric**, under a new "the reviewer" heading:

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **derives** | no record, or no probe | a probe, none derived — an abstention wore a badge | a derived probe that reads the effect from the system of record |
| **finds** | ran the author's checks and agreed | derived, but probed something that works | derived, and found what nothing calls — the seeded trap |

**One row for the judge's new job** (it was scored on verdicts; step 3 made it
the moderator):

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **moderates** | relays whatever QA said, or concludes off a contradiction | weighs the record | weighs it, ratifies or rejects from the record, and the relay names the cause — with the probe's command withheld |

**The meta-agent's brief** (`run.ts:174-179`) gains a line: read the reviewer's
transcript before scoring it. Without that the rubric's rows are unreachable.

## 3. The case, and what it discriminates

`cases/big.md` is the one to run. Its trap is seeded and precise: the FSD
documents `pending ──▶ escalated` (line 49) and **nothing implements it** — no
code, and the schema's `status` check rejects the value. The doc says an agent
that assumes it exists "will build on sand", and the right move is to ask.

That makes it a test of the whole chain at once:

- the **dev** must not invent the missing semantics;
- **QA** must derive a probe that reads the effect — query the queue, or try the
  status — and find the sand;
- the **judge** must refuse `done` over a green gate while the escalation is
  inert, and if QA contradicts, relay the cause.

A run that ends `done` with a green gate and an escalation nothing invokes is the
loop failing, whatever the scorecard says.

## 4. What this cannot measure

- **A fabricated finding.** The judge's rejection is observable if it happens,
  but QA cannot be *forced* to invent one, so the rejection path has no guaranteed
  probe. It is the one link with no case behind it.
- **Cost parity.** The QA pass adds a model call per round. The eval reports cost;
  it cannot say whether the review is worth it. That is the user's call at handoff.

## 5. What I want you to judge

1. **The channel.** A `drive` action over `/session/:id/children` (my lean: it is
   the documented API, and it also exposes the diet), versus a goal route on the
   product surface (widens the seam for the eval's sake), versus reading the
   inner SQLite in the runner (couples the eval to our schema, and to a database
   the harness was told to stay out of). My lean: children.
2. **Score the mechanism, or only the outcome?** The outcome is cheap and
   unambiguous; the mechanism is the claim. My lean: both — a rubric that only
   reads the gate cannot distinguish "the loop worked" from "the agent was
   lucky".
3. **The matrix.** One run (`big × hr`) first, since we hold its earlier failure
   and can compare; then `medium × senior` as the contrast where the loop should
   sail. Or the case's other two personas (`intern` — the agent should infer;
   `senior` — terse answers).
4. **Where the plan lives.** This note, or `evals/goal-loop/README.md` — which is
   also **stale**: it says "Only `fixtures/hris/` exists today", and the cases,
   the meta-agent, the rubric and the runner have existed since `8182c8628`.

## 6. Acceptance

- The `drive` tool can reach the reviewer's transcript; a kept run in `runs/`
  contains it, so the evidence outlives the number.
- The scorecard carries the reviewer and moderation rows.
- `big × hr` run to completion, its scorecard and transcript kept.
- The README no longer lies about what exists.

---

## 7. Runs, recorded

**`big × hr`, run 1 — the harness, not the loop.** The reviewer never ran
(`derives: 0`, *"no child sessions — the reviewer never ran"*), and the loop's
last note was *"stops rather than pass unaudited"*.

The cause is not the loop. The fixture is not a git repository, snapshots are
git-only (`packages/opencode/src/snapshot/index.ts:168` — `if (state.vcs !==
"git") return false`), so the round had no state and the loop refused before the
gate or the reviewer. The runner now initializes and commits the workspace copy.
A real workspace is a repository; the unit suite needed the same thing
(`{ git: true }`), and the ADR's state binding now states it.

Two things the run did show before it stopped:

- **`drift: 2`** — the agent named the trap plainly: *"docs/FSD.md:49 promises
  pending→escalated … but `escalated` isn't in the `LeaveStatus` type and no rule
  implements it"*. The case's discriminator is live.
- **`gate: fail`** — the work did not pass its own verification. The loop never
  reached the judge, so that is still unmeasured.
