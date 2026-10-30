# ADR-0012: A goal is a run

Status: accepted · Date: 2026-10-30
Builds on: ADR-0006 (the goal loop), ADR-0008 (roles are sessions), ADR-0010
(the implementation boundary), ADR-0011 (the goal belongs to the root session)
Evidence: issue #44, and the `preview-test` dump (`preview-test-dump-20261030T081352Z`),
`ANALYSIS.md` §6.2 and `LOOP-ANALYSIS.md` §2

## Context

`session_goal` holds one row for each session. The row holds the goal
definition and the run state in the same place.

`Goal.set` writes the row, and the conflict path preserves `authorized_at`,
`turns_used`, `phase`, `last_verdict`, `last_reason`, `last_verdict_session`,
and `state_hash`. `Goal.authorize` writes only when `authorized_at` is null.
The client keeps the last ruling and the checks by session id. The role
sessions identify their round by `goal_round`.

The `preview-test` run shows the result. The third goal replaced the second
goal after the second goal was finished. The third goal inherited the second
goal's authorization. It inherited eight turns: two from the first goal and
six from the second. It inherited the phase and the last verdict. Its card
showed the first goal's `Done` and handoff.

The third goal used 42 new turns against a budget of 50. QA rounds 1 to 8
belong to the earlier goals. QA rounds 9 to 50 belong to the third goal. The
goal reached `turns_used=50/50` and stayed `active` with `phase=dev`. The final
commit `ec44b11` came after the last judge. The state hash still described the
tree before that commit.

The eight lost turns cost about $2.17 at the measured $0.271 per new turn. The
larger cost is the acceptance gap: the final repair had no QA round.

The existing test `opencode/test/session/goal.test.ts` records the old policy:
a re-set after progress must keep the phase. That policy is the bug when the
new goal is a different task.

## Decision

### A goal definition has a generation

The goal row gets a `generation` value. A new row starts at generation 1. A
replacement increments the value. The projection, the goal events, and the
role session metadata all carry the generation.

The generation is the identity of one run. A session can have many goals over
its life. Only one run is current.

### An authorized goal is immutable

The goal definition is the goal text, the contract, and the gate commands with
their timeouts and retry limits. The size, the size reason, and the turn budget
are not part of the definition.

Before authorization, the goal can change. There is no run to protect.

After authorization, the definition is fixed. A different definition starts a
new run. A wording change after authorization is a new run unless the human
chooses to keep the old one. The old authorization covers the old definition,
not the new one.

### The human decides a replacement

The agent cannot know for certain whether a changed goal is a revision or a new
task. The `preview-test` agent did not know. A flag that the model must
remember is not sufficient.

When a session has an authorized goal and the new definition differs, the goal
tool asks the human. The question names the current phase, the turns used, the
last verdict, and the new goal. It states that the old run will reset and that
the new contract needs a new authorization.

If the human answers no, the tool writes nothing. The old goal and its run stay
as they were. If the human answers yes, the tool sets the goal with an explicit
`replace` value and resets the run. If the agent also asked to commit, the tool
then asks the normal commit question for the new contract, unless the two
questions were combined.

`Goal.set` refuses to overwrite an authorized definition without `replace`.
The model does not need to know the value. The tool provides the human decision,
and the service enforces it.

### A replacement resets the run

A replacement resets these fields:

- `generation` increments by one.
- `authorized_at` becomes null.
- `phase` becomes `dev`.
- `turns_used` becomes 0.
- `last_verdict`, `last_reason`, and `last_verdict_session` become null.
- `qa_record` and `state_hash` become null.
- `status` becomes `active`.
- Gate attempts, exit codes, and output tails reset.
- The new goal, size, contract, gates, and budget replace the old values.

The turn budget is per goal. A new goal starts at round 1, turn 0 of its own
budget. In the `preview-test` case, the third goal would have had its full
50-turn budget available, not the 42 turns it got. Its QA rounds would have
started at 1. The old rounds 1 to 8 would not appear under it.

### A new run needs a new authorization

The old `authorized_at` does not carry to a new generation. The loop does not
run until the human confirms the new contract. `Goal.authorize` writes the
timestamp for the current generation only.

### An unauthorized goal can be revised

If the session has a goal that is not authorized, a changed definition updates
that goal in place. The generation does not change. The goal stays
unauthorized, `phase` stays `dev`, and no verdict or run state exists. The
human can still reject the contract and ask for changes.

### A restart preserves the run

A server restart does not call `set`. The loop reads the existing row, and the
generation does not change.

If the agent sets the same goal and the same definition again, the operation is
idempotent. The generation, authorization, phase, turns, verdict, and gate
state stay. The goal tool can report that the goal is already authorized.

When the existing goal is terminal (`done`, `blocked`, or `budget_exhausted`)
and the agent asks for that goal again, the tool asks whether to start a new
run. A yes uses `replace` and resets the run. A no leaves the terminal goal.
A server restart does not call the tool and never asks.

### The old run cannot write the new one

A QA pass, a judge, or a phase change from an old run can finish after the new
goal exists. Generation checks must prevent it from changing the new row.

The progress methods take the generation they belong to:

- `setPhase`
- `setRecord`
- `clearRecord`
- `record`
- `burnTurn`
- `setStatus`
- `setGates`

Each write applies only when the session id and the generation match. A stale
role result becomes a no-op. The goal loop carries the generation it decided
under through QA and the judge. The events carry the generation. The loop
stops if the generation it started under is no longer current.

The old QA and judge sessions stay in the store. They are history from ADR-0008.
They are not part of the current run.

### The client reads the current generation

The goal projection includes the generation. The client uses it as the key for
its live state.

- `goalConclusion` uses a ruling only when the ruling generation matches the
  current goal. Otherwise it uses the projection.
- The checks and the roles filter by generation.
- The client clears the old ruling and checks when the generation changes.
- The goal events carry the generation, and the client ignores an old one.
- `goalRoles` reads `goal_generation` from the child metadata. A legacy child
  without the field is generation 1.

The new goal shows round 1, turn 0. The old `Done` and handoff cannot appear
under it.

### The budget ends in a named state

A goal at its turn limit must not stay `active` with `phase=dev`. When
`turns_used >= turn_budget`, the loop writes a terminal `budget_exhausted`
status and a stop reason. The goal card shows the status and the reason. A new
run requires a replacement.

The `status` value is part of the run state. A replacement clears it. A restart
of the same goal preserves it.

### Old data stays readable

The database migration adds `generation` with a default of 1 and adds the stop
reason field. Existing goal rows are generation 1. Existing events and role
sessions without a generation read as generation 1.

A new goal uses generation 2 or higher. Old role sessions and old events do not
appear under it.

## Consequences

- The third `preview-test` goal would start at round 1, turn 0 of 50. It would
  not spend eight turns from the earlier goals.
- The third goal would require a new authorization for its own contract.
- The old `Done`, handoff, checks, and QA rounds would not appear under the new
  goal.
- A QA pass or judge from the old run cannot write the new goal.
- A goal that spends its budget shows `budget_exhausted`, not `active`.
- The replacement question appears only when an authorized goal exists and the
  new definition differs. It is one human decision at the point where the
  product already asks for authorization.
- The old goal definition is not kept in the goal row. The old role sessions
  remain as history. A separate goal-history table is not part of this decision.
- The `preview-test` artifact is still not accepted. The final commit came after
  the last judge. A new goal from `ec44b11` with a clean state hash and a fresh
  budget is the path to acceptance. This ADR does not accept the old goal.
- The schema, events, role metadata, client store, and tests need changes. The
  migration must be sequential and must not edit an applied migration.

## Alternatives

**Require the model to pass `replace` without a human question.** This is less
friction for the agent, but the `preview-test` agent did not know it was
replacing a run. A missed flag must be a refusal, and the agent still has to
recover. The human question is the safer authority.

**Replace automatically when the goal text changes.** This is smooth, but a
wording revision can discard a run. The text alone does not show intent. The
human question does.

**Use a new session for each goal.** A fork is the right unit for independent
work under ADR-0011. A new task in the same session is still a valid product
case, and it needs a replacement path. A new session is not a substitute.

**Clear and insert the row without a generation.** This resets the row, but old
events and role sessions have nothing to match against. The generation is
necessary for fencing and filtering.

**Fix only the client.** The card would stop showing the old `Done`, but the
server would still carry the old authorization and the old turn count. The
`preview-test` run would still lose eight turns.

**Use `blocked` for the spent budget.** A blocked goal means an external
condition stopped the work. A spent budget is a different terminal state. A
named `budget_exhausted` status tells the human what happened.

## Out of scope

- The three QA rounds with no JSON and no judge in `preview-test`. A missing
  record or judge must stop or retry the round. That is a separate loop
  reliability decision.
- Acceptance of the post-judge commit `ec44b11`. That needs a QA pass on the
  repaired tree.
- The Phase 0 platform gaps, the orphan Employment Type master, and the
  inherited DataTable finding. They are product follow-ups from `ANALYSIS.md`.
- A durable history of replaced goal definitions. ADR-0008 makes role sessions
  the history of the run. A goal-history table is a later decision.
- Mid-run editing of an authorized contract. The choice is replace or keep.
- A parent-level authorization for child sessions. ADR-0011 covers that.
- The exact goal-tool question copy and the exact UI labels.

## Implementation surface

- `session_goal` gets `generation` and a stop reason. The `Status` and `Info`
  schemas get the new values. A new migration adds the columns.
- `Goal.set` gets the replace decision and the reset. `Goal.authorize` writes
  for the current generation. The progress methods take and check the
  generation.
- The goal tool asks the replacement question when an authorized definition
  differs. It passes `replace` only after a yes.
- QA and judge role metadata, the goal events, and the client goal state carry
  the generation.
- The goal strip filters the old ruling, checks, and roles. It shows the new
  round and turn state.
- The loop writes `budget_exhausted` and the stop reason when the budget is
  spent.
- Tests cover replacement, revision, restart, forced replacement, stale role
  results, the client filters, and budget exhaustion.

## Acceptance

- Set goal A. Authorize it. Record a verdict. Set goal B on the same session.
  The human confirms the replacement.
- Goal B has generation A + 1, `authorized=false`, `phase=dev`,
  `turns_used=0`, no last verdict, no last reason, no verdict session, no state
  hash, and status `active`.
- The card shows no old `Done` or handoff. It shows round 1, turn 0.
- Goal B requires a new authorization before the loop runs.
- The Run does not show the old role rounds.
- A QA pass or judge from goal A cannot write goal B.
- Set goal B again with the same definition. The generation, authorization,
  phase, turns, and verdict do not change.
- A goal at its budget shows `budget_exhausted` with a reason.
- A new goal from `ec44b11` has a clean state hash before it is called accepted.
