import { describe, expect, test } from "bun:test"
import { Browser } from "@opencode-ai/core/browser"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"

// ADR-0003: the session browser lifecycle. Xvnc is the display server and the
// RFB server in one process, and Chromium renders into it headfully.
//
// Spawns real processes, so it is guarded: it must pass when the guard is set
// on a machine with Xvnc and chromium installed, and skip silently otherwise.

const guard = process.env.MANUS_INTEGRATION === "1"
const hasBin = (name: string) => Bun.spawnSync(["which", name]).exitCode === 0
const skip = !guard || !hasBin("Xvnc") || !hasBin("chromium")
const reason = skip ? (!guard ? "set MANUS_INTEGRATION=1" : "Xvnc or chromium not installed") : undefined

describe.skipIf(skip)(reason ? `${reason} (browser lifecycle)` : "browser lifecycle", () => {
  test("ensure is idempotent, the RFB port answers, stop tears it down", async () => {
    const runtime = makeRuntime(Browser.Service, LayerNode.compile(Browser.node))
    try {
      const first = await runtime.runPromise((s) => s.ensure)
      expect(first.display).toBeGreaterThan(999)

      // ensure twice returns the same running browser, not a second one.
      const second = await runtime.runPromise((s) => s.ensure)
      expect(second.display).toBe(first.display)

      // The RFB port answers with the protocol banner.
      expect(await readRfbBanner(first.rfbPort)).toContain("RFB")

      // Stop clears state, and the RFB listener goes away.
      await runtime.runPromise((s) => s.stop)
      expect(await runtime.runPromise((s) => s.get)).toBeUndefined()
      expect(await readRfbBanner(first.rfbPort)).toBe("ERR")
    } finally {
      // The finalizer ran on scope close, but close it again in case the
      // runtime outlives the test.
      try {
        await runtime.runPromise((s) => s.stop)
      } catch {}
    }
  })
})

function readRfbBanner(port: number): Promise<string> {
  return new Promise((resolve) => {
    const net = require("node:net")
    const s = net.connect({ host: "127.0.0.1", port })
    const fail = () => resolve("ERR")
    s.setTimeout(500, fail)
    s.on("data", (d: Buffer) => {
      resolve(d.toString("latin1").slice(0, 12))
      s.destroy()
    })
    s.on("error", fail)
  })
}
