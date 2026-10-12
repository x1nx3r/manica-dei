import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { GoalJudge as Judge } from "@opencode-ai/core/session/goal/judge"
import { GoalPhase } from "@opencode-ai/core/session/goal/phase"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import { GoalGate } from "./goal-gate"
import { Goal } from "./goal"
import { GoalJudge } from "./goal-judge"
import type { SessionID } from "./schema"

// Fork ADR-0006, M4: the loop's decision. Everything here is one question —
// given the goal, the gates, and the judge, does the loop stop or go on? — and
// the answer is a value the caller acts on.
//
// The order is the point: gates run before the judge, so a failing gate is
// deterministic evidence that short-circuits judging entirely.

export type Decision =
  | { readonly _tag: "stop"; readonly note?: string }
  | { readonly _tag: "continue"; readonly prompt: string }
  | { readonly _tag: "blocked"; readonly reason: string; readonly note: string }
  | { readonly _tag: "wait"; readonly reason: string; readonly wait: Judge.WaitDirective; readonly note: string }

/** Consecutive judge failures of one kind that stop the loop. */
export const MAX_CONSECUTIVE_FAILURES = 3

export interface DecideInput {
  readonly sessionID: SessionID
  /** The session's workspace: where a gate runs. */
  readonly cwd: string
  readonly user: SessionV1.User
  readonly providerID: ProviderV2.ID
  readonly modelID: ModelV2.ID
  readonly lastResponse: string
  /** The assumption ledger, when the scratchpad has one. */
  readonly assumptions?: string
  /**
   * The snapshot hash of the message the judge reads: the workspace state a
   * verdict will bind to (ADR-0006, "state binding"). Read from the message's
   * own recorded snapshot, not tracked again here.
   */
  readonly state?: string
  /** Consecutive judge failures before this call, by kind. */
  readonly failures: { readonly parse: number; readonly transport: number }
}

export interface DecideResult {
  readonly decision: Decision
  /** Consecutive judge failures after this call. */
  readonly failures: { readonly parse: number; readonly transport: number }
}

export interface Interface {
  readonly decide: (input: DecideInput) => Effect.Effect<DecideResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalLoop") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service
    const gates = yield* GoalGate.Service
    const judge = yield* GoalJudge.Service

    const decide = Effect.fn("GoalLoop.decide")(function* (input: DecideInput) {
      const unchanged = (decision: Decision): DecideResult => ({ decision, failures: input.failures })

      const goal = yield* goals.get(input.sessionID)
      if (!goal || !goal.authorized || goal.status !== "active") return unchanged({ _tag: "stop" })

      // The budget is the floor. When it is spent the loop stops and hands back.
      if (goal.turns_used >= goal.turn_budget) {
        return unchanged({ _tag: "stop", note: "The turn budget is spent; the goal stops here." })
      }

      // Gates run before the judge. Their output is captured here and handed to
      // the judge as a fact: the judge is a text-only reader, and the agent's
      // summary of a check is not the check (ADR-0006, "prefer a fact over a
      // rule"). The gates run in this same decision, so the evidence is fresh
      // by construction.
      const evidence: Judge.GateEvidence[] = []
      if (goal.gates.length > 0) {
        const next = goal.gates.map((gate) => ({ ...gate }))
        for (let index = 0; index < next.length; index++) {
          const gate = next[index]
          const outcome = yield* gates.run(gate, input.cwd)
          if (outcome.passed) {
            evidence.push({ command: gate.command, exitCode: 0, output: outcome.output })
            next[index] = { ...gate, attempts: 0, last_exit_code: 0, last_output_tail: "" }
            continue
          }
          const attempts = gate.attempts + 1
          next[index] = { ...gate, attempts, last_exit_code: outcome.exitCode, last_output_tail: outcome.output }
          yield* goals.setGates({ sessionID: input.sessionID, gates: next })
          if (attempts > gate.max_retries) {
            return unchanged({
              _tag: "blocked",
              reason: `quality gate exhausted ${gate.max_retries} retries: $ ${gate.command}`,
              note: `A quality gate cannot pass after ${gate.max_retries} retries: \`${gate.command}\`.`,
            })
          }
          return unchanged({
            _tag: "continue",
            prompt: GoalGate.continuation({
              goal: goal.goal,
              command: gate.command,
              exitCode: outcome.exitCode,
              output: outcome.output,
              attempt: attempts,
              maxRetries: gate.max_retries,
            }),
          })
        }
        yield* goals.setGates({ sessionID: input.sessionID, gates: next })
      }

      // Every gate passed, so the judge rules next. The loop enters `judge`
      // before the call: the phase names the role acting, and only the judge's
      // phase may conclude a run (ADR-0006).
      yield* goals.setPhase({ sessionID: input.sessionID, phase: "judge" })

      const result = yield* judge.judge({
        sessionID: input.sessionID,
        user: input.user,
        providerID: input.providerID,
        modelID: input.modelID,
        goal: goal.goal,
        contract: goal.contract,
        assumptions: input.assumptions,
        lastResponse: input.lastResponse,
        evidence,
      })

      // The circuit breaker: consecutive failures stop the loop, so a
      // misconfigured judge cannot burn the budget. A success resets both.
      const failures = result.failure
        ? {
            parse: input.failures.parse + (result.failure === "parse" ? 1 : 0),
            transport: input.failures.transport + (result.failure === "transport" ? 1 : 0),
          }
        : { parse: 0, transport: 0 }
      const settled = (decision: Decision): DecideResult => ({ decision, failures })
      if (failures.parse >= MAX_CONSECUTIVE_FAILURES || failures.transport >= MAX_CONSECUTIVE_FAILURES) {
        return settled({ _tag: "stop", note: "The judge is unreachable; the goal stops rather than loops blind." })
      }

      const judgement = result.judgement
      yield* goals.record({
        sessionID: input.sessionID,
        verdict: judgement.verdict,
        reason: judgement.reason,
        state: input.state,
      })

      // Fork ADR-0006: only the judge may conclude a run, and the loop entered
      // `judge` immediately before this call — so `done` is honoured here by
      // construction. The transition order is the rule until QA runs in its own
      // phase between the work and this point; `GoalPhase.mayConclude` is the
      // declared rule and is wired in here at that step.
      switch (judgement.verdict) {
        case "done":
          yield* goals.setStatus({ sessionID: input.sessionID, status: "done" })
          return settled({ _tag: "stop", note: `The judge says the goal is met: ${judgement.reason}` })
        case "blocked":
          yield* goals.setStatus({ sessionID: input.sessionID, status: "blocked" })
          return settled({
            _tag: "blocked",
            reason: judgement.reason,
            note: `The judge says the run is blocked: ${judgement.reason}`,
          })
        case "wait":
          yield* goals.setPhase({ sessionID: input.sessionID, phase: GoalPhase.after("wait") ?? "dev" })
          return settled({
            _tag: "wait",
            reason: judgement.reason,
            wait: judgement.wait ?? { seconds: 60 },
            note: `The judge says to wait: ${judgement.reason}`,
          })
        case "continue":
          yield* goals.setPhase({ sessionID: input.sessionID, phase: GoalPhase.after("continue") ?? "dev" })
          return settled({ _tag: "continue", prompt: continuation(goal.goal, judgement.reason) })
      }
    })

    return Service.of({ decide })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Goal.node, GoalGate.node, GoalJudge.node] })

/** The continuation a `continue` verdict produces. */
export function continuation(goal: string, reason: string): string {
  return [
    "[Continuing toward your standing goal]",
    `Goal: ${goal}`,
    "",
    reason.length > 0 ? `The judge says the goal is not met yet: ${reason}` : "The judge says the goal is not met yet.",
    "",
    "Take the next concrete step. When you believe the goal is met, show the evidence the verification produced in your reply — the run is judged against the contract, not your word. If you are blocked and need input, say so clearly and stop.",
  ].join("\n")
}

export * as GoalLoop from "./goal-loop"
