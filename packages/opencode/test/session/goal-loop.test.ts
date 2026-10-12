import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session as SessionNs } from "@/session/session"
import { Goal } from "@/session/goal"
import { GoalGate } from "@/session/goal-gate"
import { GoalJudge } from "@/session/goal-judge"
import { GoalLoop } from "@/session/goal-loop"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Fork ADR-0006, M4: the loop's decision, driven with a fake judge and real
// gates. Deterministic, and it covers the whole order — authorization, budget,
// gates before judge, the four verdicts, and the circuit breaker.

let judgeCalls = 0
let judgeInput: GoalJudge.JudgeInput | undefined
let judgeResult: GoalJudge.JudgeResult = { judgement: { verdict: "continue", reason: "keep going" } }

const fakeJudge = Layer.mock(GoalJudge.Service, {
  judge: (input) =>
    Effect.sync(() => {
      judgeCalls += 1
      judgeInput = input
      return judgeResult
    }),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      GoalLoop.node,
      Goal.node,
      GoalGate.node,
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      EventV2.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
      [GoalJudge.node, fakeJudge],
    ],
  ),
)

const gate = (command: string, overrides: Partial<{ attempts: number; max_retries: number }> = {}) => ({
  command,
  timeout_seconds: 30,
  max_retries: overrides.max_retries ?? 3,
  attempts: overrides.attempts ?? 0,
  last_exit_code: null,
  last_output_tail: "",
})

const decideInput = (sessionID: never, cwd: string) => ({
  sessionID,
  cwd,
  user: {} as never,
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("judge"),
  lastResponse: "I added the widget.",
  state: "snap-1",
  failures: { parse: 0, transport: 0 },
})

beforeEach(() => {
  judgeCalls = 0
  judgeInput = undefined
  judgeResult = { judgement: { verdict: "continue", reason: "keep going" } }
})

describe("session.goal-loop", () => {
  it.instance("no goal stops — today's behaviour", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision).toEqual({ _tag: "stop" })
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a goal that is not authorized never loops", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      const result = yield* loop.decide(decideInput(info.id as never, test.directory))

      expect(result.decision).toEqual({ _tag: "stop" })
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a continue verdict continues with the judge's reason", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "continue", reason: "the tests are not written" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") {
        expect(result.decision.prompt).toContain("the tests are not written")
        // The agent is told to show evidence, so the judge can decide on it.
        expect(result.decision.prompt).toContain("show the evidence")
      }
      expect((yield* goal.get(info.id))?.last_verdict).toBe("continue")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a done verdict stops and marks the goal done", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "done", reason: "the tests pass" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision).toMatchObject({ _tag: "stop" })
      expect((yield* goal.get(info.id))?.status).toBe("done")
      expect((yield* goal.get(info.id))?.last_reason).toBe("the tests pass")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a fresh goal starts in the dev phase with no state handle", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      expect((yield* goal.get(info.id))?.phase).toBe("dev")
      expect((yield* goal.get(info.id))?.state_hash).toBeNull()

      yield* session.remove(info.id)
    }),
  )

  it.instance("a continue verdict returns the goal to the dev phase", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "continue", reason: "more to do" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      // The judge acted in `judge`; a `continue` sends the loop back to `dev`.
      expect((yield* goal.get(info.id))?.phase).toBe("dev")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a done verdict is the judge's, and leaves the goal in the judge phase", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "done", reason: "the tests pass" } }

      yield* loop.decide(decideInput(info.id as never, test.directory))
      // `done` is terminal, so the phase stays where the judge acted.
      expect((yield* goal.get(info.id))?.phase).toBe("judge")

      yield* session.remove(info.id)
    }),
  )

  it.instance("the workspace state a verdict applied to is recorded", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "continue", reason: "more to do" } }

      yield* loop.decide(decideInput(info.id as never, test.directory))
      // Recorded, not yet enforced against staleness (ADR-0006, "state binding").
      expect((yield* goal.get(info.id))?.state_hash).toBe("snap-1")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a blocked verdict is blocked, not done", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "blocked", reason: "needs an API key" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("blocked")
      if (result.decision._tag === "blocked") expect(result.decision.reason).toBe("needs an API key")
      expect((yield* goal.get(info.id))?.status).toBe("blocked")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a wait verdict parks with its directive", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "wait", reason: "the build is running", wait: { pid: 42 } } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("wait")
      if (result.decision._tag === "wait") expect(result.decision.wait).toEqual({ pid: 42 })

      yield* session.remove(info.id)
    }),
  )

  it.instance("a passing gate lets the judge run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("true")] })
      yield* goal.authorize(info.id)
      yield* loop.decide(decideInput(info.id as never, test.directory))

      expect(judgeCalls).toBe(1)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a passing gate hands the judge the gate's own output as evidence", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("echo gate-ran")] })
      yield* goal.authorize(info.id)
      yield* loop.decide(decideInput(info.id as never, test.directory))

      // The judge reads the loop's capture of the check, not the agent's word
      // for it (ADR-0006, "prefer a fact over a rule").
      expect(judgeInput?.evidence?.length).toBe(1)
      expect(judgeInput?.evidence?.[0]?.command).toBe("echo gate-ran")
      expect(judgeInput?.evidence?.[0]?.exitCode).toBe(0)
      expect(judgeInput?.evidence?.[0]?.output).toContain("gate-ran")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a failing gate short-circuits the judge and carries the output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("printf boom; exit 3")] })
      yield* goal.authorize(info.id)

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))

      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") {
        expect(result.decision.prompt).toContain("printf boom; exit 3")
        expect(result.decision.prompt).toContain("boom")
      }
      expect(judgeCalls).toBe(0)

      // The gate's retry state was persisted.
      expect((yield* goal.get(info.id))?.gates[0]?.attempts).toBe(1)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a gate past its retries stops the loop as blocked", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("false", { attempts: 3 })] })
      yield* goal.authorize(info.id)

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("blocked")
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a gate that passes again resets its attempts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("true", { attempts: 2 })] })
      yield* goal.authorize(info.id)
      yield* loop.decide(decideInput(info.id as never, test.directory))

      expect((yield* goal.get(info.id))?.gates[0]?.attempts).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("the turn budget is the floor", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", turnBudget: 2 })
      yield* goal.authorize(info.id)
      yield* goal.record({ sessionID: info.id, verdict: "continue" })
      yield* goal.record({ sessionID: info.id, verdict: "continue" })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision).toMatchObject({ _tag: "stop" })
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("consecutive judge failures trip the circuit breaker", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      judgeResult = { judgement: { verdict: "continue", reason: "unreadable" }, failure: "parse" }

      const input = { ...decideInput(info.id as never, test.directory), failures: { parse: 2, transport: 0 } }
      const result = yield* loop.decide(input)

      expect(result.decision).toMatchObject({ _tag: "stop" })
      expect(result.failures.parse).toBe(3)

      yield* session.remove(info.id)
    }),
  )
})
