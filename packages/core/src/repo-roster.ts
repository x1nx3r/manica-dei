export * as RepoRoster from "./repo-roster"

import path from "path"
import { readdirSync, statSync, type Dirent } from "fs"
import { Effect } from "effect"

/**
 * ADR-0009: the workspace is a set of repositories. The roster is the union of
 * what the summon declared (`MANUS_REPOS`, the env transport) and what a
 * depth-1 scan finds (a directory that owns a `.git` — file or directory, so
 * worktree pointers count). The workspace root joins the roster when the
 * location already says it is a repo; it is never required to be one.
 *
 * Discovery is *round-living*: callers re-run it at each round boundary rather
 * than freezing it at layer build — a repo cloned into a live workspace must
 * be tracked by the next round, not the next summon (the ADR-0007 lesson,
 * applied to git).
 *
 * Deliberately plain node fs: the roster is a scan, not a service, and it is
 * called from prompt assembly, snapshot capture and tests alike. Effect is
 * only the wrapper.
 */
export const ROOT_KEY = "."

export interface Repo {
  /** Workspace-relative key: "." for the root repo, else the folder name. */
  readonly key: string
  /** Absolute worktree of the repository. */
  readonly worktree: string
}

export interface DiscoverInput {
  /** The workspace root (the session's project directory). */
  readonly workspace: string
  /** Whether the location itself is a git repo. */
  readonly rootIsRepo: boolean
  /** Env source; defaults to process.env. */
  readonly env?: Record<string, string | undefined>
}

/** The declared repo names from `MANUS_REPOS`; malformed entries are ignored. */
export function declaredNames(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.MANUS_REPOS?.trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const name = (item as { name?: unknown }).name
    if (typeof name !== "string") return []
    const trimmed = name.trim()
    // One plain segment: no traversal, no absolute paths.
    if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) return []
    return [trimmed]
  })
}

const isDir = (target: string) => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

const exists = (target: string) => {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * Discover the workspace's repositories. Sorted by key so the roster (and the
 * composite snapshot hash built from it) is deterministic.
 */
export const discover = (input: DiscoverInput) =>
  // Synchronous by design: a depth-1 scan is a handful of stats, and capture
  // runs inside the step loop where an added async hop re-orders part updates
  // (the roster must cost no scheduling).
  Effect.sync(() => {
    const found = new Map<string, string>()
    const add = (key: string, worktree: string) => {
      if (!found.has(key)) found.set(key, worktree)
    }

    if (input.rootIsRepo) add(ROOT_KEY, input.workspace)

    // Declared first: the manifest's names are the roster's contract, and a
    // declared repo wins the key even if the scan would list it too.
    for (const name of declaredNames(input.env ?? process.env)) {
      const worktree = path.join(input.workspace, name)
      if (isDir(worktree)) add(name, worktree)
    }

    let entries: Dirent[] = []
    try {
      entries = readdirSync(input.workspace, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const worktree = path.join(input.workspace, entry.name)
      if (exists(path.join(worktree, ".git"))) add(entry.name, worktree)
    }

    return [...found.entries()]
      .map(([key, worktree]) => ({ key, worktree }) satisfies Repo)
      .toSorted((a, b) => a.key.localeCompare(b.key))
  })

/** One-line roster for prompts: `app (/workspace/app) · billing (…)`. */
export function render(repos: readonly Repo[]): string {
  if (!repos.length) return "(none detected)"
  return repos.map((repo) => `${repo.key === ROOT_KEY ? "workspace root" : repo.key} (${repo.worktree})`).join(" · ")
}
