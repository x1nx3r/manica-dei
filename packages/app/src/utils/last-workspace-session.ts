import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SessionApi } from "@opencode-ai/client/promise"
import { latestRootSession } from "@/pages/layout/helpers"
import { listAllSessions } from "@/utils/session"

/**
 * Issue #6: an id-less workspace URL (`/{dir}/session`, no session id) means
 * "open the workspace's last session; else a new chat". The URL path consults
 * the same resolve the sidebar's `navigateToProject` runs, minus the
 * remembered-last tier: a minted URL lands cold, so the remembered tier
 * (per-layout store) is the sidebar's to use.
 *
 * The tiers, in order:
 * 1. the synced per-directory store, when the SPA is warm,
 * 2. the server's latest root session (children and archived excluded).
 * `undefined` means "fresh workspace" — the caller keeps the plain new-chat
 * behavior instead of navigating.
 */
export interface LastSessionStore {
  readonly session?: Session[]
  readonly path: { readonly directory: string }
}

export async function lastWorkspaceSession(
  api: Pick<SessionApi, "list">,
  input: { directory: string; synced?: ReadonlyArray<LastSessionStore> },
): Promise<Session | undefined> {
  const synced = input.synced?.length ? latestRootSession([...input.synced], Date.now()) : undefined
  if (synced) return synced
  const fetched = await listAllSessions(api, {
    directory: input.directory,
    parentID: null,
    order: "desc",
  }).catch(() => [] as Session[])
  return latestRootSession([{ path: { directory: input.directory }, session: fetched }], Date.now())
}
