import { describe, expect, test } from "bun:test"
import { Browser } from "@opencode-ai/core/browser"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"

// ADR-0003: the agent drives the session browser over CDP, so the service has
// to hand back a client that actually reaches the Chromium it launched.
//
// Guarded like the other browser tests: passes with Xvnc and chromium present,
// skips silently otherwise.

const guard = process.env.MANUS_INTEGRATION === "1"
const hasBin = (name: string) => Bun.spawnSync(["which", name]).exitCode === 0
const skip = !guard || !hasBin("Xvnc") || !hasBin("chromium")

describe.skipIf(skip)("browser cdp", () => {
  test("the client reaches the launched browser", async () => {
    const runtime = makeRuntime(Browser.Service, LayerNode.compile(Browser.node))
    try {
      await runtime.runPromise((s) => s.ensure)

      // cdp is undefined until the browser is up, and present after.
      const client = await runtime.runPromise((s) => s.cdp)
      expect(client).toBeDefined()

      const version = (await client!.send("Browser.getVersion")) as { product: string }
      expect(version.product).toContain("Chrome/")

      // A page-scoped call needs a session, which is the next layer up. Prove
      // the flat call works and that the client survives it.
      expect(client!.closed()).toBe(false)
    } finally {
      try {
        await runtime.runPromise((s) => s.stop)
      } catch {}
    }
  }, 30_000)

  test("cdp is undefined before the browser runs and after stop", async () => {
    const runtime = makeRuntime(Browser.Service, LayerNode.compile(Browser.node))
    try {
      expect(await runtime.runPromise((s) => s.cdp)).toBeUndefined()
      await runtime.runPromise((s) => s.ensure)
      expect(await runtime.runPromise((s) => s.cdp)).toBeDefined()
      await runtime.runPromise((s) => s.stop)
      expect(await runtime.runPromise((s) => s.cdp)).toBeUndefined()
    } finally {
      try {
        await runtime.runPromise((s) => s.stop)
      } catch {}
    }
  }, 30_000)
})
