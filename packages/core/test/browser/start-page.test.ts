import { describe, expect, test } from "bun:test"
import { Browser } from "@opencode-ai/core/browser"
import { connectPage } from "@opencode-ai/core/browser/cdp-session"
import { WARNING_PAGE_HTML, warningPageUrl } from "@opencode-ai/core/browser/start-page"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"

// The page the session browser opens on.
//
// It is the first thing the human sees, which is the only moment a warning is
// worth anything, so it has to say the two things that matter: the browser is in
// a container, and it is persistent, so nothing entered here is private. Two of
// those are asserted as text, and the third — that Chromium actually renders it
// rather than failing to load — needs a live browser.

describe("container warning page", () => {
  test("the URL carries the page, and decodes back to it", () => {
    const url = warningPageUrl()
    expect(url.startsWith("data:text/html")).toBe(true)
    // A data URL ends at the first raw '#'; the CSS is full of them, so they
    // must be encoded or the page would be cut off at the first colour.
    const payload = url.slice(url.indexOf(",") + 1)
    expect(payload).not.toContain("#")
    expect(decodeURIComponent(payload)).toBe(WARNING_PAGE_HTML)
  })

  test("it says the container is persistent and warns off credentials", () => {
    const text = WARNING_PAGE_HTML.toLowerCase()
    expect(text).toContain("container")
    expect(text).toContain("persistent")
    expect(text).toContain("never enter passwords")
    // The agent reads the same page, which is why nothing here is private.
    expect(text).toContain("agent")
  })

  test("it loads no external resources", () => {
    // The whole reason it is a data URL is that it must work with no network,
    // so it must not reference anything that would need one.
    expect(WARNING_PAGE_HTML).not.toMatch(/https?:\/\//)
    expect(WARNING_PAGE_HTML).not.toMatch(/<script/i)
    expect(WARNING_PAGE_HTML).not.toMatch(/<link/i)
    expect(WARNING_PAGE_HTML).not.toMatch(/@import/i)
  })
})

// Renders it in a real Chromium. Guarded, because it spawns Xvnc and Chromium.
const guard = process.env.MANUS_INTEGRATION === "1"
const hasBin = (name: string) => Bun.spawnSync(["which", name]).exitCode === 0
const skip = !guard || !hasBin("Xvnc") || !hasBin("chromium")
const reason = skip ? (!guard ? "set MANUS_INTEGRATION=1" : "Xvnc or chromium not installed") : undefined

describe.skipIf(skip)(reason ? `${reason} (container warning page)` : "container warning page (live)", () => {
  test("Chromium opens on it and it renders", async () => {
    const runtime = makeRuntime(Browser.Service, LayerNode.compile(Browser.node))
    try {
      await runtime.runPromise((s) => s.ensure)
      const endpoint = await runtime.runPromise((s) => s.endpoint)
      expect(endpoint).toBeDefined()

      const page = await connectPage(endpoint!)
      try {
        // The page target exists before the document commits, so the read is
        // polled. Reading once returned an empty title in an earlier probe and
        // looked like a broken page.
        let title = ""
        let body = ""
        for (let i = 0; i < 25; i++) {
          const result = (await page.send("Runtime.evaluate", {
            expression: "JSON.stringify({ title: document.title, body: document.body ? document.body.innerText : '' })",
            returnByValue: true,
          })) as { result?: { value?: string } }
          const parsed = JSON.parse(result.result?.value ?? "{}") as { title?: string; body?: string }
          title = parsed.title ?? ""
          body = parsed.body ?? ""
          if (body.length > 0) break
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        console.log(`[start-page] title=${JSON.stringify(title)} body=${body.replace(/\n/g, " ").slice(0, 60)}`)
        expect(title).toBe("This browser is in a container")
        expect(body.toLowerCase()).toContain("never enter passwords")
      } finally {
        page.close()
      }
    } finally {
      await runtime.runPromise((s) => s.stop)
    }
  }, 30_000)
})
