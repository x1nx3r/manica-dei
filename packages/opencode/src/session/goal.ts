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
  /**
   * ADR-0006 / issue #47: the workspace snapshot at the start of the run. The
   * goal tool captures it before the agent works, so the first review can see a
   * change that was committed before the round's first step.
   */
  readonly startState?: string
  /**
   * ADR-0012: the human confirmed that this goal replaces an authorized run.
   * Without it, an authorized definition cannot be overwritten.
   */
  readonly replace?: boolean
}

export type SetResult =
  | { readonly _tag: "written"; readonly info: Info }
  | { readonly _tag: "replace-required"; readonly info: Info }

export interface Interface {
  /** Writes or replaces the goal. Never authorizes it. */
  readonly set: (input: SetInput) => Effect.Effect<SetResult>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  /**
   * The commit gate. Idempotent: an already-authorized goal is left alone.
   * A generation, when given, keeps a stale caller from authorizing a new run.
   */
  readonly authorize: (sessionID: SessionID, generation?: number) => Effect.Effect<void>
  /** Moves the goal to the phase whose role is now acting (ADR-0006). */
  readonly setPhase: (input: {
    sessionID: SessionID
    phase: SessionGoal.Phase
    generation?: number
  }) => Effect.Effect<void>
  /** Stores QA's record for the round the loop is deciding. */
  readonly setRecord: (input: {
    sessionID: SessionID
    record: SessionGoal.Record
    generation?: number
  }) => Effect.Effect<void>
  /** Clears QA's record once the loop has weighed it. */
  readonly clearRecord: (sessionID: SessionID, generation?: number) => Effect.Effect<void>
  /** Replaces the gate list, carrying each gate's retry state. */
  readonly setGates: (input: {
    sessionID: SessionID
    gates: ReadonlyArray<SessionGoal.Gate>
    generation?: number
  }) => Effect.Effect<void>
  /** The loop's terminal state: `done`, `blocked`, or `budget_exhausted`. */
  readonly setStatus: (input: {
    sessionID: SessionID
    status: SessionGoal.Status
    stopReason?: string
    generation?: number
  }) => Effect.Effect<void>
  /**
   * Counts one round against the budget when no judge verdict closes it — a
   * QA contradiction, an abstention, a stale record, or a QA pass that could
   * not run. Without this the turn budget would only count rounds the judge
   * saw, and a contradicting QA loop would escape the floor (ADR-0006, "the
   * loop has a floor").
   */
  readonly burnTurn: (sessionID: SessionID, generation?: number) => Effect.Effect<void>
  /**
   * Records one loop turn: bumps the count and stores the verdict, why, the
   * workspace state the verdict applied to, and — when there was one — the
   * judge session that delivered it, so a late client can open the ruling
   * (ADR-0008, "the seam").
   */
  readonly record: (input: {
    sessionID: SessionID
    verdict: SessionGoal.Verdict
    reason?: string
    /** The snapshot hash of the message the judge read, when there is one. */
    state?: string
    /** The judge's own session, when the judgement ran as one. */
    session?: SessionID
    generation?: number
  }) => Effect.Effect<void>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

function sameContract(left: SessionGoal.Contract | undefined, right: SessionGoal.Contract | undefined) {
  if (!left || !right) return left === right
  return (
    left.outcome === right.outcome &&
    left.verification === right.verification &&
    left.constraints === right.constraints &&
    left.boundaries === right.boundaries &&
    left.stop_when === right.stop_when
  )
}

function sameGates(left: ReadonlyArray<SessionGoal.Gate>, right: ReadonlyArray<SessionGoal.Gate>) {
  if (left.length !== right.length) return false
  return left.every((gate, index) => {
    const other = right[index]
    if (!other) return false
    return (
      gate.command === other.command &&
      gate.timeout_seconds === other.timeout_seconds &&
      gate.max_retries === other.max_retries
    )
  })
}

/**
 * ADR-0012: the definition is the goal, the contract, and the gate commands
 * with their timeouts and retry limits. Size, size reason, budget, and gate
 * attempts are run metadata, not identity.
 */
export function sameGoalDefinition(info: Info, input: Pick<SetInput, "goal" | "contract" | "gates">) {
  return (
    info.goal === input.goal && sameContract(info.contract, input.contract) && sameGates(info.gates, input.gates ?? [])
  )
}

function toInfo(row: typeof GoalTable.$inferSelect): Info {
  return {
    generation: row.generation,
    goal: row.goal,
    ...(row.size === null ? {} : { size: row.size }),
    ...(row.size_reason === null ? {} : { size_reason: row.size_reason }),
    ...(row.contract === null ? {} : { contract: row.contract }),
    gates: row.gates,
    authorized: row.authorized_at !== null,
    phase: row.phase,
    turn_budget: row.turn_budget,
    turns_used: row.turns_used,
    ...(row.last_verdict === null ? {} : { last_verdict: row.last_verdict }),
    ...(row.last_reason === null ? {} : { last_reason: row.last_reason }),
    ...(row.last_verdict_session === null || row.last_verdict_session === undefined
      ? {}
      : { last_verdict_session: row.last_verdict_session }),
    ...(row.qa_record === null ? {} : { qa_record: row.qa_record }),
    ...(row.start_state === null ? {} : { start_state: row.start_state }),
    ...(row.stop_reason === null ? {} : { stop_reason: row.stop_reason }),
    state_hash: row.state_hash,
    status: row.status,
  }
}

function progressWhere(sessionID: SessionID, generation?: number) {
  return generation === undefined
    ? eq(GoalTable.session_id, sessionID)
    : and(eq(GoalTable.session_id, sessionID), eq(GoalTable.generation, generation))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      const row = yield* db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get().pipe(Effect.orDie)
      if (!row) return undefined
      return toInfo(row)
    })

    const set = Effect.fn("Goal.set")(function* (input: SetInput) {
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const existing = row ? toInfo(row) : undefined
      const definition = {
        goal: input.goal,
        size: input.size,
        size_reason: input.sizeReason,
        contract: input.contract,
        gates: [...(input.gates ?? [])],
        turn_budget: input.turnBudget ?? DEFAULT_TURN_BUDGET,
        start_state: input.startState,
      }

      if (!existing) {
        yield* db
          .insert(GoalTable)
          .values({
            session_id: input.sessionID,
            generation: 1,
            ...definition,
            status: "active" as const,
            phase: "dev" as const,
          })
          .run()
          .pipe(Effect.orDie)
        const info = yield* get(input.sessionID)
        if (!info) return yield* Effect.die(new Error("goal row disappeared after insert"))
        return { _tag: "written" as const, info }
      }

      // ADR-0012: an authorized definition is immutable. Without the human's
      // replacement decision, keep the old row and tell the caller to ask.
      if (existing.authorized && !input.replace && !sameGoalDefinition(existing, input)) {
        return { _tag: "replace-required" as const, info: existing }
      }

      // The same definition is a restart, not a new run. Keep the phase, turns,
      // authorization, verdict, and gate attempts. Size metadata may update.
      if (existing.authorized && !input.replace && sameGoalDefinition(existing, input)) {
        const metadata = {
          ...(input.size === undefined ? {} : { size: input.size }),
          ...(input.sizeReason === undefined ? {} : { size_reason: input.sizeReason }),
        }
        if (Object.keys(metadata).length > 0) {
          yield* db
            .update(GoalTable)
            .set(metadata)
            .where(eq(GoalTable.session_id, input.sessionID))
            .run()
            .pipe(Effect.orDie)
        }
        const info = yield* get(input.sessionID)
        if (!info) return yield* Effect.die(new Error("goal row disappeared after update"))
        return { _tag: "written" as const, info }
      }

      // A replacement starts a new generation. An unauthorized revision stays
      // in the same generation because no run exists yet.
      const generation = (existing.generation ?? 1) + (input.replace ? 1 : 0)
      yield* db
        .update(GoalTable)
        .set({
          generation,
          goal: definition.goal,
          size: definition.size,
          size_reason: definition.size_reason,
          contract: definition.contract,
          gates: definition.gates,
          turn_budget: definition.turn_budget,
          authorized_at: null,
          phase: "dev" as const,
          turns_used: 0,
          last_verdict: null,
          last_reason: null,
          last_verdict_session: null,
          qa_record: null,
          start_state: definition.start_state ?? null,
          stop_reason: null,
          state_hash: null,
          status: "active" as const,
        })
        .where(eq(GoalTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      const info = yield* get(input.sessionID)
      if (!info) return yield* Effect.die(new Error("goal row disappeared after update"))
      return { _tag: "written" as const, info }
    })

    const authorize = Effect.fn("Goal.authorize")(function* (sessionID: SessionID, generation?: number) {
      // `IS NULL` makes this the first authorization and only the first. A
      // re-read or a second call cannot move the timestamp. The generation,
      // when given, keeps a stale caller from authorizing a newer run.
      yield* db
        .update(GoalTable)
        .set({ authorized_at: Date.now() })
        .where(
          and(
            eq(GoalTable.session_id, sessionID),
            ...(generation === undefined ? [] : [eq(GoalTable.generation, generation)]),
            isNull(GoalTable.authorized_at),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const setPhase = Effect.fn("Goal.setPhase")(function* (input: {
      sessionID: SessionID
      phase: SessionGoal.Phase
      generation?: number
    }) {
      yield* db
        .update(GoalTable)
        .set({ phase: input.phase })
        .where(progressWhere(input.sessionID, input.generation))
        .run()
        .pipe(Effect.orDie)
    })

    const setRecord = Effect.fn("Goal.setRecord")(function* (input: {
      sessionID: SessionID
      record: SessionGoal.Record
      generation?: number
    }) {
      yield* db
        .update(GoalTable)
        .set({ qa_record: input.record })
        .where(progressWhere(input.sessionID, input.generation))
        .run()
        .pipe(Effect.orDie)
    })

    const clearRecord = Effect.fn("Goal.clearRecord")(function* (sessionID: SessionID, generation?: number) {
      yield* db
        .update(GoalTable)
        .set({ qa_record: null })
        .where(progressWhere(sessionID, generation))
        .run()
        .pipe(Effect.orDie)
    })

    const setGates = Effect.fn("Goal.setGates")(function* (input: {
      sessionID: SessionID
      gates: ReadonlyArray<SessionGoal.Gate>
      generation?: number
    }) {
      yield* db
        .update(GoalTable)
        .set({ gates: [...input.gates] })
        .where(progressWhere(input.sessionID, input.generation))
        .run()
        .pipe(Effect.orDie)
    })

    const setStatus = Effect.fn("Goal.setStatus")(function* (input: {
      sessionID: SessionID
      status: SessionGoal.Status
      stopReason?: string
      generation?: number
    }) {
      yield* db
        .update(GoalTable)
        .set({ status: input.status, stop_reason: input.stopReason ?? null })
        .where(progressWhere(input.sessionID, input.generation))
        .run()
        .pipe(Effect.orDie)
    })

    const record = Effect.fn("Goal.record")(function* (input: {
      sessionID: SessionID
      verdict: SessionGoal.Verdict
      reason?: string
      state?: string
      session?: SessionID
      generation?: number
    }) {
      // Increment in SQL, not read-then-write: two turns must not lose one.
      yield* db
        .update(GoalTable)
        .set({
          turns_used: sql`${GoalTable.turns_used} + 1`,
          last_verdict: input.verdict,
          last_reason: input.reason ?? null,
          // The judge's own session, for the pointer a late client reads
          // (ADR-0008, "the seam"). Absent when the judgement never reached a
          // session — a transport failure, or a server predating step 3.
          last_verdict_session: input.session ?? null,
          // The workspace state this verdict applied to (ADR-0006, "state
          // binding"). Recorded here, and enforced by the record's own binding.
          state_hash: input.state ?? null,
        })
        .where(progressWhere(input.sessionID, input.generation))
        .run()
        .pipe(Effect.orDie)
    })

    const burnTurn = Effect.fn("Goal.burnTurn")(function* (sessionID: SessionID, generation?: number) {
      // A round the judge never closed still spent a turn; the budget is the
      // floor and must count it (ADR-0006, "the loop has a floor").
      yield* db
        .update(GoalTable)
        .set({ turns_used: sql`${GoalTable.turns_used} + 1` })
        .where(progressWhere(sessionID, generation))
        .run()
        .pipe(Effect.orDie)
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      yield* db.delete(GoalTable).where(eq(GoalTable.session_id, sessionID)).run().pipe(Effect.orDie)
    })

    return Service.of({
      set,
      get,
      authorize,
      setPhase,
      setRecord,
      clearRecord,
      setGates,
      setStatus,
      burnTurn,
      record,
      clear,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as Goal from "./goal"
