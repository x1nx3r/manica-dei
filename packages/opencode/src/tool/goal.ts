import { Effect, Schema } from "effect"
import { GoalVerification } from "./goal-verification"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import * as Tool from "./tool"
import { Goal } from "../session/goal"
import { Question } from "../question"
import { Session } from "../session/session"
import { Scratchpad } from "../session/scratchpad"
import { Snapshot } from "@/snapshot"
import { InstanceState } from "../effect/instance-state"
import DESCRIPTION from "./goal.txt"

// Fork ADR-0006, M5: the `goal` tool — the agent's kickoff. It writes the
// durable goal (M1), turns the contract's `verification` into the gate the loop
// runs (M4), writes the scratchpad the judge and the human read (M2), and, when
// asked to commit, puts the human's authorization on the record.
//
// Until this tool is called there is no goal, and the session behaves exactly as
// it always has.

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({ description: "The goal as you now understand it, in your own words" }),
  size: SessionGoal.Size.annotate({
    description: "How big the task is: the number and blast radius of the decisions it leaves undetermined",
  }),
  size_reason: Schema.String.annotate({ description: "One line: why this size" }),
  contract: SessionGoal.Contract,
  commit: Schema.optional(Schema.Boolean).annotate({
    description: "Ask the human for permission to run unattended now, and authorize only on a yes",
  }),
})

/** The gate the contract's verification becomes. */
const GATE_TIMEOUT_SECONDS = 300
const GATE_MAX_RETRIES = 3

export const GoalTool = Tool.define<
  typeof Parameters,
  {},
  Goal.Service | Question.Service | Session.Service | Snapshot.Service
>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const question = yield* Question.Service
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // ADR-0011: the goal is the root session's authorization boundary.
          // A subagent executes a delegated task under the root's contract; it
          // does not create another goal, another contract, or another human
          // authorization question (issue #38's run: three child goals asked
          // for authorization and stalled the root for 1h48m).
          const owner = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (owner.parentID) {
            return yield* Effect.fail(
              new Error(
                "Goals belong to the root session. Complete the delegated task; the parent owns the contract and verification.",
              ),
            )
          }

          // A huge goal is not one task. Do not set it; propose a split.
          if (params.size === "huge") {
            return {
              title: "This is more than one task",
              output:
                "This goal is too large to run as one task. Propose a decomposition — split it into smaller goals — and set the first one. Do not start work on it as it stands.",
              metadata: {},
            }
          }

          const verification = params.contract.verification.trim()
          if (verification.length === 0) {
            return {
              title: "A contract needs a verification command",
              output:
                "The completion contract has no verification command, and a goal whose verification cannot be expressed as a command was not scoped tightly enough. Ask the human which check proves the outcome, then set the goal again.",
              metadata: {},
            }
          }

          const prose = GoalVerification.proseReason(verification)
          if (prose) {
            return {
              ...GoalVerification.refuse(verification),
              metadata: {},
            }
          }

          const gates = [
            {
              command: verification,
              timeout_seconds: GATE_TIMEOUT_SECONDS,
              max_retries: GATE_MAX_RETRIES,
              attempts: 0,
              last_exit_code: null,
              last_output_tail: "",
            },
          ]

          const existing = yield* goal.get(ctx.sessionID)
          const definition = { goal: params.goal, contract: params.contract, gates }
          const replaceNeeded =
            existing?.authorized === true &&
            (!Goal.sameGoalDefinition(existing, definition) || existing.status !== "active")

          let replace = false
          if (replaceNeeded) {
            const answers = yield* question.ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: renderReplaceQuestion(existing, params.goal),
                  header: "Replace the current goal?",
                  custom: false,
                  options: [
                    {
                      label: "Yes, replace it",
                      description:
                        "Reset the current run, set this goal, and ask for a fresh authorization before the loop runs",
                    },
                    {
                      label: "No, keep the current goal",
                      description: "Leave the current goal and its run state unchanged",
                    },
                  ],
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            if (answers[0]?.[0] !== "Yes, replace it") {
              return {
                title: "Current goal kept",
                output:
                  "The human did not replace the current goal. Do not set this goal. Ask what to change, or continue the current goal.",
                metadata: {},
              }
            }
            replace = true
          }

          const startState = yield* snapshot.track()
          const result = yield* goal.set({
            sessionID: ctx.sessionID,
            goal: params.goal,
            size: params.size,
            sizeReason: params.size_reason,
            contract: params.contract,
            gates,
            startState,
            replace,
          })
          if (result._tag === "replace-required") {
            return {
              title: "The goal changed",
              output:
                "The current goal changed while the replacement question was open. Ask the human again before you set this goal.",
              metadata: {},
            }
          }
          const current = result.info

          // The scratchpad is what the judge and the human read.
          const instance = yield* InstanceState.context
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const file = Session.scratchpad(session, instance)
          let content = yield* Effect.promise(() => Scratchpad.read(file))
          content = Scratchpad.upsertSection(content, "Goal", params.goal)
          content = Scratchpad.upsertSection(content, "Size", `${params.size} — ${params.size_reason}`)
          content = Scratchpad.upsertSection(content, "Contract", renderContract(params.contract))
          yield* Effect.promise(() => Scratchpad.write(file, content))

          if (current.authorized) {
            return {
              title: "Goal already authorized",
              output:
                "This goal is already authorized, so its run state is unchanged. Continue the current run, or replace the goal to start a new one.",
              metadata: {},
            }
          }

          if (!params.commit) {
            return {
              title: "Goal set",
              output: `${replace ? "The previous goal was replaced and its run state was reset. " : ""}The goal is set but not authorized, so the loop will not run. Ask the human to confirm what done means — the outcome and the check that proves it — and to authorize an unattended run, then call this tool again with commit: true.\n\n${renderContract(params.contract)}`,
              metadata: {},
            }
          }

          // The commit gate: ask, and authorize only on a yes.
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: renderCommitQuestion(params.contract),
                header: "Confirm what done means?",
                custom: false,
                options: [
                  {
                    label: "Yes, that's what I want",
                    description:
                      "Ratify the outcome and the check that proves it, and authorize the loop to run until the judge says it is met or the budget is spent",
                  },
                  {
                    label: "No, let's adjust it",
                    description: "Leave the goal set but unauthorized, and change the outcome or the check first",
                  },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] !== "Yes, that's what I want") {
            return {
              title: "Not authorized",
              output:
                "The human did not confirm the contract, so the goal stays set and the loop will not run. Ask what to change about the outcome or the check that proves it, set the goal again, and ask again.",
              metadata: {},
            }
          }

          yield* goal.authorize(ctx.sessionID, current.generation)
          return {
            title: "Goal authorized",
            output:
              "The goal is authorized. The loop will continue until the judge says the goal is met, the budget is spent, or a gate cannot pass.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function renderContract(contract: SessionGoal.Contract): string {
  return [
    `Outcome: ${contract.outcome}`,
    `Verification: ${contract.verification}`,
    `Constraints: ${contract.constraints}`,
    `Boundaries: ${contract.boundaries}`,
    `Stop when: ${contract.stop_when}`,
  ].join("\n")
}

function renderReplaceQuestion(info: Goal.Info, goal: string): string {
  return [
    "This session already has an authorized goal.",
    "",
    `Current goal: ${info.goal}`,
    `Phase: ${info.phase}. Turn ${info.turns_used} of ${info.turn_budget}. Last verdict: ${info.last_verdict ?? "none"}.`,
    "",
    "The new goal is:",
    goal,
    "",
    "If you replace it, the current run state resets. The turn counter starts at zero, the old verdict and role rounds leave the run, and the new contract needs a new authorization.",
  ].join("\n")
}

/**
 * The commit question. It is not only "may I run?" — it is the human's one
 * chance to agree what *done* means and how it will be checked, before the loop
 * trusts a contract the agent wrote (ADR-0006, "The human ratifies the contract
 * at commit").
 *
 * It is short on purpose. The outcome and the check are in the question, because
 * "I will check it with … run before I call it done" is what makes a check that
 * does not exercise the outcome look wrong here, where a person can still say
 * so. The rest of the contract is not restated in the question: it is on the
 * goal row, and the client's goal panels renders it right above the composer —
 * so the question asks about the two things it ratifies, and the panel is where
 * the human reads the whole of what they are ratifying.
 */
function renderCommitQuestion(contract: SessionGoal.Contract): string {
  return [
    "Confirm what done means, and let the loop run unattended.",
    "",
    `Done means: ${contract.outcome}`,
    `I will check it with: ${contract.verification} — run before I call it done`,
    "",
    "The full contract — must not change, in scope, stop when — is on the goal; the goal panel above the composer renders it.",
  ].join("\n")
}
