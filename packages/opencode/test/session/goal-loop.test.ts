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
import type { SessionGoal } from "@opencode-ai/schema/session-goal"
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

// Fork ADR-0006, M4 + the QA loop: the loop's decision, driven with a fake judge
// and real gates. Deterministic. It covers the order — authorization, budget,
// gates, then the QA pass that alone admits the judge — and the four verdicts.

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
  state: "snap-1",
  failures: { parse: 0, transport: 0, qa: 0 },
})

/** An admissible QA record: a clean pass with a probe against the clause. */
const cleanRecord = (state = "snap-1"): SessionGoal.Record => ({
  state,
  verdict: "clean",
  probes: [
    {
      criterion: "the widget renders",
      derived: true,
      command: "bun test widget",
      output: "1 pass",
      result: "pass",
    },
  ],
  findings: [],
})

const contradictedRecord = (state = "snap-1"): SessionGoal.Record => ({
  state,
  verdict: "contradicted",
  probes: [
    {
      criterion: "a request pending 7+ days reaches the HR manager",
      derived: true,
      command: "bun run sweep && queue",
      output: "queue: (empty)",
      result: "fail",
    },
  ],
  findings: [
    {
      criterion: "a request pending 7+ days reaches the HR manager",
      detail: "escalateOverdue is defined and tested but nothing calls it.",
      evidence: "src/domain/leave.ts:79; src/db/ has no caller",
    },
  ],
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

  it.instance("no QA record: the loop asks for a pass and binds the round", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("qa")
      // The round is bound to the state QA will review, and the phase is `qa`.
      expect((yield* goal.get(info.id))?.phase).toBe("qa")
      expect((yield* goal.get(info.id))?.state_hash).toBe("snap-1")
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a clean pass with probes admits the judge, which weighs the record", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
      judgeResult = { judgement: { verdict: "continue", reason: "the tests are not written" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") {
        expect(result.decision.prompt).toContain("the tests are not written")
        // The agent is told to run the verification and leave the change where a
        // reviewer can see it — the judge reads the artifact, not the reply.
        expect(result.decision.prompt).toContain("run the verification and leave the change")
      }
      // The judge read the record, not the agent's account of it.
      expect(judgeInput?.record?.state).toBe("snap-1")
      expect((yield* goal.get(info.id))?.last_verdict).toBe("continue")
      // Weighing it consumed the record.
      expect((yield* goal.get(info.id))?.qa_record).toBeUndefined()

      yield* session.remove(info.id)
    }),
  )

  it.instance("clean with no probes is an abstention, not a pass — the judge never sees it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      yield* loop.submitRecord({ sessionID: info.id, record: { state: "snap-1", verdict: "clean", probes: [], findings: [] } })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") expect(result.decision.prompt).toContain("silence is not a pass")
      expect(judgeCalls).toBe(0)
      expect((yield* goal.get(info.id))?.phase).toBe("dev")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a contradicted record goes back to dev with the findings, minus the probe's command", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add escalation" })
      yield* goal.authorize(info.id)
      yield* loop.submitRecord({ sessionID: info.id, record: contradictedRecord() })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") {
        expect(result.decision.prompt).toContain("escalateOverdue is defined and tested but nothing calls it.")
        expect(result.decision.prompt).toContain("queue: (empty)")
        // The probe's command is withheld: it is the thing the dev could tune to.
        expect(result.decision.prompt).not.toContain("bun run sweep")
      }
      expect(judgeCalls).toBe(0)
      expect((yield* goal.get(info.id))?.phase).toBe("dev")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a record that does not match the bound state is stale, and cannot be weighed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      // The round binds to `snap-1`; the record reviewed `snap-2`. It is stale.
      yield* goal.bindState({ sessionID: info.id, state: "snap-2" })
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord("snap-1") })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") expect(result.decision.prompt).toContain("stale")
      expect(judgeCalls).toBe(0)
      expect((yield* goal.get(info.id))?.phase).toBe("dev")
      expect((yield* goal.get(info.id))?.qa_record).toBeUndefined()

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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
      judgeResult = { judgement: { verdict: "continue", reason: "more to do" } }

      yield* loop.decide(decideInput(info.id as never, test.directory))
      // The verdict binds to the state the round was decided against.
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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
      judgeResult = { judgement: { verdict: "wait", reason: "the build is running", wait: { pid: 42 } } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("wait")
      if (result.decision._tag === "wait") expect(result.decision.wait).toEqual({ pid: 42 })

      yield* session.remove(info.id)
    }),
  )

  it.instance("a passing gate lets QA run next", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("true")] })
      yield* goal.authorize(info.id)
      const result = yield* loop.decide(decideInput(info.id as never, test.directory))

      expect(result.decision._tag).toBe("qa")
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("the gate's own output travels with the QA decision", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("echo gate-ran")] })
      yield* goal.authorize(info.id)
      const result = yield* loop.decide(decideInput(info.id as never, test.directory))

      // QA reads the loop's capture of the check, not the agent's word for it
      // (ADR-0006, "prefer a fact over a rule").
      expect(result.decision._tag).toBe("qa")
      if (result.decision._tag === "qa") {
        expect(result.decision.evidence.length).toBe(1)
        expect(result.decision.evidence[0]?.command).toBe("echo gate-ran")
        expect(result.decision.evidence[0]?.exitCode).toBe(0)
        expect(result.decision.evidence[0]?.output).toContain("gate-ran")
      }

      yield* session.remove(info.id)
    }),
  )

  it.instance("a failing gate short-circuits QA and the judge, and carries the output", () =>
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
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
      judgeResult = { judgement: { verdict: "continue", reason: "unreadable" }, failure: "parse" }

      const input = { ...decideInput(info.id as never, test.directory), failures: { parse: 2, transport: 0, qa: 0 } }
      const result = yield* loop.decide(input)

      expect(result.decision).toMatchObject({ _tag: "stop" })
      expect(result.failures.parse).toBe(3)

      yield* session.remove(info.id)
    }),
  )

  it.instance("clean with only the author's own checks is an abstention, not a pass", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      // A probe, but the author's own check — not QA's derived holdout.
      yield* loop.submitRecord({
        sessionID: info.id,
        record: {
          state: "snap-1",
          verdict: "clean",
          probes: [
            { criterion: "the widget renders", derived: false, command: "bun test widget", output: "1 pass", result: "pass" },
          ],
          findings: [],
        },
      })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") expect(result.decision.prompt).toContain("derived no probe")
      expect(judgeCalls).toBe(0)
      expect((yield* goal.get(info.id))?.phase).toBe("dev")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a relabelled author check is not a holdout — the round is still an abstention", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("bun test widget")] })
      yield* goal.authorize(info.id)
      // The author's own gate, marked as QA's own probe. The loop holds the gate
      // command, so the label is corrected before the record is weighed: a
      // relabel does not buy a pass.
      yield* loop.submitRecord({
        sessionID: info.id,
        record: {
          state: "snap-1",
          verdict: "clean",
          probes: [
            { criterion: "the widget renders", derived: true, command: "bun test widget", output: "1 pass", result: "pass" },
          ],
          findings: [],
        },
      })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") expect(result.decision.prompt).toContain("derived no probe")
      expect(judgeCalls).toBe(0)
      expect((yield* goal.get(info.id))?.phase).toBe("dev")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a corrected relabel still reaches the judge when a genuine probe carries the round", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("bun test widget")] })
      yield* goal.authorize(info.id)
      yield* loop.submitRecord({
        sessionID: info.id,
        record: {
          state: "snap-1",
          verdict: "clean",
          probes: [
            { criterion: "the widget renders", derived: true, command: "bun test widget", output: "1 pass", result: "pass" },
            { criterion: "the widget renders", derived: true, command: "query the queue", output: "queue: (empty)", result: "pass" },
          ],
          findings: [],
        },
      })

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(judgeCalls).toBe(1)
      // The author's check is corrected, the genuine probe stands — the judge
      // weighs an honest record.
      expect(judgeInput?.record?.probes.map((probe) => probe.derived)).toEqual([false, true])
      expect(result.decision._tag).not.toBe("qa")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a round with no workspace state stops rather than pass unaudited", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)

      const result = yield* loop.decide({ ...decideInput(info.id as never, test.directory), state: undefined })
      expect(result.decision).toMatchObject({ _tag: "stop" })
      if (result.decision._tag === "stop") expect(result.decision.note).toContain("no workspace state")
      expect(judgeCalls).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a done is refused when the handoff tore — the record persisted, the phase move did not", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      // The torn handoff, exactly as a crash between `submitRecord`'s two writes
      // would leave it: the round bound its state and moved to `qa`, QA
      // persisted its record, and the phase move to `judge` never happened. The
      // record is real, but the round never handed it off — so it may not
      // conclude. This is the one state the guard exists for.
      yield* goal.bindState({ sessionID: info.id, state: "snap-1" })
      yield* goal.setPhase({ sessionID: info.id, phase: "qa" })
      yield* goal.setRecord({ sessionID: info.id, record: cleanRecord() })
      judgeResult = { judgement: { verdict: "done", reason: "the tests pass" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") expect(result.decision.prompt).toContain("cannot be concluded")
      expect((yield* goal.get(info.id))?.status).toBe("active")
      expect((yield* goal.get(info.id))?.phase).toBe("dev")

      yield* session.remove(info.id)
    }),
  )

  it.instance("the real two-step path admits the judge and concludes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)

      // Step one: the loop asks for the QA pass and binds the round.
      const asked = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(asked.decision._tag).toBe("qa")
      if (asked.decision._tag !== "qa") return
      // Step two: QA's record is persisted; the round enters `judge`.
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord(asked.decision.state) })
      expect((yield* goal.get(info.id))?.phase).toBe("judge")

      judgeResult = { judgement: { verdict: "done", reason: "the tests pass" } }
      const concluded = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(concluded.decision).toMatchObject({ _tag: "stop" })
      expect((yield* goal.get(info.id))?.status).toBe("done")

      yield* session.remove(info.id)
    }),
  )

  it.instance("the resolve call does not run the gates a second time", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      // A gate that fails: if the resolve call re-ran it, it would short-circuit
      // and the judge would never be consulted.
      yield* goal.set({ sessionID: info.id, goal: "add the widget", gates: [gate("false")] })
      yield* goal.authorize(info.id)
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
      judgeResult = { judgement: { verdict: "continue", reason: "the judge ran" } }

      const result = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(result.decision._tag).toBe("continue")
      if (result.decision._tag === "continue") expect(result.decision.prompt).toContain("the judge ran")
      // The gate did not run again; the judge was reached.
      expect(judgeCalls).toBe(1)
      expect((yield* goal.get(info.id))?.gates[0]?.attempts).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a QA failure fails open, and a run of them stops naming the configuration", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)

      // The first failure is tolerated: back to `dev`, counted.
      const first = yield* loop.decide({ ...decideInput(info.id as never, test.directory), qaFailure: true })
      expect(first.decision._tag).toBe("continue")
      if (first.decision._tag === "continue") expect(first.decision.prompt).toContain("could not run")
      expect(first.failures.qa).toBe(1)
      expect((yield* goal.get(info.id))?.phase).toBe("dev")
      // A round no judge closed still spends a turn.
      expect((yield* goal.get(info.id))?.turns_used).toBe(1)

      // A consecutive run stops the loop and names the QA configuration.
      const terminal = yield* loop.decide({
        ...decideInput(info.id as never, test.directory),
        qaFailure: true,
        failures: { parse: 0, transport: 0, qa: 2 },
      })
      expect(terminal.decision).toMatchObject({ _tag: "stop" })
      if (terminal.decision._tag === "stop") expect(terminal.decision.note).toContain("goal-qa")
      expect(terminal.failures.qa).toBe(3)
      expect((yield* goal.get(info.id))?.turns_used).toBe(2)

      // A delivered record clears the streak.
      yield* loop.submitRecord({ sessionID: info.id, record: cleanRecord() })
      const delivered = yield* loop.decide(decideInput(info.id as never, test.directory))
      expect(delivered.failures.qa).toBe(0)

      yield* session.remove(info.id)
    }),
  )
})
