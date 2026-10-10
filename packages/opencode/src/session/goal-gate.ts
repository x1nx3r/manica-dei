import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { exec } from "node:child_process"
import type { SessionGoal } from "@opencode-ai/schema/session-goal"

// Fork ADR-0006: quality gates. The contract's Verification is a command, and
// the loop runs it before the judge — a passing gate is the evidence, and a
// failing one short-circuits the judge with its own output as the continuation.
//
// A gate runs in the session's workspace, so a relative command checks the
// project the goal is about.

export interface Outcome {
  readonly passed: boolean
  readonly exitCode: number
  readonly output: string
}

/** The tail of a failed gate's output the agent repairs against. */
export const MAX_OUTPUT_CHARS = 3_000

const COULD_NOT_RUN: Outcome = { passed: false, exitCode: -1, output: "[gate could not run]" }

export interface Interface {
  readonly run: (gate: SessionGoal.Gate, cwd: string) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalGate") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    run: (gate, cwd) =>
      Effect.tryPromise({
        try: () =>
          new Promise<Outcome>((resolve) => {
            exec(
              gate.command,
              { cwd, timeout: gate.timeout_seconds * 1_000, maxBuffer: 8 * 1024 * 1024 },
              (error, stdout, stderr) => {
                const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`
                const exitCode = error ? (typeof error.code === "number" ? error.code : -1) : 0
                resolve({ passed: exitCode === 0, exitCode, output: combined.slice(-MAX_OUTPUT_CHARS) })
              },
            )
          }),
        catch: () => COULD_NOT_RUN,
      }).pipe(Effect.catchCause(() => Effect.succeed(COULD_NOT_RUN))),
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

/**
 * The continuation a failed gate produces. It carries the command, the exit
 * code, and the output tail, so the agent repairs against real output rather
 * than a description of it.
 */
export function continuation(input: {
  readonly goal: string
  readonly command: string
  readonly exitCode: number
  readonly output: string
  readonly attempt: number
  readonly maxRetries: number
}): string {
  return [
    "[Continuing toward your standing goal — a quality gate failed]",
    `Goal: ${input.goal}`,
    "",
    `The quality gate below must pass before this goal can be done, and it just failed (attempt ${input.attempt}/${input.maxRetries}):`,
    `  $ ${input.command}`,
    `Exit code: ${input.exitCode}`,
    "Output (tail):",
    "```",
    input.output.trim().length === 0 ? "(no output)" : input.output,
    "```",
    "",
    "Fix the underlying problem so the gate passes, then re-run it to confirm. Do not declare the goal done while a gate fails. If the gate itself is wrong or cannot pass, say so clearly and stop.",
  ].join("\n")
}

export * as GoalGate from "./goal-gate"
