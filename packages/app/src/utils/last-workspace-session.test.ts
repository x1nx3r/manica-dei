import { describe, expect, test } from "bun:test"
import { lastWorkspaceSession } from "./last-workspace-session"
import type { Session } from "@opencode-ai/sdk/v2/client"

const build = (over: Partial<Session> & { id: string }): Session =>
  ({ time: { created: 1_000_000 }, ...over }) as Session

describe("lastWorkspaceSession (issue #6)", () => {
  const dir = "/home/ubuntu/workspace"
  const listing: { data: Session[]; fail?: boolean } = { data: [] }
  const api = {
    list: async (input: { directory?: string }) => {
      if (listing.fail) throw new Error("server unreachable")
      if (input.directory !== dir) throw new Error(`resolver listed the wrong directory: ${input.directory}`)
      return { data: listing.data, cursor: { next: null } }
    },
  } as never

  test("the server-fetched latest root session wins; children, archived and other directories are excluded", async () => {
    listing.data = [
      build({ id: "ses_child", parentID: "ses_root2", directory: dir }),
      build({ id: "ses_archived", directory: dir, time: { created: 9_000, updated: 9_000, archived: 9_000 } }),
      build({ id: "ses_root1", directory: dir, time: { created: 8_000, updated: 8_000 } }),
      build({ id: "ses_root2", directory: dir, time: { created: 5_000, updated: 7_000 } }),
      build({ id: "ses_elsewhere", directory: "/other", time: { created: 9_999, updated: 9_999 } }),
    ]
    const found = await lastWorkspaceSession(api, { directory: dir })
    expect(found?.id).toBe("ses_root1")
  })

  test("a warm synced store answers first and skips the server entirely", async () => {
    listing.fail = true
    const found = await lastWorkspaceSession(api, {
      directory: dir,
      synced: [
        {
          path: { directory: dir },
          session: [build({ id: "ses_synced", directory: dir, time: { created: 1, updated: 1 } })],
        },
      ],
    })
    expect(found?.id).toBe("ses_synced")
    listing.fail = false
  })

  test("an empty workspace resolves undefined — the caller keeps the plain new-chat behavior", async () => {
    listing.data = []
    expect(await lastWorkspaceSession(api, { directory: dir })).toBeUndefined()
  })

  test("a server error collapses to undefined, never a throw — blank stays a legitimate landing", async () => {
    listing.fail = true
    expect(await lastWorkspaceSession(api, { directory: dir })).toBeUndefined()
    listing.fail = false
  })
})
