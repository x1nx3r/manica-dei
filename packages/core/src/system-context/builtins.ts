export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const fs = yield* FSUtil.Service
    // ADR-0008.5: the roster, not the root's git bit — the root's wrapper repo
    // hides the real ones, and a repo-less root reads "no" with repos beside
    // it. Depth-1 scan; the authoritative roster lands with ADR-0009 phase 1.
    const repos: string[] = location.vcs?.type === "git" ? [`workspace root (${location.project.directory})`] : []
    const entries = yield* fs
      .readDirectoryEntries(location.project.directory)
      .pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "directory" || entry.name === "node_modules") continue
      const isRepo = yield* fs
        .existsSafe(`${location.project.directory}/${entry.name}/.git`)
        .pipe(Effect.catch(() => Effect.succeed(false)))
      if (isRepo) repos.push(`${entry.name} (${location.project.directory}/${entry.name})`)
    }
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.project.directory}`,
      `  Workspace repos: ${repos.length ? repos.join(" · ") : "(none detected)"}`,
      `  Runtime: sandboxed container; the workspace persists, the operating system does not.`,
      `  Platform: ${process.platform}`,
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment].join("\n"),
        update: (_previous, environment) => ["The environment you are running in is now:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Today's date: ${date}`,
        update: (_previous, date) => `Today's date is now: ${date}`,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer: builtIns,
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node],
})
