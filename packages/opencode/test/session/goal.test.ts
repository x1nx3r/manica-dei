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
      })

      expect(yield* goal.get(info.id)).toEqual({
        goal: "add the widget",
        size: "medium",
        size_reason: "a few reversible choices",
        contract,
        gates: [gate],
        authorized: false,
        turn_budget: 12,
        turns_used: 0,
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

  it.instance("authorize stamps once — a second call and a re-set leave it", () =>
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
      yield* goal.set({ sessionID: info.id, goal: "add the widget, revised" })

      expect(yield* authorizedAt(info.id)).toBe(first)

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
