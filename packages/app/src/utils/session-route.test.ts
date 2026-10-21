import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import {
  legacySessionHref,
  legacySessionServer,
  requireServerKey,
  rootSession,
  sessionHref,
  workspaceSessionHref,
} from "./session-route"

describe("session routes", () => {
  test("uses the unique persisted server for a legacy session route", () => {
    expect(
      legacySessionServer(
        [{ type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" }],
        "session-1",
        ServerConnection.Key.make("server-a"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("prefers the active server when a legacy session ID is ambiguous", () => {
    expect(
      legacySessionServer(
        [
          { type: "session", server: ServerConnection.Key.make("server-a"), sessionId: "session-1" },
          { type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" },
        ],
        "session-1",
        ServerConnection.Key.make("server-b"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("a resolved workspace session targets the new layout's server route", () => {
    // Issue #22: replacing to the legacy shape leaves the legacy page mounted
    // inside the new shell. The workspace resolve has to land on the route the
    // mounted layout owns.
    expect(
      workspaceSessionHref({
        newLayout: true,
        directory: "/Users/example/project",
        sessionID: "session-1",
        server: ServerConnection.Key.make("http://127.0.0.1:4096"),
        tabs: [],
      }),
    ).toBe("/server/aHR0cDovLzEyNy4wLjAuMTo0MDk2/session/session-1")
  })

  test("a resolved workspace session keeps the server it was persisted on", () => {
    expect(
      workspaceSessionHref({
        newLayout: true,
        directory: "/Users/example/project",
        sessionID: "session-1",
        server: ServerConnection.Key.make("http://127.0.0.1:4096"),
        tabs: [
          {
            type: "session",
            server: ServerConnection.Key.make("https://other.example:4096"),
            sessionId: "session-1",
          },
        ],
      }),
    ).toBe("/server/aHR0cHM6Ly9vdGhlci5leGFtcGxlOjQwOTY/session/session-1")
  })

  test("a resolved workspace session keeps the directory route on the legacy layout", () => {
    expect(
      workspaceSessionHref({
        newLayout: false,
        directory: "/Users/example/project",
        sessionID: "session-1",
        server: ServerConnection.Key.make("http://127.0.0.1:4096"),
        tabs: [],
      }),
    ).toBe("/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1")
  })

  test("builds the legacy directory-keyed route", () => {
    expect(legacySessionHref("/Users/example/project", "session-1")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1",
    )
  })

  test("resolves the root session", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "root" },
      root: { id: "root" },
    }

    expect(
      await rootSession(sessions.child, async (id) => {
        const session = sessions[id]
        if (!session) throw new Error(`Missing session: ${id}`)
        return session
      }),
    ).toBe(sessions.root)
  })

  test("rejects a parent cycle", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "child" },
    }

    expect(rootSession(sessions.child, async (id) => sessions[id]!)).rejects.toThrow("Session parent cycle: child")
  })
})
