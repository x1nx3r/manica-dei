# ADR-0011: The goal belongs to the root session

Status: accepted · Date: 2026-10-28
Builds on: ADR-0006 (the goal loop), ADR-0010 (the implementation boundary)
Evidence: the `pos2` run (`d655c6d3-f182-4675-8816-d539839574a8`),
`LOOP-ANALYSIS.md` §4.2–4.3

## Context

A root session can spawn `task` subagents. Each subagent is a child session
with its own id, its own tool list, and — until this decision — the `goal`
tool.

In `pos2`, three web subagents called `goal` with `commit: true`. The goal tool
asks the human to confirm the outcome and its verification. The subagents did
not know the root's contract, so each asked for its own. Those questions were
asked at 12:24–12:25 WIB and answered at 14:13–14:14; the root did not resume
until 14:37 — about **1h48m of human latency** that the loop spent waiting on
people, not on a model.

The child goals were also unverifiable. Each child loop tried to start
`goal-qa`, hit `subagent_depth=1`, failed open, and burned its turns. The log
records nine QA pass failures across the three subagents; the child goals
remained unverified. The root later ran its own QA over the aggregate work.

The root cause is a permission and a prompt assumption:

- `general` inherits the default `"*": "allow"` and only denies `todowrite`;
  `goal` is allowed. The goal tool's `commit` branch calls `Question.ask`
  **directly**, so the subagent's default `question: deny` never applied.
- The product prompt tells the agent to set the goal when the work is agreed.
  A fresh child has no parent goal context and reads its task as the thing to
  contract.

## Decision

**A goal belongs to the root session.** A root session is a session with no
`parentID`; a fork is a new root. A subagent executes a delegated task under the
root's contract; it does not create another goal, another contract, or another
human authorization.

The boundary is enforced at two layers, and the child is told what it is
working under:

1. **Permission.** Every agent with `mode: "subagent"` gets `goal: "deny"`
   merged **after** the operator config, because permission evaluation is
   last-match-wins. This covers `general`, `goal-qa`, and custom subagents.
2. **The tool.** The `goal` tool checks `session.parentID` before any write and
   refuses:

   > Goals belong to the root session. Complete the delegated task; the parent
   > owns the contract and verification.

   This covers an `all`-mode agent used as a subagent, whose permission is not
   `mode: "subagent"`.
3. **The task context.** For a non-hidden subagent, `task` prepends the root
   goal and contract — including the verification — to the child's prompt. It
   states that the root owns the goal, that the child must not call the goal
   tool, and that it must not ask for authorization. Hidden roles (`goal-qa`,
   `goal-judge`) are skipped: their prompt is their diet.

The root's own authorization question remains: one question per run, at the
point the human agrees to the contract. It is the product's boundary, not
overhead to remove.

## Consequences

- **One human authorization per run**, not one per worker. The 1h48m wait in
  `pos2` disappears.
- **No child goal loops**, so no child QA at depth 1. The nine `subagent_depth`
  failures disappear without raising the depth limit.
- **The root's QA and judge review the aggregate** — the child's work is in the
  root's diff, bound to the root's state. A subagent no longer has a separate
  audit surface.
- **A subagent that needs its own contract and review is a separate root
  session** (a fork), not a `task` child. That is the correct tool for an
  independent piece of work.
- **The child receives the root's context.** `task` prepends the root goal and
  contract, including the verification, to a non-hidden subagent's prompt. A
  child knows what it is working under and does not ask for a verification it
  already has. The goal denial is the enforcement; the injection is the stance.

## Out of scope

- A timeout or parked state for the **root's** authorization question
  (`LOOP-ANALYSIS.md` L7). The root question stays; its UX is separate.
- Routing a subagent's `question` to the parent. `general` and `explore` already
  deny `question` by default; a custom subagent that allows it is a later
  decision.
- A parent-level "authorize all child goals" control. It is moot when children
  cannot have goals.
- Migrating goal rows created by child sessions in earlier runs. They are
  historical; the root's rows are the ones the loop reads.
