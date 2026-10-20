import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RepoRoster } from "@opencode-ai/core/repo-roster"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

// ADR-0009: the workspace is a set of repositories. The roster is declared
// names (MANUS_REPOS, the env transport) ∪ a depth-1 scan for `.git`, with the
// root present only when the location already says it is a repo. The order is
// deterministic because the composite snapshot hash is built from it.

const workspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "md-roster-"))
  await mkdir(path.join(root, "app", ".git"), { recursive: true })
  await mkdir(path.join(root, "billing", ".git"), { recursive: true })
  await mkdir(path.join(root, "docs"), { recursive: true })
  await mkdir(path.join(root, "node_modules", ".git"), { recursive: true })
  return root
}

describe("RepoRoster.declaredNames", () => {
  test("reads names from the env transport, tolerating malformed entries", () => {
    expect(RepoRoster.declaredNames({ MANUS_REPOS: JSON.stringify([{ name: "app" }, { name: "billing" }]) })).toEqual([
      "app",
      "billing",
    ])
    expect(RepoRoster.declaredNames({ MANUS_REPOS: "not json" })).toEqual([])
    expect(RepoRoster.declaredNames({ MANUS_REPOS: JSON.stringify([{ name: "../escape" }, { name: "" }, 3]) })).toEqual(
      [],
    )
    expect(RepoRoster.declaredNames({})).toEqual([])
  })
})

describe("RepoRoster.discover", () => {
  it.effect("finds depth-1 repos, skips node_modules, and never requires a root repo", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => workspace())
      const repos = yield* RepoRoster.discover({ workspace: root, rootIsRepo: false, env: {} })
      expect(repos.map((repo) => repo.key)).toEqual(["app", "billing"])
      expect(repos.find((repo) => repo.key === "app")?.worktree).toBe(path.join(root, "app"))
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }),
  )

  it.effect("includes the root when the location is a repo — and still lists the children", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => workspace())
      const repos = yield* RepoRoster.discover({ workspace: root, rootIsRepo: true, env: {} })
      expect(repos.map((repo) => repo.key)).toEqual([".", "app", "billing"])
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }),
  )

  it.effect("keeps declared repos the scan cannot see (a worktree pointer is a .git file)", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "md-roster-")))
      yield* Effect.promise(() => mkdir(path.join(root, "linked"), { recursive: true }))
      yield* Effect.promise(() => writeFile(path.join(root, "linked", ".git"), "gitdir: /elsewhere\n"))
      const env = { MANUS_REPOS: JSON.stringify([{ name: "linked" }]) }
      const repos = yield* RepoRoster.discover({ workspace: root, rootIsRepo: false, env })
      expect(repos.map((repo) => repo.key)).toEqual(["linked"])
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }),
  )

  it.effect("renders the one-line roster for prompts", () =>
    Effect.gen(function* () {
      const repos = [
        { key: ".", worktree: "/work" },
        { key: "app", worktree: "/work/app" },
      ]
      expect(RepoRoster.render(repos)).toBe("workspace root (/work) · app (/work/app)")
      expect(RepoRoster.render([])).toBe("(none detected)")
    }),
  )
})
