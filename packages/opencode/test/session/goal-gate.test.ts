import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GoalGate } from "@/session/goal-gate"
import { testEffect } from "../lib/effect"

// Fork ADR-0006, M4: the gate runner. Real shell commands, so this is a live
// test — but small and fast.

const it = testEffect(LayerNode.compile(GoalGate.node))

const gate = (command: string, timeout_seconds = 30) => ({
  command,
  timeout_seconds,
  max_retries: 3,
  attempts: 0,
  last_exit_code: null,
  last_output_tail: "",
})

describe("session.goal-gate", () => {
  it.live("a passing command passes", () =>
    Effect.gen(function* () {
      const runner = yield* GoalGate.Service
      const outcome = yield* runner.run(gate("printf ok"), "/tmp")
      expect(outcome.passed).toBe(true)
      expect(outcome.exitCode).toBe(0)
      expect(outcome.output).toBe("ok")
    }),
  )

  it.live("a failing command fails and carries its output", () =>
    Effect.gen(function* () {
      const runner = yield* GoalGate.Service
      const outcome = yield* runner.run(gate("printf boom; exit 3"), "/tmp")
      expect(outcome.passed).toBe(false)
      expect(outcome.exitCode).toBe(3)
      expect(outcome.output).toContain("boom")
    }),
  )

  it.live("the output is bounded to its tail", () =>
    Effect.gen(function* () {
      const runner = yield* GoalGate.Service
      const outcome = yield* runner.run(gate("yes x | head -c 5000"), "/tmp")
      expect(outcome.output.length).toBeLessThanOrEqual(GoalGate.MAX_OUTPUT_CHARS)
    }),
  )

  it.live("a command that cannot run fails rather than throwing", () =>
    Effect.gen(function* () {
      const runner = yield* GoalGate.Service
      const outcome = yield* runner.run(gate("this-command-does-not-exist-xyz"), "/tmp")
      expect(outcome.passed).toBe(false)
      expect(outcome.exitCode).not.toBe(0)
    }),
  )

  test("the continuation carries the command, the exit code, the output, and the attempt", () => {
    const text = GoalGate.continuation({
      goal: "add the widget",
      command: "bun test widget",
      exitCode: 1,
      output: "1 test failed",
      attempt: 2,
      maxRetries: 3,
    })

    expect(text).toContain("Goal: add the widget")
    expect(text).toContain("$ bun test widget")
    expect(text).toContain("Exit code: 1")
    expect(text).toContain("1 test failed")
    expect(text).toContain("attempt 2/3")
  })
})
