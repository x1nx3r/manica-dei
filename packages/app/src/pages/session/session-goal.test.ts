import { describe, expect, test } from "bun:test"
import type { SessionGoalInfo } from "@opencode-ai/sdk/v2/client"
import {
  goalConclusion,
  goalProjection,
  goalRoles,
  loadGoal,
  loadGoalOutcome,
  loadChildren,
  type SessionGoalRuling,
} from "./session-goal"

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
    const conclusion = goalConclusion(
      goal({ last_verdict: "done", last_reason: "the gate passes", last_verdict_session: "ses_judge" }),
      undefined,
    )
    expect(conclusion).toEqual({ verdict: "done", reason: "the gate passes", roleSessionID: "ses_judge" })
    // What a late client cannot get from the projection: the handoff. The
    // pointer rides the row now; the relay is in the verdict card in the
    // timeline.
    expect(conclusion?.handoff).toBeUndefined()
  })

  test("a projection whose judge predates the pointer concludes without it", () => {
    const conclusion = goalConclusion(goal({ last_verdict: "done", last_reason: "the gate passes" }), undefined)
    expect(conclusion).toEqual({ verdict: "done", reason: "the gate passes", roleSessionID: undefined })
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

describe("loadGoal", () => {
  test("a served projection is the goal", async () => {
    const info = goal()
    await expect(loadGoal(async () => ({ data: info }))).resolves.toBe(info)
  })

  test("an answered error and an unanswered route are both no goal", async () => {
    await expect(loadGoal(async () => ({ error: { message: "Goal not found" } }))).resolves.toBeUndefined()
    await expect(loadGoal(async () => ({ data: {} }))).resolves.toBeUndefined()
  })

  test("a route the server cannot answer does not reject", async () => {
    // The failure this exists for: the perf fixtures answer an unlikely path
    // with `index.html`, the client throws on the content type, and a rejected
    // resource throws *at its read* — inside the session page, which took the
    // whole view down and every layout test with it.
    const request = async (): Promise<{ data?: unknown }> => {
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")
    }
    await expect(loadGoal(request)).resolves.toBeUndefined()
  })
})

describe("loadGoalOutcome", () => {
  test("a served projection is final", async () => {
    const info = goal()
    await expect(loadGoalOutcome(async () => ({ data: info }))).resolves.toEqual({ info, retry: false })
  })

  test("has_goal:false is a fact, not a failed request", async () => {
    // The route answers 200 for a session with no goal (issue #35). It must not
    // enter the retry schedule.
    await expect(loadGoalOutcome(async () => ({ data: { has_goal: false } }))).resolves.toEqual({
      info: undefined,
      retry: false,
    })
  })

  test("has_goal:true carries the projection", async () => {
    const info = goal()
    await expect(loadGoalOutcome(async () => ({ data: { has_goal: true, projection: info } }))).resolves.toEqual({
      info,
      retry: false,
    })
  })

  test("has_goal:true without a projection is a malformed body and is retried", async () => {
    await expect(loadGoalOutcome(async () => ({ data: { has_goal: true } }))).resolves.toEqual({
      info: undefined,
      retry: true,
    })
  })

  test("a legacy bare null is also final", async () => {
    await expect(loadGoalOutcome(async () => ({ data: null }))).resolves.toEqual({ info: undefined, retry: false })
  })

  test("a 404 is the loop saying it has no goal, and is final", async () => {
    // The two answers `loadGoal` must not distinguish but the client must:
    // absence is a fact, an unanswerable server is a hole to retry.
    await expect(loadGoalOutcome(async () => ({ error: { name: "NotFoundError" } }))).resolves.toEqual({
      info: undefined,
      retry: false,
    })
    await expect(loadGoalOutcome(async () => ({ error: { data: { statusCode: 404 } } }))).resolves.toEqual({
      info: undefined,
      retry: false,
    })
  })

  test("a server that could not answer is worth another attempt", async () => {
    await expect(
      loadGoalOutcome(async () => ({ error: { name: "APIError", data: { statusCode: 502 } } })),
    ).resolves.toEqual({ info: undefined, retry: true })
    await expect(
      loadGoalOutcome(async () => {
        throw new Error("Connection refused")
      }),
    ).resolves.toEqual({ info: undefined, retry: true })
  })

  test("a 200 that is not a projection is retried rather than trusted", async () => {
    await expect(loadGoalOutcome(async () => ({ data: {} }))).resolves.toEqual({ info: undefined, retry: true })
  })
})

describe("goalRoles", () => {
  const child = (patch: Record<string, unknown> = {}) => ({ id: "ses_child", title: "QA the goal", ...patch })

  test("the labeled children are the run's roles, with their round", () => {
    const roles = goalRoles([
      child({ id: "ses_qa", metadata: { goal_role: "qa", goal_round: 2 } }),
      child({ id: "ses_judge", title: "Judge the goal", metadata: { goal_role: "judge", goal_round: 2 } }),
    ])
    expect(roles).toEqual([
      { id: "ses_qa", title: "QA the goal", role: "qa", round: 2 },
      { id: "ses_judge", title: "Judge the goal", role: "judge", round: 2 },
    ])
  })

  test("an unlabeled child is not a role: a task subagent is a child of the same session", () => {
    expect(goalRoles([child(), child({ metadata: { tool: "task" } })])).toEqual([])
    expect(goalRoles([])).toEqual([])
    expect(goalRoles({})).toEqual([])
    expect(goalRoles(null)).toEqual([])
  })

  test("a role from before the round was carried reads with none", () => {
    expect(goalRoles([child({ metadata: { goal_role: "qa" } })])).toEqual([
      { id: "ses_child", title: "QA the goal", role: "qa", round: undefined },
    ])
  })
})

describe("loadChildren", () => {
  test("never rejects, for the reason `loadGoal` cannot", async () => {
    const request = async (): Promise<{ data?: unknown }> => {
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")
    }
    await expect(loadChildren(request)).resolves.toEqual([])
    await expect(loadChildren(async () => ({ error: { message: "not found" } }))).resolves.toEqual([])
    await expect(loadChildren(async () => ({ data: [null, 4] }))).resolves.toEqual([])
  })
})
