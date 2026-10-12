import { Effect, Schema } from "effect"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import * as Tool from "./tool"
import { Goal } from "../session/goal"
import { Question } from "../question"
import { Session } from "../session/session"
import { Scratchpad } from "../session/scratchpad"
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

export const GoalTool = Tool.define<typeof Parameters, {}, Goal.Service | Question.Service | Session.Service>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const question = yield* Question.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
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

          yield* goal.set({
            sessionID: ctx.sessionID,
            goal: params.goal,
            size: params.size,
            sizeReason: params.size_reason,
            contract: params.contract,
            gates: [
              {
                command: verification,
                timeout_seconds: GATE_TIMEOUT_SECONDS,
                max_retries: GATE_MAX_RETRIES,
                attempts: 0,
                last_exit_code: null,
                last_output_tail: "",
              },
            ],
          })

          // The scratchpad is what the judge and the human read.
          const instance = yield* InstanceState.context
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const file = Session.scratchpad(session, instance)
          let content = yield* Effect.promise(() => Scratchpad.read(file))
          content = Scratchpad.upsertSection(content, "Goal", params.goal)
          content = Scratchpad.upsertSection(content, "Size", `${params.size} — ${params.size_reason}`)
          content = Scratchpad.upsertSection(content, "Contract", renderContract(params.contract))
          yield* Effect.promise(() => Scratchpad.write(file, content))

          if (!params.commit) {
            return {
              title: "Goal set",
              output: `The goal is set but not authorized, so the loop will not run. Ask the human for permission to run unattended, then call this tool again with commit: true.\n\n${renderContract(params.contract)}`,
              metadata: {},
            }
          }

          // The commit gate: ask, and authorize only on a yes.
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Run this goal unattended?\n\n${renderContract(params.contract)}`,
                header: "Run unattended?",
                custom: false,
                options: [
                  {
                    label: "Yes, run it",
                    description: "Authorize the loop to run until the judge says the goal is met or the budget is spent",
                  },
                  {
                    label: "No, not yet",
                    description: "Leave the goal set but unauthorized",
                  },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] !== "Yes, run it") {
            return {
              title: "Not authorized",
              output:
                "The human did not authorize an unattended run. The goal stays set and the loop will not run. Ask what to change, or wait for a direct instruction.",
              metadata: {},
            }
          }

          yield* goal.authorize(ctx.sessionID)
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
