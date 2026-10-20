export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { RepoRoster } from "../repo-roster"
import { Global } from "../global"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    // ADR-0008.5 / ADR-0009: the roster, not the root's git bit — the root's
    // wrapper repo hides the real ones, and a repo-less root reads "no" with
    // repos beside it. Same discovery the snapshots use.
    const rootIsRepo = location.vcs?.type === "git"
    const repos = yield* RepoRoster.discover({
      workspace: rootIsRepo ? location.project.directory : location.directory,
      rootIsRepo,
    })
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.project.directory}`,
      `  Workspace repos: ${RepoRoster.render(repos)}`,
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
