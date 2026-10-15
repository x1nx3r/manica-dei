import type { SessionGoalHandoff, SessionGoalInfo } from "@opencode-ai/sdk/v2/client"
import { type Accessor, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

/**
 * The judge's four verdicts — `done | blocked | continue | wait` (ADR-0006).
 *
 * Read off the projection rather than named: the generated surface calls the
 * event `SessionGoalVerdict` and the verdict `SessionGoalVerdict2`, and the
 * second name does not survive the SDK's next regeneration.
 */
export type GoalVerdict = NonNullable<SessionGoalInfo["last_verdict"]>

/**
 * Fork ADR-0008: the last judgement as the trail carried it.
 *
 * `GET /session/:id/goal` holds the verdict and its reason, but not the judge's
 * three-part handoff and not the judge's own session. Those ride the
 * `session.goal.verdict` event, so they are kept here beside the fetch rather
 * than asked of the projection twice.
 */
export type SessionGoalRuling = {
  round?: number
  verdict: GoalVerdict
  reason: string
  handoff?: SessionGoalHandoff
  /** The judge's session: the pointer the event was shipped with. */
  roleSessionID?: string
}

/**
 * How the run ended, from either source.
 *
 * A client that was present when the judge ruled has the ruling the trail
 * carried. A client that arrived after the fact has only the projection, which
 * holds the verdict and its reason — and neither the handoff nor the judge's
 * session, which is the difference the caller can see.
 */
export function goalConclusion(
  info: SessionGoalInfo,
  ruling: SessionGoalRuling | undefined,
): SessionGoalRuling | undefined {
  if (ruling) return ruling
  if (!info.last_verdict) return undefined
  return { verdict: info.last_verdict, reason: info.last_reason ?? "" }
}

/**
 * The goal's session id, read off the verdict event.
 *
 * The event carries it (ADR-0008, "the seam") and the generated type predates
 * the field, so this is one narrow cast in the same spirit as the message
 * parts': the wire has it, the type does not, and the type is regenerated on
 * its own schedule.
 */
const roleSessionID = (properties: object) => (properties as { roleSessionID?: string }).roleSessionID

/**
 * A goal projection, or nothing.
 *
 * The route answers 404 for a session the loop has not run on. It is not the only
 * way to get a body that is not a projection — a stub, a proxy or a version skew
 * can answer 200 with something else — and the strip renders on fields it needs,
 * so a body without them must read as "no goal" rather than as an empty one.
 */
export function goalProjection(value: unknown): SessionGoalInfo | undefined {
  if (!value || typeof value !== "object") return undefined
  const info = value as Partial<SessionGoalInfo>
  if (typeof info.goal !== "string" || typeof info.phase !== "string" || !Array.isArray(info.gates)) return undefined
  return info as SessionGoalInfo
}

/**
 * The projection for one session, or `undefined` — and never a rejection.
 *
 * Three things make this a function of its own, and each of them is a bug it
 * would otherwise be. The route is new, so a server that does not serve it
 * answers 404, or answers with something that is not JSON. A rejected resource
 * *throws where it is read*, which is inside the session page, so an
 * unanswerable goal would take the whole session view down with it — the
 * fixtures found that, at the price of every layout test in the suite. And the
 * projection is checked rather than trusted: a stub, a proxy or a version skew
 * can answer 200 with a body that is not a goal, and the strip renders on fields.
 */
export async function loadGoal(
  request: () => Promise<{ data?: unknown; error?: unknown }>,
): Promise<SessionGoalInfo | undefined> {
  try {
    const result = await request()
    if (result.error) return undefined
    return goalProjection(result.data)
  } catch {
    return undefined
  }
}

/**
 * A role session of the run, as `GET /session/:id/children` describes it (ADR-0008,
 * "the round"). `role` is the goal's own three words — not the agent name, which
 * the seam forbids clients from having to know.
 */
export type SessionGoalRole = {
  id: string
  title: string
  role: "qa" | "judge"
  round: number | undefined
}

/**
 * The role sessions in a children response, or nothing.
 *
 * A child with no `goal_role` label is not one of the run's roles: a task
 * subagent is a child of the same session and is not part of this list. A role
 * session from before the label existed is invisible here — the list is the
 * labeled truth, not every child there ever was.
 */
export function goalRoles(value: unknown): SessionGoalRole[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const info = entry as { id?: unknown; title?: unknown; metadata?: unknown }
    if (typeof info.id !== "string" || typeof info.title !== "string") return []
    const metadata = info.metadata && typeof info.metadata === "object" ? info.metadata : undefined
    const role = (metadata as { goal_role?: unknown } | undefined)?.goal_role
    const round = (metadata as { goal_round?: unknown } | undefined)?.goal_round
    if (role !== "qa" && role !== "judge") return []
    return [{ id: info.id, title: info.title, role, round: typeof round === "number" ? round : undefined }]
  })
}

/** The children of a session, or nothing — and never a rejection, for the same
 * reason as `loadGoal`: a rejected resource throws where it is read. */
export async function loadChildren(
  request: () => Promise<{ data?: unknown; error?: unknown }>,
): Promise<SessionGoalRole[]> {
  try {
    const result = await request()
    if (result.error) return []
    return goalRoles(result.data)
  } catch {
    return []
  }
}

/**
 * The goal loop's state for one session, for the header chip and the goal panel.
 *
 * The events are the *trigger*, not the state. A phase move, an admitted pass or
 * a judgement makes the loop refetch the projection, so the panel shows what the
 * server holds rather than an accumulation of event payloads. The one thing the
 * projection cannot give is the handoff, which is why the verdict payload is
 * kept as the ruling.
 *
 * A session the loop never ran on has no goal, and neither has a server that
 * cannot answer the question: both are a session with no goal, not an error.
 */
export function createSessionGoal(sessionID: Accessor<string | undefined>) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore<{ ruling: SessionGoalRuling | undefined }>({ ruling: undefined })

  const [goal, { refetch }] = createResource(
    () => sessionID(),
    (id) => loadGoal(() => serverSDK().client.session.goal({ sessionID: id, directory: sdk().directory })),
  )

  const [roles, { refetch: refetchRoles }] = createResource(
    () => sessionID(),
    (id) => loadChildren(() => serverSDK().client.session.children({ sessionID: id, directory: sdk().directory })),
  )

  createEffect(() => {
    const events = sdk().event
    const id = sessionID()
    // Another session is another goal, and another goal's ruling.
    setStore("ruling", undefined)
    if (!id) return

    const refresh = (event: { properties: { sessionID: string } }) => {
      if (event.properties.sessionID !== id) return
      void refetch()
      // A role appeared or moved: the children list is refetched with it.
      void refetchRoles()
    }

    const offs = [
      events.on("session.goal.phase", refresh),
      events.on("session.goal.review", refresh),
      events.on("session.goal.verdict", (event) => {
        if (event.properties.sessionID !== id) return
        const properties = event.properties
        const role = roleSessionID(properties)
        setStore("ruling", {
          round: Number(properties.round),
          verdict: properties.verdict,
          reason: properties.reason,
          ...(properties.handoff ? { handoff: properties.handoff } : {}),
          ...(role ? { roleSessionID: role } : {}),
        })
        void refetch()
        void refetchRoles()
      }),
    ]
    onCleanup(() => offs.forEach((off) => off()))
  })

  const info = createMemo(() => goal())

  return {
    /** The projection, or `undefined` for a session the loop has not run on. */
    info,
    /** The run's labeled role sessions, from the children route (ADR-0008). */
    roles: createMemo(() => roles() ?? []),
    /** The last judgement, when the trail delivered one to this client. */
    ruling: () => store.ruling,
  }
}
