import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { GoalTool } from "@/tool/goal"
import { Goal } from "@/session/goal"
import { Scratchpad } from "@/session/scratchpad"
import { Session as SessionNs } from "@/session/session"
import { Question } from "@/question"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { testEffect } from "../lib/effect"

// Fork ADR-0006, M5: the `goal` tool — the kickoff. It writes the goal, turns
// the contract's verification into the gate, writes the scratchpad, and asks
// for the commit authorization only when told to.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Goal.node,
      Question.node,
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      EventV2.node,
      Database.node,
      Truncate.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const contract = {
  outcome: "the widget renders",
  verification: "bun test widget",
  constraints: "nothing else changes",
  boundaries: "packages/widget",
  stop_when: "the spec is ambiguous",
}

const gate = {
  command: contract.verification,
  timeout_seconds: 300,
  max_retries: 3,
  attempts: 0,
  last_exit_code: null,
  last_output_tail: "",
}

const params = (overrides: Record<string, unknown> = {}) => ({
  goal: "add the widget",
  size: "medium" as const,
  size_reason: "a few reversible choices",
  contract,
  ...overrides,
})

const context = (sessionID: SessionID) => ({
  sessionID,
  messageID: MessageID.make("msg_goal-test"),
  callID: "call_goal-test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

/** Waits for the commit question the tool asks, answers it, and returns it. */
const answerCommit = (question: Question.Interface, reply: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const asked = yield* Queue.unbounded<void>()
    const off = yield* events.listen((event) => {
      if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => off)

    for (;;) {
      const item = (yield* question.list())[0]
      if (item) {
        yield* question.reply({ requestID: item.id, answers: [[reply]] })
        return item
      }
      yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
    }
  })

describe("tool.goal", () => {
  it.instance("refuses a goal from a subagent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const parent = yield* session.create({})
      const child = yield* session.create({ parentID: parent.id })
      const tool = yield* (yield* GoalTool).init()

      const exit = yield* tool.execute(params(), context(child.id)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Goals belong to the root session")
      }
      // The refusal happens before any write.
      expect(yield* goal.get(child.id)).toBeUndefined()
      expect(yield* goal.get(parent.id)).toBeUndefined()

      yield* session.remove(child.id)
      yield* session.remove(parent.id)
    }),
  )

  it.instance("writes the goal, the size, the contract, and the gate in one call", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      yield* tool.execute(params(), context(info.id))

      const stored = yield* goal.get(info.id)
      expect(stored?.goal).toBe("add the widget")
      expect(stored?.size).toBe("medium")
      expect(stored?.size_reason).toBe("a few reversible choices")
      expect(stored?.contract).toEqual(contract)
      expect(stored?.authorized).toBe(false)
      expect(stored?.gates).toEqual([
        {
          command: "bun test widget",
          timeout_seconds: 300,
          max_retries: 3,
          attempts: 0,
          last_exit_code: null,
          last_output_tail: "",
        },
      ])

      // The scratchpad carries what the judge and the human read.
      const file = SessionNs.scratchpad(info, yield* InstanceState.context)
      const content = yield* Effect.promise(() => Scratchpad.read(file))
      expect(Scratchpad.readSection(content, "Goal")).toBe("add the widget")
      expect(Scratchpad.readSection(content, "Size")).toContain("medium")
      expect(Scratchpad.readSection(content, "Contract")).toContain("Verification: bun test widget")

      yield* session.remove(info.id)
    }),
  )

  it.instance("refuses a contract with no verification, and sets nothing", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      const result = yield* tool.execute(params({ contract: { ...contract, verification: "  " } }), context(info.id))

      expect(result.output).toContain("no verification command")
      expect(yield* goal.get(info.id)).toBeUndefined()

      yield* session.remove(info.id)
    }),
  )

  it.instance("refuses a prose verification, and sets nothing", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      const result = yield* tool.execute(
        params({
          contract: {
            ...contract,
            verification:
              "cd app && npm run lint && npm run build, plus browser screenshots of the picker in dark and light mode",
          },
        }),
        context(info.id),
      )

      expect(result.title).toContain("one exact shell command")
      expect(result.output).toContain("constraints")
      expect(yield* goal.get(info.id)).toBeUndefined()

      yield* session.remove(info.id)
    }),
  )

  it.instance("a huge goal routes to a split proposal, not to work", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      const result = yield* tool.execute(params({ size: "huge" }), context(info.id))

      expect(result.title).toBe("This is more than one task")
      expect(yield* goal.get(info.id)).toBeUndefined()

      yield* session.remove(info.id)
    }),
  )

  it.instance("committing and answering yes authorizes the goal", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const question = yield* Question.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      const fiber = yield* tool.execute(params({ commit: true }), context(info.id)).pipe(Effect.forkScoped)
      yield* answerCommit(question, "Yes, that's what I want")
      const result = yield* Fiber.join(fiber)

      expect(result.title).toBe("Goal authorized")
      expect((yield* goal.get(info.id))?.authorized).toBe(true)

      yield* session.remove(info.id)
    }),
  )

  it.instance("committing and answering no leaves the goal set but unauthorized", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const question = yield* Question.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      const fiber = yield* tool.execute(params({ commit: true }), context(info.id)).pipe(Effect.forkScoped)
      yield* answerCommit(question, "No, let's adjust it")
      const result = yield* Fiber.join(fiber)

      expect(result.title).toBe("Not authorized")
      const stored = yield* goal.get(info.id)
      expect(stored?.authorized).toBe(false)
      expect(stored?.goal).toBe("add the widget")

      yield* session.remove(info.id)
    }),
  )

  it.instance("the commit question shows the outcome and the check before the human agrees", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const question = yield* Question.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      const fiber = yield* tool.execute(params({ commit: true }), context(info.id)).pipe(Effect.forkScoped)
      const request = yield* answerCommit(question, "Yes, that's what I want")
      yield* Fiber.join(fiber)

      // The human's one chance to agree what done means. The outcome and the check
      // are restated in the question — a check that does not exercise the outcome
      // has to look wrong here, not three turns later — and the rest of the
      // contract is on the goal row, rendered by the client's goal panel beside
      // the question (ADR-0006).
      const asked = JSON.stringify(request)
      expect(asked).toContain("Done means: the widget renders")
      expect(asked).toContain("I will check it with: bun test widget")
      expect(asked).toContain("The full contract — must not change, in scope, stop when — is on the goal")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a new goal on an authorized session asks before it resets the run", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const question = yield* Question.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      yield* goal.setPhase({ sessionID: info.id, phase: "qa" })
      yield* goal.record({ sessionID: info.id, verdict: "continue", state: "hash-1" })

      const fiber = yield* tool
        .execute(params({ goal: "add another widget", commit: true }), context(info.id))
        .pipe(Effect.forkScoped)
      const asked = yield* answerCommit(question, "No, keep the current goal")
      const result = yield* Fiber.join(fiber)

      expect(JSON.stringify(asked)).toContain("Replace the current goal?")
      expect(JSON.stringify(asked)).toContain("This session already has an authorized goal.")
      expect(result.title).toBe("Current goal kept")

      const stored = yield* goal.get(info.id)
      expect(stored?.goal).toBe("add the widget")
      expect(stored?.authorized).toBe(true)
      expect(stored?.phase).toBe("qa")
      expect(stored?.turns_used).toBe(1)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a confirmed replacement resets the old run and asks for a new authorization", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const question = yield* Question.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      yield* goal.record({ sessionID: info.id, verdict: "done", reason: "the old widget", state: "hash-1" })

      const fiber = yield* tool
        .execute(params({ goal: "add another widget", commit: true }), context(info.id))
        .pipe(Effect.forkScoped)
      const asked = yield* answerCommit(question, "Yes, replace it")
      expect(JSON.stringify(asked)).toContain("This session already has an authorized goal.")
      yield* answerCommit(question, "Yes, that's what I want")
      const result = yield* Fiber.join(fiber)

      expect(result.title).toBe("Goal authorized")
      const stored = yield* goal.get(info.id)
      expect(stored?.generation).toBe(2)
      expect(stored?.goal).toBe("add another widget")
      expect(stored?.authorized).toBe(true)
      expect(stored?.phase).toBe("dev")
      expect(stored?.turns_used).toBe(0)
      expect(stored?.last_verdict).toBeUndefined()
      expect(stored?.state_hash).toBeNull()

      yield* session.remove(info.id)
    }),
  )

  it.instance("an already authorized goal does not ask again", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      yield* goal.set({
        sessionID: info.id,
        goal: "add the widget",
        size: "medium",
        sizeReason: "a few reversible choices",
        contract,
        gates: [gate],
      })
      yield* goal.authorize(info.id)

      const result = yield* tool.execute(params({ commit: true }), context(info.id))

      expect(result.title).toBe("Goal already authorized")
      expect((yield* goal.get(info.id))?.authorized).toBe(true)

      yield* session.remove(info.id)
    }),
  )

  it.instance("a terminal goal can start a new run with the same definition", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const question = yield* Question.Service
      const info = yield* session.create({})
      const tool = yield* (yield* GoalTool).init()

      yield* goal.set({
        sessionID: info.id,
        goal: "add the widget",
        size: "medium",
        sizeReason: "a few reversible choices",
        contract,
        gates: [gate],
      })
      yield* goal.authorize(info.id)
      yield* goal.setStatus({ sessionID: info.id, status: "done" })

      const fiber = yield* tool.execute(params(), context(info.id)).pipe(Effect.forkScoped)
      yield* answerCommit(question, "Yes, replace it")
      const result = yield* Fiber.join(fiber)

      expect(result.title).toBe("Goal set")
      const stored = yield* goal.get(info.id)
      expect(stored?.generation).toBe(2)
      expect(stored?.authorized).toBe(false)
      expect(stored?.phase).toBe("dev")
      expect(stored?.turns_used).toBe(0)
      expect(stored?.status).toBe("active")

      yield* session.remove(info.id)
    }),
  )
})
