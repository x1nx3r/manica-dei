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
 * `GET /session/:id/goal` holds the verdict, its reason and the judge session
 * that delivered it. The one thing it does not hold is the judge's three-part
 * handoff, which rides only the `session.goal.verdict` event — so the payload is
 * kept here beside the fetch rather than asked of the projection twice.
 */
export type SessionGoalRuling = {
  round?: number
  /** ADR-0012: the run this ruling belongs to. Absent on old servers means 1. */
  generation?: number
  verdict: GoalVerdict
  reason: string
  handoff?: SessionGoalHandoff
  /** The judge's session: the pointer the event was shipped with. */
  roleSessionID?: string
}

/**
 * One role's outcome as the trail announced it: QA's `clean`/`contradicted`,
 * or the judge's ruling. The `session.goal.review` and `goal.verdict` events
 * carry `roleSessionID`, and "The Run" rows identify their session by the same
 * id — so a row and its outcome meet, live, in the client.
 */
export type SessionGoalCheck = {
  role: "qa" | "judge"
  roleSessionID: string
  round?: number
  /** ADR-0012: the run this check belongs to. Absent means 1. */
  generation?: number
  /** The role's own words: QA's `clean`/`contradicted`, or the judge's verdict. */
  verdict: string
}

/**
 * How the run ended, from either source.
 *
 * A client that was present when the judge ruled has the ruling the trail
 * carried — the handoff and the judge session in the payload. A client that
 * arrived after the fact has the projection, which carries the verdict, its
 * reason and the judge session, but not the handoff: that is the difference the
 * caller can see.
 */
export function goalConclusion(
  info: SessionGoalInfo,
  ruling: SessionGoalRuling | undefined,
): SessionGoalRuling | undefined {
  if (ruling && (ruling.generation ?? 1) === generationOf(info.generation)) return ruling
  if (!info.last_verdict) return undefined
  return {
    verdict: info.last_verdict,
    reason: info.last_reason ?? "",
    ...(info.last_verdict_session ? { roleSessionID: info.last_verdict_session } : {}),
  }
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

/** ADR-0012: a wire number or the legacy generation 1. */
const generationOf = (value: unknown) => (typeof value === "number" ? value : 1)

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
 * One attempt at the projection, with the retry decision kept.
 *
 * `loadGoal` collapses two different answers into `undefined`: "the loop has
 * never run on this session" (a 404, final) and "the server could not answer"
 * (a booting or restarted server, worth another try). The strip renders the
 * same for both, but a client that can tell them apart heals the second
 * without a reload, so the decision lives beside the attempt.
 */
export type GoalLoadOutcome = {
  info: SessionGoalInfo | undefined
  retry: boolean
}

function goalMissing(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 2) return false
  const value = error as {
    name?: unknown
    status?: unknown
    statusCode?: unknown
    data?: unknown
    cause?: unknown
  }
  if (value.name === "NotFoundError" || value.status === 404 || value.statusCode === 404) return true
  // The generated client nests the status under `data`; a thrown fetch error
  // carries it under `cause`. Both are the same answer: the route has no goal.
  return goalMissing(value.data, depth + 1) || goalMissing(value.cause, depth + 1)
}

export async function loadGoalOutcome(
  request: () => Promise<{ data?: unknown; error?: unknown }>,
): Promise<GoalLoadOutcome> {
  try {
    const result = await request()
    if (result.error) return { info: undefined, retry: !goalMissing(result.error) }
    const data = result.data
    // The route answers 200 with `{ has_goal: false }` for a session that has
    // no goal. That is a fact, not a failed request: retrying it would turn a
    // normal state into a poll (issue #35). The bare shapes keep older servers
    // readable.
    if (data && typeof data === "object" && "has_goal" in data) {
      const response = data as { has_goal?: unknown; projection?: unknown }
      if (response.has_goal !== true) return { info: undefined, retry: false }
      const info = goalProjection(response.projection)
      return { info, retry: info === undefined }
    }
    if (data === null) return { info: undefined, retry: false }
    const info = goalProjection(data)
    // A 200 that is not a projection is a stub, a proxy or a version skew, and
    // it can be either permanent or a server mid-restart: retry it on the same
    // capped schedule rather than guess.
    return { info, retry: info === undefined }
  } catch (error) {
    return { info: undefined, retry: !goalMissing(error) }
  }
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
  return (await loadGoalOutcome(request)).info
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
  /** ADR-0012: the run this role belongs to. Absent means 1. */
  generation?: number
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
    const generation = (metadata as { goal_generation?: unknown } | undefined)?.goal_generation
    if (role !== "qa" && role !== "judge") return []
    return [
      {
        id: info.id,
        title: info.title,
        role,
        round: typeof round === "number" ? round : undefined,
        ...(typeof generation === "number" ? { generation } : {}),
      },
    ]
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
  const [store, setStore] = createStore<{
    ruling: SessionGoalRuling | undefined
    checks: SessionGoalCheck[]
  }>({ ruling: undefined, checks: [] })

  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempts = 0

  function clearRetry() {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  // One second, then doubling to half a minute. The strip is absent either way,
  // so the wait costs nothing; what it buys is a client that loaded while the
  // agent was still booting, which used to stay empty until a turn fired an
  // event — the "only populated after a turn" that is really fetch-once-and-
  // forget.
  function scheduleRetry() {
    clearRetry()
    const delay = Math.min(1000 * 2 ** retryAttempts, 30_000)
    retryAttempts = Math.min(retryAttempts + 1, 5)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void refetchGoal()
    }, delay)
  }

  // The strip is a footer, not a precondition for the session. Reading the
  // resources directly would register their pending fetches with the session
  // page's Suspense boundary: every goal or children refetch would unmount the
  // whole page, including an open file tab. The `.latest` accessor of a
  // resource with an initial value never reads through the boundary, so a
  // refetch keeps the previous strip while it runs. The wrappers carry the
  // session id because a resource keeps its old value across a source change;
  // the memos below hide the previous session's data until the new fetch lands.
  type GoalProjection = { sessionID: string; info: SessionGoalInfo | undefined }
  type GoalRoles = { sessionID: string; roles: SessionGoalRole[] }
  const noRoles: SessionGoalRole[] = []

  const [goal, { refetch: refetchGoal }] = createResource(
    () => sessionID(),
    async (id): Promise<GoalProjection | null> => {
      if (!id) return null
      const outcome = await loadGoalOutcome(() =>
        serverSDK().client.session.goal({ sessionID: id, directory: sdk().directory }),
      )
      if (outcome.info) retryAttempts = 0
      if (outcome.retry) scheduleRetry()
      else clearRetry()
      return { sessionID: id, info: outcome.info }
    },
    { initialValue: null },
  )

  const [roles, { refetch: refetchRoles }] = createResource(
    () => sessionID(),
    async (id): Promise<GoalRoles | null> => {
      if (!id) return null
      const list = await loadChildren(() =>
        serverSDK().client.session.children({ sessionID: id, directory: sdk().directory }),
      )
      return { sessionID: id, roles: list }
    },
    { initialValue: null },
  )

  const info = createMemo(() => {
    const value = goal.latest
    if (!value || value.sessionID !== sessionID()) return undefined
    return value.info
  })
  const roleList = createMemo(() => {
    const value = roles.latest
    if (!value || value.sessionID !== sessionID()) return noRoles
    const generation = generationOf(info()?.generation)
    return value.roles.filter((role) => (role.generation ?? 1) === generation)
  })

  // A page that outlives a container restart keeps its DOM and loses its
  // stream: the one projection fetch it missed is never asked again unless a
  // turn moves. Coming back to the tab, or regaining the network, is the
  // client's own evidence that the server may answer now, so it re-asks —
  // the same resync law as the session self-heal.
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    const resync = () => {
      if (!sessionID()) return
      void refetchGoal()
      void refetchRoles()
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") resync()
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", resync)
    window.addEventListener("online", resync)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", resync)
      window.removeEventListener("online", resync)
      clearRetry()
    })
  } else {
    onCleanup(clearRetry)
  }

  let observedGeneration: number | undefined

  createEffect(() => {
    const events = sdk().event
    const id = sessionID()
    // Another session is another goal, and another goal's ruling. The retry
    // schedule belongs to the old session's hole, not the new one's.
    setStore("ruling", undefined)
    setStore("checks", [])
    observedGeneration = undefined
    clearRetry()
    retryAttempts = 0
    if (!id) return

    // ADR-0012: a new generation is a new run. Clear the old ruling and checks
    // when the projection changes identity, even if the session id is the same.
    createEffect(() => {
      const current = info()
      const generation = generationOf(current?.generation)
      if (observedGeneration === undefined) {
        observedGeneration = generation
        return
      }
      if (observedGeneration === generation) return
      observedGeneration = generation
      setStore("ruling", undefined)
      setStore("checks", [])
    })

    // A click that arrived after the fact: the projection carries the judge's
    // verdict and its session, so the run's judge row wears its outcome even
    // when the client was not present for the judgement. The events are the
    // precise trail and the projection is the row's own truth.
    createEffect(() => {
      const latest = info()
      if (!latest) return
      const verdictSession = latest.last_verdict_session
      const verdict = latest.last_verdict
      if (!verdictSession || !verdict) return
      setStore("checks", (list) => [
        ...list.filter((item) => item.roleSessionID !== verdictSession),
        {
          role: "judge" as const,
          roleSessionID: verdictSession,
          verdict,
          generation: generationOf(latest.generation),
        },
      ])
    })

    const refresh = (event: { properties: { sessionID: string } }) => {
      if (event.properties.sessionID !== id) return
      void refetchGoal()
      // A role appeared or moved: the children list is refetched with it.
      void refetchRoles()
    }

    // The trail carries the outcome; the run's rows display it. Both the review
    // and the verdict announce their role session, which is the id "The Run"
    // identifies a row by — so a row and its outcome meet live.
    const announce = (role: "qa" | "judge") => (event: { properties: Record<string, unknown> }) => {
      const properties = event.properties as {
        sessionID?: string
        roleSessionID?: string
        round?: number | "NaN" | "Infinity" | "-Infinity"
        generation?: number | "NaN" | "Infinity" | "-Infinity"
        verdict?: string
      }
      if (properties.sessionID !== id) return
      const roleSessionID = properties.roleSessionID
      const announcedVerdict = properties.verdict
      if (!roleSessionID || typeof announcedVerdict !== "string") return
      setStore("checks", (list) => [
        ...list.filter((item) => item.roleSessionID !== roleSessionID),
        {
          role,
          roleSessionID,
          round: typeof properties.round === "number" ? properties.round : undefined,
          generation: typeof properties.generation === "number" ? properties.generation : 1,
          verdict: announcedVerdict,
        },
      ])
      void refetchRoles()
    }

    const offs = [
      // A goal event is the precise trigger, and a message or session event is
      // the blunt one — a goal set between messages still lands within one
      // round-trip even if the goal-event leg ever failed.
      events.on("session.goal.phase", refresh),
      events.on("session.goal.review", announce("qa")),
      events.on("session.goal.verdict", (event) => {
        if (event.properties.sessionID !== id) return
        const properties = event.properties
        const role = roleSessionID(properties)
        setStore("ruling", {
          round: Number(properties.round),
          generation: typeof properties.generation === "number" ? properties.generation : 1,
          verdict: properties.verdict,
          reason: properties.reason,
          ...(properties.handoff ? { handoff: properties.handoff } : {}),
          ...(role ? { roleSessionID: role } : {}),
        })
        // The judgement is a check like any other: it appears beside the session's rows.
        announce("judge")(event)
        void refetchGoal()
      }),
    ]
    // The blunt refetches, typed on the same bus so the compiler stays honest,
    // at most once a second, because they fire on message traffic and not on
    // goal moves. Registered beside the goal events and deregistered with them.
    let lastLoose = 0
    const looseRefetch = (event: { properties: { sessionID?: string } }) => {
      // The bus carries every session in the directory. A child or unrelated
      // session must not make the active session ask for its goal (issue #35);
      // the goal-specific events below already filter the same way.
      if (event.properties.sessionID !== id) return
      if (Date.now() - lastLoose < 1000) return
      lastLoose = Date.now()
      void refetchGoal()
      void refetchRoles()
    }
    offs.push(events.on("session.created", looseRefetch), events.on("session.updated", looseRefetch))
    onCleanup(() => offs.forEach((off) => off()))
  })

  return {
    /** The projection, or `undefined` for a session the loop has not run on. */
    info,
    /** The run's labeled role sessions, from the children route (ADR-0008). */
    roles: roleList,
    /** Each role's outcome as the trail announced it, keyed by the role's session. */
    checks: () => {
      const generation = generationOf(info()?.generation)
      return store.checks.filter((item) => (item.generation ?? 1) === generation)
    },
    /** The last judgement, when the trail delivered one for the current run. */
    ruling: () => {
      const generation = generationOf(info()?.generation)
      const ruling = store.ruling
      return ruling && (ruling.generation ?? 1) === generation ? ruling : undefined
    },
  }
}
