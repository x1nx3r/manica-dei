import { describe, expect, test } from "bun:test"
import type { SessionGoalInfo } from "@opencode-ai/sdk/v2/client"
import { goalConclusion, goalProjection, type SessionGoalRuling } from "./session-goal"

const goal = (patch: Partial<SessionGoalInfo> = {}) =>
  ({
    goal: "add the widget",
    gates: [],
    authorized: true,
    phase: "judge",
    turn_budget: 8,
    turns_used: 2,
    state_hash: null,
    status: "active",
    ...patch,
  }) as SessionGoalInfo

const handoff = {
  tested: "the widget is not added",
  implementation: "addWidget is never called (src/widget.ts:12)",
  cause: "the handler still returns early",
}

describe("goalConclusion", () => {
  test("a ruling from the trail is the conclusion, with its handoff and its judge", () => {
    const ruling: SessionGoalRuling = {
      round: 3,
      verdict: "continue",
      reason: "the finding holds",
      handoff,
      roleSessionID: "ses_judge",
    }
    expect(goalConclusion(goal({ last_verdict: "continue", last_reason: "the finding holds" }), ruling)).toEqual(ruling)
  })

  test("the projection concludes a run the client arrived after the fact for", () => {
    const conclusion = goalConclusion(goal({ last_verdict: "done", last_reason: "the gate passes" }), undefined)
    expect(conclusion).toEqual({ verdict: "done", reason: "the gate passes" })
    // What a late client cannot get from the projection: the handoff and the
    // judge's own session. The verdict card in the timeline carries the first.
    expect(conclusion?.handoff).toBeUndefined()
    expect(conclusion?.roleSessionID).toBeUndefined()
  })

  test("a run the judge never ruled on has no conclusion to read", () => {
    expect(goalConclusion(goal({ phase: "dev" }), undefined)).toBeUndefined()
    expect(goalConclusion(goal({ last_verdict: undefined, last_reason: undefined }), undefined)).toBeUndefined()
  })
})

describe("goalProjection", () => {
  test("a projection passes through", () => {
    const info = goal()
    expect(goalProjection(info)).toBe(info)
  })

  test("a body that is not a projection reads as no goal", () => {
    // The shape a stub or a proxy answers with, and the reason this guard
    // exists: the strip renders on fields, so it must not render on `{}`.
    expect(goalProjection({})).toBeUndefined()
    expect(goalProjection(null)).toBeUndefined()
    expect(goalProjection("ok")).toBeUndefined()
    expect(goalProjection(goal({ gates: undefined as never }))).toBeUndefined()
    expect(goalProjection(goal({ phase: undefined as never }))).toBeUndefined()
  })
})
