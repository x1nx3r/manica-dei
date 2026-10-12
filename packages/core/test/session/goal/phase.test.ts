import { describe, expect, test } from "bun:test"
import { GoalPhase } from "@opencode-ai/core/session/goal/phase"

// Fork ADR-0006, M5: the phase machine's pure half. The rule it pins is the one
// that keeps a `done` from ending a run no judge ruled on: only `judge` may
// conclude, and only `continue` and `wait` send the loop back to work.

describe("GoalPhase.mayConclude — only the judge concludes", () => {
  test("the judge phase may conclude", () => {
    expect(GoalPhase.mayConclude("judge")).toBe(true)
  })

  test("dev and qa may not conclude", () => {
    expect(GoalPhase.mayConclude("dev")).toBe(false)
    expect(GoalPhase.mayConclude("qa")).toBe(false)
  })
})

describe("GoalPhase.after — the phase a verdict leaves behind", () => {
  test("continue and wait return the loop to dev", () => {
    expect(GoalPhase.after("continue")).toBe("dev")
    expect(GoalPhase.after("wait")).toBe("dev")
  })

  test("done and blocked are terminal", () => {
    expect(GoalPhase.after("done")).toBeUndefined()
    expect(GoalPhase.after("blocked")).toBeUndefined()
  })
})
