import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { GoalTable } from "@opencode-ai/core/session/sql"
import { SessionGoal } from "@opencode-ai/schema/session-goal"

// Fork ADR-0006: one goal per session, persisted so a reconnect or a restart
// does not lose an authorized run. The commit gate is `authorized`: a goal that
// is set but not authorized never runs the loop.

export const Info = SessionGoal.Info
export type Info = SessionGoal.Info

/** The loop's backstop when the commit does not name its own budget. */
export const DEFAULT_TURN_BUDGET = 50

export interface SetInput {
  readonly sessionID: SessionID
  readonly goal: string
  readonly size?: SessionGoal.Size
  readonly sizeReason?: string
  readonly contract?: SessionGoal.Contract
  readonly gates?: ReadonlyArray<SessionGoal.Gate>
  readonly turnBudget?: number
}

export interface Interface {
  /** Writes or replaces the goal. Never authorizes it. */
  readonly set: (input: SetInput) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  /** The commit gate. Idempotent: an already-authorized goal is left alone. */
  readonly authorize: (sessionID: SessionID) => Effect.Effect<void>
  /** Records one loop turn: bumps the count and stores the verdict. */
  readonly record: (input: { sessionID: SessionID; verdict: SessionGoal.Verdict }) => Effect.Effect<void>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const set = Effect.fn("Goal.set")(function* (input: SetInput) {
      const values = {
        session_id: input.sessionID,
        goal: input.goal,
        size: input.size,
        size_reason: input.sizeReason,
        contract: input.contract,
        gates: [...(input.gates ?? [])],
        turn_budget: input.turnBudget ?? DEFAULT_TURN_BUDGET,
        status: "active" as const,
      }
      yield* db
        .insert(GoalTable)
        .values(values)
        // Re-setting a goal updates it but must not re-authorize or reset the
        // loop's progress: `authorized_at`, `turns_used`, and `last_verdict`
        // stay as they were.
        .onConflictDoUpdate({
          target: GoalTable.session_id,
          set: {
            goal: values.goal,
            size: values.size,
            size_reason: values.size_reason,
            contract: values.contract,
            gates: values.gates,
            turn_budget: values.turn_budget,
            status: values.status,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      const row = yield* db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get().pipe(Effect.orDie)
      if (!row) return undefined
      return {
        goal: row.goal,
        ...(row.size === null ? {} : { size: row.size }),
        ...(row.size_reason === null ? {} : { size_reason: row.size_reason }),
        ...(row.contract === null ? {} : { contract: row.contract }),
        gates: row.gates,
        authorized: row.authorized_at !== null,
        turn_budget: row.turn_budget,
        turns_used: row.turns_used,
        ...(row.last_verdict === null ? {} : { last_verdict: row.last_verdict }),
        status: row.status,
      } satisfies Info
    })

    const authorize = Effect.fn("Goal.authorize")(function* (sessionID: SessionID) {
      // `IS NULL` makes this the first authorization and only the first. A
      // re-read or a second call cannot move the timestamp.
      yield* db
        .update(GoalTable)
        .set({ authorized_at: Date.now() })
        .where(and(eq(GoalTable.session_id, sessionID), isNull(GoalTable.authorized_at)))
        .run()
        .pipe(Effect.orDie)
    })

    const record = Effect.fn("Goal.record")(function* (input: {
      sessionID: SessionID
      verdict: SessionGoal.Verdict
    }) {
      // Increment in SQL, not read-then-write: two turns must not lose one.
      yield* db
        .update(GoalTable)
        .set({ turns_used: sql`${GoalTable.turns_used} + 1`, last_verdict: input.verdict })
        .where(eq(GoalTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      yield* db.delete(GoalTable).where(eq(GoalTable.session_id, sessionID)).run().pipe(Effect.orDie)
    })

    return Service.of({ set, get, authorize, record, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as Goal from "./goal"
