import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

export function legacySessionHref(directory: string, sessionID: string) {
  return `/${base64Encode(directory)}/session/${sessionID}`
}

/**
 * The canonical session route for the layout that is mounted.
 *
 * The new layout keeps sessions at `/server/<key>/session/<id>`; the legacy
 * layout keeps `/<dir>/session/<id>`. A workspace URL resolves its last
 * session in place (issue #6), so the resolve must target the layout's own
 * route. Replacing to the legacy shape makes the route's layout decision
 * happen one navigation too late: the legacy page mounts inside the new
 * shell and shrinks to its content width (issue #22).
 */
export function workspaceSessionHref(input: {
  newLayout: boolean
  directory: string
  sessionID: string
  server: ServerConnection.Key
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[]
}) {
  if (!input.newLayout) return legacySessionHref(input.directory, input.sessionID)
  return sessionHref(legacySessionServer(input.tabs, input.sessionID, input.server), input.sessionID)
}

export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)
  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")
  return ServerConnection.Key.make(key)
}

export function legacySessionServer(
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[],
  sessionID: string,
  active: ServerConnection.Key,
) {
  const matches = tabs.filter((tab) => tab.sessionId === sessionID)
  return matches.find((tab) => tab.server === active)?.server ?? (matches.length === 1 ? matches[0]?.server : active)
}

type SessionParent = { id: string; parentID?: string }

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session
  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Session parent cycle: ${current.parentID}`)
    seen.add(current.parentID)
    current = await get(current.parentID)
  }
  return current
}
