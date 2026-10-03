import { describe, expect, test } from "bun:test"
import { Browser } from "@opencode-ai/core/browser"
import { connectPage } from "@opencode-ai/core/browser/cdp-session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"

// ADR-0003: the agent's vocabulary must actually drive the shared browser.
// This exercises the same path the tools use, against a real Chromium, without
// standing up the whole tool registry.
//
// Guarded like the other browser tests.

const guard = process.env.MANUS_INTEGRATION === "1"
const hasBin = (name: string) => Bun.spawnSync(["which", name]).exitCode === 0
const skip = !guard || !hasBin("Xvnc") || !hasBin("chromium")

describe.skipIf(skip)("browser page session", () => {
  test("attach drives the page, and the human sees the same document", async () => {
    const runtime = makeRuntime(Browser.Service, LayerNode.compile(Browser.node))
    const page = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<title>spike</title><h1>hello</h1>", { headers: { "content-type": "text/html" } }),
    })
    try {
      await runtime.runPromise((s) => s.ensure)
      const endpoint = await runtime.runPromise((s) => s.endpoint)
      expect(endpoint).toBeDefined()

      // Page commands live on the page's own socket, so connect that.
      const session = await connectPage(endpoint!)
      const url = `http://127.0.0.1:${page.port}/`

      await session.send("Page.navigate", { url })
      await Bun.sleep(500)

      const read = await session.send("Runtime.evaluate", {
        expression: "JSON.stringify({ url: location.href, title: document.title })",
        returnByValue: true,
      })
      const parsed = JSON.parse((read as { result: { value: string } }).result.value)
      expect(parsed.url).toBe(url)
      expect(parsed.title).toBe("spike")

      // A screenshot proves the renderer produced pixels for this page.
      const shot = (await session.send("Page.captureScreenshot", { format: "png" })) as { data?: string }
      expect(shot.data?.length ?? 0).toBeGreaterThan(100)

      session.close()
    } finally {
      page.stop(true)
      try {
        await runtime.runPromise((s) => s.stop)
      } catch {}
    }
  }, 30_000)
})
