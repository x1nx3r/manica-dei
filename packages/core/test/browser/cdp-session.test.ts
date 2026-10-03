import { describe, expect, test } from "bun:test"
import { connectPage, PageError, currentUrl } from "@opencode-ai/core/browser/cdp-session"
import type { Endpoint } from "@opencode-ai/core/browser/endpoint"

// The page connection resolves its own target from the endpoint, then talks to
// that target's socket. Tested with a stub fetch and a stubbed socket factory,
// so no browser is needed here; the live round trip is in browser-page.test.ts.

const endpoint: Endpoint = {
  port: 9222,
  browserPath: "/devtools/browser/uuid",
  browserUrl: "ws://127.0.0.1:9222/devtools/browser/uuid",
  http: "http://127.0.0.1:9222",
}

function stubList(targets: Array<{ type: string; webSocketDebuggerUrl?: string }>) {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(targets), { status: 200 })) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe("connectPage", () => {
  test("fails clearly when there is no page target", async () => {
    const restore = stubList([{ type: "browser_ui", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/ui" }])
    try {
      // pageTargetUrl waits for a page to appear, which is right in production
      // and too slow for a test, so this asserts the failure shape with a
      // short budget of its own.
      await expect(connectPage(endpoint, { timeoutMs: 50 })).rejects.toThrow(PageError)
    } finally {
      restore()
    }
  }, 10_000)

  test("selects the page target, not a browser_ui one", async () => {
    // The socket will not open, so assert on what was chosen rather than on a
    // completed connection. That is the behaviour this test owns.
    const restore = stubList([
      { type: "browser_ui", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/ui" },
      { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/5E7E" },
    ])
    const originalSocket = globalThis.WebSocket
    const opened: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.WebSocket = class {
      constructor(url: string) {
        opened.push(url)
        throw new Error("stop here")
      }
    } as unknown as typeof WebSocket
    try {
      await connectPage(endpoint).catch(() => undefined)
    } finally {
      globalThis.WebSocket = originalSocket
      restore()
    }
    expect(opened[0]).toBe("ws://127.0.0.1:9222/devtools/page/5E7E")
  })
})

describe("currentUrl", () => {
  test("reads location.href from the page", async () => {
    const page = {
      url: "ws://x",
      close: () => {},
      send: async () => ({ result: { value: "http://localhost:5173/docs" } }),
    }
    expect(await currentUrl(page)).toBe("http://localhost:5173/docs")
  })

  test("returns empty when the page has no location", async () => {
    const page = { url: "ws://x", close: () => {}, send: async () => ({ result: {} }) }
    expect(await currentUrl(page)).toBe("")
  })
})
