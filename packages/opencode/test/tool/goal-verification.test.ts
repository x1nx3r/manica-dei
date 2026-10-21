import { describe, expect, test } from "bun:test"
import { GoalVerification } from "../../src/tool/goal-verification"

// The corpus's corrupted gate: `verification` written as a sentence
// ("…npm run build, plus browser screenshots …") is executed verbatim by the
// loop, failed twice, and burned two dev rounds. The tool text demands a
// command; this is the parser-level refusal behind it.

describe("GoalVerification.proseReason", () => {
  test("accepts runnable command lines", () => {
    expect(GoalVerification.proseReason("npm run build")).toBeUndefined()
    expect(GoalVerification.proseReason("cd app && npm test")).toBeUndefined()
    expect(GoalVerification.proseReason("bun run lint && npx tsc --noEmit")).toBeUndefined()
    expect(GoalVerification.proseReason("go test ./internal/... -count=1")).toBeUndefined()
    expect(GoalVerification.proseReason("curl -fsS localhost:8080/health | grep ok")).toBeUndefined()
  })

  test("refuses the sentence shapes that make the gate unrunnable", () => {
    const corpus =
      "cd /home/ubuntu/workspace/app && npm run lint && npm run typecheck && npm run build, plus browser screenshots of the picker open in dark and light mode"
    expect(GoalVerification.proseReason(corpus)).toBeDefined()
    expect(GoalVerification.proseReason("npm run build\nnpm test")).toBeDefined()
    expect(GoalVerification.proseReason("npm run build, and then open the app")).toBeDefined()
    expect(GoalVerification.proseReason("npm test. The suite must be green")).toBeDefined()
    expect(GoalVerification.proseReason("deploy it and take a screenshot")).toBeDefined()
    expect(GoalVerification.proseReason("make sure the button works")).toBeDefined()
  })

  test("the refusal tells the model where the prose belongs", () => {
    const refusal = GoalVerification.refuse("npm run build, plus screenshots")
    expect(refusal.title).toContain("one exact shell command")
    expect(refusal.output).toContain("constraints")
    expect(refusal.output).toContain("verbatim")
  })
})
