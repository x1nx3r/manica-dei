import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { BrowserPaths } from "../../src/server/routes/instance/httpapi/groups/browser"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// ADR-0007: the browser is a process-scoped resource, and the served routes
// resolve it at process scope. This goes through the real route tree, so it
// fails if the registration is wrong.
//
// That is exactly what shipped in v0.3.2. `f7eeba1e4` made the browser a global
// node but left it in the location group, so `locations.get(ref)` stopped
// providing it and no process group had it. Every `/browser/*` route answered
// 500 with `Service not found: @opencode/v2/Browser`.
//
// `status` calls `get`, which returns undefined before anything runs and
// starts nothing, so this needs no Xvnc and no guard. The tests that missed
// the regression built their own node group with `Browser.node` already in it;
// this one asks the question that matters — can the served route resolve it?
const it = testEffect(httpApiLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("browser routes", () => {
  it.instance("status resolves the process-scoped browser", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const response = yield* requestInDirectory(BrowserPaths.status, test.directory)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ alive: false })
    }),
  )
})
