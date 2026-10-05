import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Browser } from "@opencode-ai/core/browser"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// ADR-0003: one Chromium per session, and a session is a container. The browser
// is a container-level resource, so it must be keyed per process, not per
// location. It was a location node, and the pane and the tool could resolve
// different directories — each got its own service, its own random display, and
// its own Xvnc/Chromium, neither aware of the other. Two complete stacks, and
// `/browser/status` reporting `alive` throughout.
//
// This is the regression for that: two locations must resolve the *same*
// browser service. If the node goes back to location keying, the two yields
// below are different instances and this fails.

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Browser.node, LocationServiceMap.node])),
)

describe("Browser location keying", () => {
  it.live("one browser per process, not per location", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([a, b]) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const refA = Location.Ref.make({ directory: AbsolutePath.make(a.path) })
          const refB = Location.Ref.make({ directory: AbsolutePath.make(b.path) })

          const one = yield* Browser.Service.pipe(Effect.provide(locations.get(refA)))
          const two = yield* Browser.Service.pipe(Effect.provide(locations.get(refB)))

          expect(one).toBe(two)
        }),
      ),
    ),
  )
})
