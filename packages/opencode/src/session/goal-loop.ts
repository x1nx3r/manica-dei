import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { GoalJudge as Judge } from "@opencode-ai/core/session/goal/judge"
import { GoalPhase } from "@opencode-ai/core/session/goal/phase"
import { GoalQa as Qa } from "@opencode-ai/core/session/goal/qa"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionGoal } from "@opencode-ai/schema/session-goal"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import { GoalGate } from "./goal-gate"
import { Goal } from "./goal"
import { GoalJudge } from "./goal-judge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionGoalEvent } from "@opencode-ai/schema/session-goal-event"
import type { SessionID } from "./schema"

// Fork ADR-0006, M4 + the QA loop: the loop's decision. Everything here is one
// question — given the goal, the gates, QA's record, and the judge, does the
// loop stop or go on? — and the answer is a value the caller acts on.
//
// The order is the point and is the chain of signatures: gates run first, then
// QA decides whether the judge is reached at all, and only an admissible,
// current QA pass admits the judge. The pass itself runs at the call site,
// which has the subagent plumbing the `task` tool borrows; the loop decides
// *that* it is due and reads the record the call site persists.

export type Decision =
  | { readonly _tag: "stop"; readonly note?: string }
  | { readonly _tag: "continue"; readonly prompt: string }
  | {
      readonly _tag: "qa"
      readonly contract?: SessionGoal.Contract
      readonly state: string
      readonly evidence: ReadonlyArray<Judge.GateEvidence>
    }
  | { readonly _tag: "blocked"; readonly reason: string; readonly note: string }
  | { readonly _tag: "wait"; readonly reason: string; readonly wait: Judge.WaitDirective; readonly note: string }

/** Consecutive judge failures of one kind that stop the loop. */
export const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Consecutive failures, by role. `parse` and `transport` are the judge's; `qa`
 * counts QA passes that could not run. A run of any one stops the loop, so a
 * misconfigured role cannot burn the budget (ADR-0006, "the loop has a floor").
 */
export interface FailureCounts {
  readonly parse: number
  readonly transport: number
  readonly qa: number
}

/** The note a run of QA failures leaves: it names the configuration to check. */
export const QA_FAILURE_NOTE =
  "The QA pass could not run; check the `goal-qa` agent's model and configuration. The goal stops rather than loop blind."

export interface DecideInput {
  readonly sessionID: SessionID
  /** The session's workspace: where a gate runs. */
  readonly cwd: string
  readonly user: SessionV1.User
  readonly providerID: ProviderV2.ID
  readonly modelID: ModelV2.ID
  /** The assumption ledger, when the scratchpad has one. */
  readonly assumptions?: string
  /**
   * The snapshot hash of the message the round is decided against: the
   * workspace state a record must bind to (ADR-0006, "state binding"). Read
   * from the message's own recorded snapshot, not tracked again here. A round
   * with no state cannot be reviewed, so the loop stops rather than pass it.
   */
  readonly state?: string
  /**
   * The gate evidence captured when the round first decided. It travels with
   * the `qa` decision to the call site and comes back here, so the gates run
   * once per round and the judge still reads the loop's own capture.
   */
  readonly evidence?: ReadonlyArray<Judge.GateEvidence>
  /**
   * The last QA pass errored or produced nothing readable. The loop fails open
   * to `dev` and counts the failure; after `MAX_CONSECUTIVE_FAILURES` it stops.
   */
  readonly qaFailure?: boolean
  /** Consecutive judge and QA failures before this call, by kind. */
  readonly failures: FailureCounts
}

export interface DecideResult {
  readonly decision: Decision
  /** Consecutive failures after this call. */
  readonly failures: FailureCounts
}

export interface Interface {
  readonly decide: (input: DecideInput) => Effect.Effect<DecideResult>
  /**
   * Persists QA's record and hands the round to the judge. The pass runs at the
   * call site; the loop owns the round, so it owns the record and the phase
   * move that makes the round the one the judge concluded.
   */
  readonly submitRecord: (input: { sessionID: SessionID; record: SessionGoal.Record }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalLoop") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service
    const gates = yield* GoalGate.Service
    const judge = yield* GoalJudge.Service
    const events = yield* EventV2Bridge.Service

    // Fork ADR-0008: a phase change and its event are one act. The event
    // carries the goal's standing status and the round in progress
    // (`turns_used + 1`), so the phase is readable from the trail alone. The
    // publish goes through the bridge, which attaches the instance location the
    // `/event` handler filters on.
    const publishPhase = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const goal = yield* goals.get(sessionID)
        if (!goal) return
        yield* events.publish(SessionGoalEvent.Event.Phase, {
          sessionID,
          phase: goal.phase,
          status: goal.status,
          round: goal.turns_used + 1,
        })
      })

    const setPhase = Effect.fn("GoalLoop.setPhase")(function* (input: {
      sessionID: SessionID
      phase: SessionGoal.Phase
    }) {
      yield* goals.setPhase(input)
      yield* publishPhase(input.sessionID)
    })

    const decide = Effect.fn("GoalLoop.decide")(function* (input: DecideInput) {
      const round = input.state
      const goal = yield* goals.get(input.sessionID)
      if (!goal || !goal.authorized || goal.status !== "active") {
        return { decision: { _tag: "stop" }, failures: input.failures } satisfies DecideResult
      }
      // The phase the round entered with, before this decision moves it. Only a
      // round that came through `judge` may conclude — `submitRecord` moves the
      // phase there when the QA pass hands off (ADR-0006, GoalPhase.mayConclude).
      const enteredPhase = goal.phase
      const unchanged = (decision: Decision): DecideResult => ({ decision, failures: input.failures })
      // A QA pass succeeded when it produced a record: the QA failure streak ends.
      const delivered = (decision: Decision): DecideResult => ({ decision, failures: { ...input.failures, qa: 0 } })

      // The budget is the floor. When it is spent the loop stops and hands back.
      if (goal.turns_used >= goal.turn_budget) {
        return unchanged({ _tag: "stop", note: "The turn budget is spent; the goal stops here." })
      }

      // QA failed to run. Fail open to `dev` so a broken QA does not end a run
      // that was still working — but count the failures, and stop naming the QA
      // configuration once they are consecutive (ADR-0006, "the loop has a floor").
      if (input.qaFailure) {
        const failures: FailureCounts = { ...input.failures, qa: input.failures.qa + 1 }
        // A partial pass (the record written, the handoff not) must not be
        // weighed later; the round goes back to `dev` clean. The round spent a
        // turn even though no judge closed it, like every other non-judge exit.
        yield* goals.clearRecord(input.sessionID)
        yield* setPhase({ sessionID: input.sessionID, phase: "dev" })
        yield* goals.burnTurn(input.sessionID)
        const decision: Decision =
          failures.qa >= MAX_CONSECUTIVE_FAILURES
            ? { _tag: "stop", note: QA_FAILURE_NOTE }
            : { _tag: "continue", prompt: Qa.errorContinuation(goal.goal) }
        return { decision, failures }
      }

      // The round must bind to a workspace state. Without one the record's
      // staleness cannot be checked, so it could never be admitted; stop rather
      // than pass a change no one can bind to.
      if (!round) {
        return unchanged({
          _tag: "stop",
          note: "The round has no workspace state to bind a review to; the goal stops rather than pass unaudited.",
        })
      }

      const raw = goal.qa_record
      if (raw) {
        // Attribute the probes before weighing. The gates and the contract's
        // verification are the author's own commands; a probe that runs one of
        // them is the author's check, whatever QA marked it. Without this a
        // relabelled author check would satisfy the holdout rule (draft §4).
        const record = Qa.attributeProbes(raw, [
          goal.contract?.verification ?? "",
          ...goal.gates.map((gate) => gate.command),
        ])
        // QA already ran this round. A record the work outran is stale, and a
        // verdict may not survive the edit that invalidates it (ADR-0006,
        // "state binding").
        const bound = goal.state_hash
        if (record.state !== round || (bound !== null && record.state !== bound)) {
          yield* goals.clearRecord(input.sessionID)
          yield* setPhase({ sessionID: input.sessionID, phase: "dev" })
          // The round is spent even though no judge closed it.
          yield* goals.burnTurn(input.sessionID)
          return delivered({ _tag: "continue", prompt: Qa.staleContinuation(goal.goal) })
        }

        // A contradiction is not signed off here: QA produced the record, so the
        // judge weighs it like any other — that is the link the chain was
        // missing, and it is how a manufactured finding is caught rather than
        // charged to the dev (ADR-0006, "nobody signs what they made").
        //
        // A *clean* record with no derived probe is an abstention, never a pass:
        // the author's own checks are exactly what the derived probe stands
        // apart from. A contradiction is not held to that — its findings are the
        // substance, and the judge decides whether they hold.
        const contradicted = record.verdict === "contradicted"
        if (!contradicted && !record.probes.some((probe) => probe.derived)) {
          yield* goals.clearRecord(input.sessionID)
          yield* setPhase({ sessionID: input.sessionID, phase: "dev" })
          // The round is spent even though no judge closed it.
          yield* goals.burnTurn(input.sessionID)
          return delivered({ _tag: "continue", prompt: Qa.abstentionContinuation(goal.goal) })
        }

        // An admissible record. The judge weighs it against the evidence the
        // round captured, and consuming the record keeps it from being weighed
        // twice.
        const evidence = input.evidence ?? []
        yield* goals.clearRecord(input.sessionID)

        const result = yield* judge.judge({
          sessionID: input.sessionID,
          user: input.user,
          providerID: input.providerID,
          modelID: input.modelID,
          goal: goal.goal,
          // The round the judge weighs: the pre-record `turns_used + 1`, the same
          // round the verdict event and the `goal.verdict` part carry.
          round: goal.turns_used + 1,
          contract: goal.contract,
          assumptions: input.assumptions,
          record,
          evidence,
        })

        // The circuit breaker: consecutive failures stop the loop, so a
        // misconfigured judge cannot burn the budget. A success resets all.
        const failures: FailureCounts = result.failure
          ? {
              parse: input.failures.parse + (result.failure === "parse" ? 1 : 0),
              transport: input.failures.transport + (result.failure === "transport" ? 1 : 0),
              qa: 0,
            }
          : { parse: 0, transport: 0, qa: 0 }
        const settled = (decision: Decision): DecideResult => ({ decision, failures })
        if (failures.parse >= MAX_CONSECUTIVE_FAILURES || failures.transport >= MAX_CONSECUTIVE_FAILURES) {
          return settled({ _tag: "stop", note: "The judge is unreachable; the goal stops rather than loops blind." })
        }

        const judgement = result.judgement

        // What the dev is told. A contradicted round is relayed through the
        // judge's three-part handoff; when the judge could not supply one — it
        // failed open, or the reply was partial — the record's own relay carries
        // the findings, so a broken judge never swallows QA's work (draft §2).
        const relay = (): string =>
          !contradicted
            ? continuation(goal.goal, judgement.reason)
            : judgement.handoff
              ? Qa.handoffContinuation(goal.goal, judgement.handoff)
              : Qa.relayContinuation(goal.goal, record)

        // Only the judge may conclude a run, and a contradiction is never a
        // completion: no clean pass was admitted, so `done` is refused whatever
        // the judge says. The other refusal is a torn handoff — `submitRecord`
        // writes the record and moves the phase to `judge` together, so a round
        // that never reached `judge` may not conclude either
        // (ADR-0006, GoalPhase.mayConclude).
        if (judgement.verdict === "done" && (contradicted || !GoalPhase.mayConclude(enteredPhase))) {
          yield* setPhase({ sessionID: input.sessionID, phase: "dev" })
          return settled({
            _tag: "continue",
            prompt: contradicted
              ? relay()
              : continuation(goal.goal, "no QA pass admitted this round, so the outcome cannot be concluded"),
          })
        }

        yield* goals.record({
          sessionID: input.sessionID,
          verdict: judgement.verdict,
          reason: judgement.reason,
          state: input.state,
        })
        // The verdict carries the substance (ADR-0008): the ruling, why, and the
        // three-part relay when the judge supplied one. `round` is the round the
        // judge weighed — the pre-record `turns_used + 1`.
        yield* events.publish(SessionGoalEvent.Event.Verdict, {
          sessionID: input.sessionID,
          // The judge's own session, so a client can link the ruling to the
          // transcript it came from (ADR-0008, "the seam").
          ...(result.roleSessionID ? { roleSessionID: result.roleSessionID } : {}),
          round: goal.turns_used + 1,
          verdict: judgement.verdict,
          reason: judgement.reason,
          ...(judgement.handoff ? { handoff: judgement.handoff } : {}),
        })

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
            yield* setPhase({ sessionID: input.sessionID, phase: GoalPhase.after("wait") ?? "dev" })
            return settled({
              _tag: "wait",
              reason: judgement.reason,
              wait: judgement.wait ?? { seconds: 60 },
              note: `The judge says to wait: ${judgement.reason}`,
            })
          case "continue":
            yield* setPhase({ sessionID: input.sessionID, phase: GoalPhase.after("continue") ?? "dev" })
            return settled({ _tag: "continue", prompt: relay() })
        }
      }

      // No record yet: the round begins here. Gates run once, before the QA
      // pass, and their output travels with the `qa` decision to the call site,
      // which hands it back on the resolve call. So the gates never run twice,
      // and the judge still reads the loop's own capture of the check
      // (ADR-0006, "prefer a fact over a rule").
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

      // The round is bound and QA is due. The call site runs the pass, persists
      // the record, and comes back with it (ADR-0006, "the chain of signatures":
      // nobody signs what they made — the dev cannot sign off on the dev).
      yield* goals.bindState({ sessionID: input.sessionID, state: round })
      yield* setPhase({ sessionID: input.sessionID, phase: "qa" })
      return unchanged({ _tag: "qa", contract: goal.contract, state: round, evidence })
    })

    const submitRecord = Effect.fn("GoalLoop.submitRecord")(function* (input: {
      sessionID: SessionID
      record: SessionGoal.Record
    }) {
      // QA's pass hands the round to the judge: persist the record and move the
      // phase, so the round that concludes is the one that passed through
      // `judge` (ADR-0006, GoalPhase.mayConclude).
      yield* goals.setRecord(input)
      yield* goals.setPhase({ sessionID: input.sessionID, phase: "judge" })
      const goal = yield* goals.get(input.sessionID)
      if (!goal) return
      // The record is the substance (ADR-0008): it is what a consumer of the
      // trail reads without a second call, and it is what the human reads at
      // handoff. Publish it, then the phase move it caused.
      yield* events.publish(SessionGoalEvent.Event.Review, {
        sessionID: input.sessionID,
        round: goal.turns_used + 1,
        record: input.record,
      })
      yield* events.publish(SessionGoalEvent.Event.Phase, {
        sessionID: input.sessionID,
        phase: goal.phase,
        status: goal.status,
        round: goal.turns_used + 1,
      })
    })

    return Service.of({ decide, submitRecord })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Goal.node, GoalGate.node, GoalJudge.node, EventV2Bridge.node],
})

/** The continuation a `continue` verdict produces. */
export function continuation(goal: string, reason: string): string {
  return [
    "[Continuing toward your standing goal]",
    `Goal: ${goal}`,
    "",
    reason.length > 0 ? `The judge says the goal is not met yet: ${reason}` : "The judge says the goal is not met yet.",
    "",
    "Take the next concrete step. When you believe the goal is met, run the verification and leave the change in the workspace — the run is judged against the contract and the artifact, not your word. If you are blocked and need input, say so clearly and stop.",
  ].join("\n")
}

export * as GoalLoop from "./goal-loop"
