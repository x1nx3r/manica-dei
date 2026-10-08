export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { optional } from "./schema"

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

/** The loop's lifecycle for one goal. */
export const Status = Schema.Literals(["active", "done", "blocked"]).annotate({
  identifier: "SessionGoal.Status",
})
export type Status = typeof Status.Type

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

export const Info = Schema.Struct({
  goal: Schema.String.annotate({ description: "The goal as the agent restated it at commit" }),
  size: Size.pipe(optional),
  size_reason: Schema.String.pipe(optional),
  contract: Contract.pipe(optional),
  gates: Schema.Array(Gate),
  authorized: Schema.Boolean.annotate({ description: "The commit gate: false until a human authorizes" }),
  turn_budget: Schema.Number,
  turns_used: Schema.Number,
  last_verdict: Verdict.pipe(optional),
  status: Status,
}).annotate({ identifier: "SessionGoal.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
