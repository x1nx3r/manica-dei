export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { optional } from "./schema"
import { SessionID } from "./session-id"

/**
 * The durable goal of a session (fork ADR-0006).
 *
 * One goal per session. `authorized` is the commit gate: a goal that is set
 * but not authorized never runs the loop. `contract` and `gates` are the
 * terminating condition — the contract's `verification` is the command the
 * loop runs before the judge.
 */

/**
 * How big the task is: the number and blast radius of the decisions the task
 * leaves undetermined. Self-assessed at scope, recorded with a reason.
 */
export const Size = Schema.Literals(["small", "medium", "large", "huge"]).annotate({
  identifier: "SessionGoal.Size",
})
export type Size = typeof Size.Type

/** The judge's four verdicts. */
export const Verdict = Schema.Literals(["done", "blocked", "continue", "wait"]).annotate({
  identifier: "SessionGoal.Verdict",
})
export type Verdict = typeof Verdict.Type

/**
 * The three parts the judge fills from the record — all three, or none. The
 * loop renders the message (draft `f1-goal-loop-relay.md` §2); the judge supplies
 * only the parts, so a paraphrased command cannot creep back in.
 */
export const Handoff = Schema.Struct({
  tested: Schema.String.annotate({ description: "The probe's criterion and what it observed" }),
  implementation: Schema.String.annotate({ description: "What the artifact does, per QA's read — file:line" }),
  cause: Schema.String.annotate({ description: "The contradiction, or why the finding does not hold" }),
}).annotate({ identifier: "SessionGoal.Handoff" })
export interface Handoff extends Schema.Schema.Type<typeof Handoff> {}

/** The loop's lifecycle for one goal. */
export const Status = Schema.Literals(["active", "done", "blocked"]).annotate({
  identifier: "SessionGoal.Status",
})
export type Status = typeof Status.Type

/**
 * Which role is acting: `dev` works, `qa` is a QA pass pending, `judge` is the
 * judge ruling. Only the judge may conclude a run (ADR-0006).
 */
export const Phase = Schema.Literals(["dev", "qa", "judge"]).annotate({
  identifier: "SessionGoal.Phase",
})
export type Phase = typeof Phase.Type

/**
 * The completion contract: the five fields the agent writes at commit.
 * `verification` is the gate — the command that proves the outcome.
 */
export const Contract = Schema.Struct({
  outcome: Schema.String.annotate({ description: "The single end state that must be true when done" }),
  verification: Schema.String.annotate({ description: "The command that proves the outcome" }),
  constraints: Schema.String.annotate({ description: "What must not change or regress" }),
  boundaries: Schema.String.annotate({ description: "Files, directories, tools, systems in scope" }),
  stop_when: Schema.String.annotate({ description: "When to stop and ask instead of pushing on" }),
}).annotate({ identifier: "SessionGoal.Contract" })
export interface Contract extends Schema.Schema.Type<typeof Contract> {}

/** One executable gate: the contract's verification, run by the loop. */
export const Gate = Schema.Struct({
  command: Schema.String,
  timeout_seconds: Schema.Number,
  max_retries: Schema.Number,
  attempts: Schema.Number,
  last_exit_code: Schema.NullOr(Schema.Number),
  last_output_tail: Schema.String,
}).annotate({ identifier: "SessionGoal.Gate" })
export interface Gate extends Schema.Schema.Type<typeof Gate> {}

/**
 * One probe from a QA pass: an executed observation against the artifact.
 * `derived` marks QA's own probe — the holdout the author never saw — while
 * false marks the author's own check.
 */
export const Probe = Schema.Struct({
  criterion: Schema.String.annotate({ description: "Which clause of the contract this probes" }),
  derived: Schema.Boolean.annotate({ description: "true = QA's own probe (the holdout); false = the author's check" }),
  command: Schema.String.annotate({ description: "What was executed" }),
  output: Schema.String.annotate({ description: "The captured tail of the command's output" }),
  result: Schema.Literals(["pass", "fail", "could-not-run"]),
}).annotate({ identifier: "SessionGoal.Probe" })
export interface Probe extends Schema.Schema.Type<typeof Probe> {}

/** A contradiction between the contract and the artifact, with its evidence. */
export const Finding = Schema.Struct({
  criterion: Schema.String.annotate({ description: "The clause of the contract this contradicts" }),
  detail: Schema.String.annotate({ description: "The contradiction, in one or two sentences" }),
  evidence: Schema.String.annotate({ description: "file:line, or the command and its output" }),
}).annotate({ identifier: "SessionGoal.Finding" })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

/**
 * QA's pass: a record, not an absence. Per acceptance criterion, the probe and
 * its outcome. `state` binds the record to the workspace state it reviewed; a
 * record whose state does not match the round is stale and cannot be weighed
 * (ADR-0006, "state binding").
 */
export const Record = Schema.Struct({
  state: Schema.String.annotate({ description: "The snapshot hash reviewed — the record's binding" }),
  verdict: Schema.Literals(["clean", "contradicted"]),
  probes: Schema.Array(Probe),
  findings: Schema.Array(Finding),
}).annotate({ identifier: "SessionGoal.Record" })
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const Info = Schema.Struct({
  goal: Schema.String.annotate({ description: "The goal as the agent restated it at commit" }),
  size: Size.pipe(optional),
  size_reason: Schema.String.pipe(optional),
  contract: Contract.pipe(optional),
  gates: Schema.Array(Gate),
  authorized: Schema.Boolean.annotate({ description: "The commit gate: false until a human authorizes" }),
  phase: Phase,
  turn_budget: Schema.Number,
  turns_used: Schema.Number,
  last_verdict: Verdict.pipe(optional),
  last_reason: Schema.String.pipe(optional),
  /**
   * The judge session that produced `last_verdict` — the pointer a client that
   * arrives late needs to open the ruling it is reading (ADR-0008, "the seam").
   * Set whenever the judge ran as a session; absent before the first verdict.
   */
  last_verdict_session: SessionID.pipe(optional),
  /**
   * QA's record for the round it reviewed (ADR-0006, "the record"). Present
   * only between a QA pass and the loop weighing it; the judge reads it, and it
   * is what makes "no contradiction found" mean something. Absent before the
   * first pass and after it was weighed.
   */
  qa_record: Record.pipe(optional),
  /**
   * The workspace state the round binds to: the snapshot hash of the message
   * the round is decided against. The record's `state` must equal it, or the
   * record is stale (ADR-0006, "state binding").
   */
  state_hash: Schema.NullOr(Schema.String),
  status: Status,
}).annotate({ identifier: "SessionGoal.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
