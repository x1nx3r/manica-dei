import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { GoalTable } from "@opencode-ai/core/session/sql"
import { Session as SessionNs } from "@/session/session"
import { Goal } from "@/session/goal"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { testEffect } from "../lib/effect"

// Fork ADR-0006, M1: the durable goal record. The service is the only writer;
// the DB is in-memory and migrated (`test/preload.ts` sets OPENCODE_DB).
//
// A goal has a foreign key to its session, so every case creates a real one.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Goal.node,
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
  command: "bun test widget",
  timeout_seconds: 300,
  max_retries: 3,
  attempts: 0,
  last_exit_code: null,
  last_output_tail: "",
}

/** The raw `authorized_at`, which the service deliberately does not expose. */
const authorizedAt = (sessionID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ at: GoalTable.authorized_at })
      .from(GoalTable)
      .where(eq(GoalTable.session_id, sessionID as never))
      .get()
      .pipe(Effect.orDie)
    return row?.at ?? null
  })

describe("session.goal", () => {
  it.instance("round-trips every field", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({
        sessionID: info.id,
        goal: "add the widget",
        size: "medium",
        sizeReason: "a few reversible choices",
        contract,
        gates: [gate],
        turnBudget: 12,
        startState: "start-1",
      })

      expect(yield* goal.get(info.id)).toEqual({
        generation: 1,
        goal: "add the widget",
        size: "medium",
        size_reason: "a few reversible choices",
        contract,
        gates: [gate],
        authorized: false,
        phase: "dev",
        turn_budget: 12,
        turns_used: 0,
        start_state: "start-1",
        state_hash: null,
        status: "active",
      })

      yield* session.remove(info.id)
    }),
  )

  it.instance("a fresh goal is not authorized, and authorize is the commit gate", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      expect((yield* goal.get(info.id))?.authorized).toBe(false)

      yield* goal.authorize(info.id)
      expect((yield* goal.get(info.id))?.authorized).toBe(true)

      yield* session.remove(info.id)
    }),
  )

  it.instance("authorize stamps once, and an authorized definition cannot change without replace", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      const first = yield* authorizedAt(info.id)
      expect(first).not.toBeNull()

      // Past the millisecond boundary, so a non-idempotent second stamp would
      // differ rather than coincidentally match.
      yield* Effect.sleep("5 millis")
      yield* goal.authorize(info.id)
      const refused = yield* goal.set({ sessionID: info.id, goal: "add the widget, revised" })

      // A different definition on an authorized run is a replacement, and the
      // service refuses it without the human's decision.
      expect(refused._tag).toBe("replace-required")
      expect((yield* goal.get(info.id))?.goal).toBe("add the widget")
      expect(yield* authorizedAt(info.id)).toBe(first)

      // The same definition is a restart and is idempotent.
      const unchanged = yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      expect(unchanged._tag).toBe("written")
      expect(yield* authorizedAt(info.id)).toBe(first)

      yield* session.remove(info.id)
    }),
  )

  it.instance("an unauthorized goal can be revised in place", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      const result = yield* goal.set({ sessionID: info.id, goal: "add the widget, revised" })
      expect(result._tag).toBe("written")

      const stored = yield* goal.get(info.id)
      expect(stored?.generation).toBe(1)
      expect(stored?.goal).toBe("add the widget, revised")
      expect(stored?.authorized).toBe(false)
      expect(stored?.phase).toBe("dev")
      expect(stored?.turns_used).toBe(0)

      yield* session.remove(info.id)
    }),
  )

  it.instance("turns_used increments and last_verdict persists", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.record({ sessionID: info.id, verdict: "continue" })
      yield* goal.record({ sessionID: info.id, verdict: "wait" })

      const stored = yield* goal.get(info.id)
      expect(stored?.turns_used).toBe(2)
      expect(stored?.last_verdict).toBe("wait")

      yield* session.remove(info.id)
    }),
  )

  it.instance("the phase and state survive a restart, and a confirmed replace resets them", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      yield* goal.setPhase({ sessionID: info.id, phase: "qa" })
      yield* goal.record({ sessionID: info.id, verdict: "continue", state: "hash-1" })

      expect((yield* goal.get(info.id))?.phase).toBe("qa")
      expect((yield* goal.get(info.id))?.state_hash).toBe("hash-1")

      // The same definition is a restart: the phase and state must survive it.
      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      expect((yield* goal.get(info.id))?.phase).toBe("qa")
      expect((yield* goal.get(info.id))?.state_hash).toBe("hash-1")

      // A changed definition after authorization needs the human's replace.
      const refused = yield* goal.set({ sessionID: info.id, goal: "add the widget, revised" })
      expect(refused._tag).toBe("replace-required")
      expect((yield* goal.get(info.id))?.phase).toBe("qa")

      const replaced = yield* goal.set({ sessionID: info.id, goal: "add the widget, revised", replace: true })
      expect(replaced._tag).toBe("written")
      const stored = yield* goal.get(info.id)
      expect(stored?.generation).toBe(2)
      expect(stored?.authorized).toBe(false)
      expect(stored?.phase).toBe("dev")
      expect(stored?.turns_used).toBe(0)
      expect(stored?.last_verdict).toBeUndefined()
      expect(stored?.state_hash).toBeNull()

      yield* session.remove(info.id)
    }),
  )

  it.instance("a replacement resets the old run, its gates, and the verdict", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})
      const oldGate = { ...gate, attempts: 2, last_exit_code: 1, last_output_tail: "failed" }
      const newGate = { ...gate, command: "bun test another-widget" }
      const newContract = { ...contract, outcome: "the other widget renders" }

      yield* goal.set({
        sessionID: info.id,
        goal: "add the widget",
        contract,
        gates: [oldGate],
        turnBudget: 12,
        startState: "start-old",
      })
      yield* goal.authorize(info.id)
      yield* goal.record({
        sessionID: info.id,
        verdict: "done",
        reason: "the widget renders",
        state: "hash-1",
        session: "ses_judge" as never,
      })
      yield* goal.setPhase({ sessionID: info.id, phase: "judge" })
      yield* goal.setStatus({
        sessionID: info.id,
        status: "budget_exhausted",
        stopReason: "the old run ran out of turns",
      })

      const refused = yield* goal.set({
        sessionID: info.id,
        goal: "add another widget",
        contract: newContract,
        gates: [newGate],
        startState: "start-new",
      })
      expect(refused._tag).toBe("replace-required")
      expect((yield* goal.get(info.id))?.goal).toBe("add the widget")

      const replaced = yield* goal.set({
        sessionID: info.id,
        goal: "add another widget",
        contract: newContract,
        gates: [newGate],
        turnBudget: 20,
        startState: "start-new",
        replace: true,
      })
      expect(replaced._tag).toBe("written")

      const stored = yield* goal.get(info.id)
      expect(stored?.generation).toBe(2)
      expect(stored?.goal).toBe("add another widget")
      expect(stored?.contract).toEqual(newContract)
      expect(stored?.authorized).toBe(false)
      expect(stored?.phase).toBe("dev")
      expect(stored?.turns_used).toBe(0)
      expect(stored?.turn_budget).toBe(20)
      expect(stored?.last_verdict).toBeUndefined()
      expect(stored?.last_reason).toBeUndefined()
      expect(stored?.last_verdict_session).toBeUndefined()
      expect(stored?.state_hash).toBeNull()
      expect(stored?.start_state).toBe("start-new")
      expect(stored?.stop_reason).toBeUndefined()
      expect(stored?.status).toBe("active")
      expect(stored?.gates).toEqual([{ ...newGate, attempts: 0, last_exit_code: null, last_output_tail: "" }])

      // A late write from the old generation cannot move the new run.
      yield* goal.setPhase({ sessionID: info.id, phase: "qa", generation: 1 })
      yield* goal.record({ sessionID: info.id, verdict: "done", generation: 1 })
      yield* goal.burnTurn(info.id, 1)
      yield* goal.setStatus({ sessionID: info.id, status: "done", generation: 1 })
      const after = yield* goal.get(info.id)
      expect(after?.phase).toBe("dev")
      expect(after?.turns_used).toBe(0)
      expect(after?.last_verdict).toBeUndefined()
      expect(after?.status).toBe("active")

      yield* session.remove(info.id)
    }),
  )

  it.instance("a budget stop survives a restart and a replacement clears it", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* goal.authorize(info.id)
      yield* goal.setStatus({
        sessionID: info.id,
        status: "budget_exhausted",
        stopReason: "the turn budget is spent",
      })

      const stopped = yield* goal.get(info.id)
      expect(stopped?.status).toBe("budget_exhausted")
      expect(stopped?.stop_reason).toBe("the turn budget is spent")

      // A restart of the same definition keeps the terminal state.
      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      const restarted = yield* goal.get(info.id)
      expect(restarted?.status).toBe("budget_exhausted")
      expect(restarted?.stop_reason).toBe("the turn budget is spent")

      // The replacement starts a fresh run and clears the stop reason.
      yield* goal.set({ sessionID: info.id, goal: "add another widget", replace: true })
      const replaced = yield* goal.get(info.id)
      expect(replaced?.status).toBe("active")
      expect(replaced?.stop_reason).toBeUndefined()

      yield* session.remove(info.id)
    }),
  )

  it.instance("two sessions have independent goals, and clear removes one", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const a = yield* session.create({})
      const b = yield* session.create({})

      yield* goal.set({ sessionID: a.id, goal: "A" })
      yield* goal.set({ sessionID: b.id, goal: "B" })
      expect((yield* goal.get(a.id))?.goal).toBe("A")
      expect((yield* goal.get(b.id))?.goal).toBe("B")

      yield* goal.clear(a.id)
      expect(yield* goal.get(a.id)).toBeUndefined()
      expect((yield* goal.get(b.id))?.goal).toBe("B")

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("removing a session removes its goal (FK cascade)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const info = yield* session.create({})

      yield* goal.set({ sessionID: info.id, goal: "add the widget" })
      yield* session.remove(info.id)

      expect(yield* goal.get(info.id)).toBeUndefined()
    }),
  )
})
