import { describe, expect, test } from "bun:test"
import type { Interface as Cdp } from "@opencode-ai/core/browser/cdp"
import { followScreen, parseXrandrSize } from "@opencode-ai/core/browser/window-follow"

// Keeping Chromium's window the size of the screen.
//
// The failure this exists for was seen live: the framebuffer was 876x854 and the
// window was still 1279x719, so the page was cropped. There is no window manager
// to fix it, and the relay never parses RFB, so the backend cannot learn of a
// resize from the wire — it reads the screen instead.

const xrandr = (width: number, height: number) =>
  `Screen 0: minimum 32 x 32, current ${width} x ${height}, maximum 32768 x 32768\nVNC-0 connected ${width}x${height}+0+0 0mm x 0mm\n`

describe("parseXrandrSize", () => {
  test("reads the current size from real output", () => {
    // The exact shape TigerVNC's Xvnc produces, copied from a live run.
    expect(parseXrandrSize(xrandr(1076, 854))).toEqual({ width: 1076, height: 854 })
  })

  test("reads a size with no space around the x", () => {
    expect(parseXrandrSize("current 800x600,")).toEqual({ width: 800, height: 600 })
  })

  test("returns undefined when there is no current size", () => {
    expect(parseXrandrSize("xrandr: Failed to get size of gamma")).toBeUndefined()
  })

  test("rejects a zero or malformed size rather than returning it", () => {
    // A zero would ask the browser for a window it cannot have.
    expect(parseXrandrSize("current 0 x 0,")).toBeUndefined()
    expect(parseXrandrSize("")).toBeUndefined()
  })
})

/** A CDP client that answers the two calls this needs and records the rest. */
function fakeCdp(input: { targetId?: string; window?: { windowId: number; width: number; height: number } }): {
  cdp: Cdp
  calls: Array<{ method: string; params?: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === "Target.getTargets") {
        return input.targetId ? { targetInfos: [{ type: "page", targetId: input.targetId }] } : { targetInfos: [] }
      }
      if (method === "Browser.getWindowForTarget") {
        return input.window
          ? { windowId: input.window.windowId, bounds: { width: input.window.width, height: input.window.height } }
          : {}
      }
      return {}
    },
    close: () => {},
    closed: () => false,
  }
  return { cdp, calls }
}

describe("followScreen", () => {
  test("sets the window when it differs from the screen", async () => {
    const { cdp, calls } = fakeCdp({ targetId: "page-1", window: { windowId: 7, width: 1279, height: 719 } })
    const result = await followScreen(cdp, { width: 876, height: 854 })
    expect(result).toEqual({ width: 876, height: 854 })
    const set = calls.find((call) => call.method === "Browser.setWindowBounds")
    expect(set).toBeDefined()
    expect(set!.params).toEqual({
      windowId: 7,
      bounds: { left: 0, top: 0, width: 876, height: 854, windowState: "normal" },
    })
  })

  test("does nothing when the window already matches", async () => {
    // Reconciling on every tick would fight the browser over a pixel. A match
    // must be silent, and it is the common case.
    const { cdp, calls } = fakeCdp({ targetId: "page-1", window: { windowId: 7, width: 876, height: 854 } })
    expect(await followScreen(cdp, { width: 876, height: 854 })).toBeUndefined()
    expect(calls.some((call) => call.method === "Browser.setWindowBounds")).toBe(false)
  })

  test("ignores the one-pixel drift Chromium always reports", async () => {
    // Verified live: asking for 1076 came back as 1075. A strict comparison
    // would correct it on every tick forever, which is a fight, not a fix.
    const { cdp, calls } = fakeCdp({ targetId: "page-1", window: { windowId: 7, width: 1075, height: 853 } })
    expect(await followScreen(cdp, { width: 1076, height: 854 })).toBeUndefined()
    expect(calls.some((call) => call.method === "Browser.setWindowBounds")).toBe(false)
  })

  test("corrects a stale window that is more than the drift", async () => {
    // The live failure: a window left at its launch size on a grown screen.
    const { cdp, calls } = fakeCdp({ targetId: "page-1", window: { windowId: 7, width: 875, height: 853 } })
    expect(await followScreen(cdp, { width: 1076, height: 854 })).toEqual({ width: 1076, height: 854 })
    expect(calls.some((call) => call.method === "Browser.setWindowBounds")).toBe(true)
  })

  test("does nothing when there is no page target yet", async () => {
    const { cdp, calls } = fakeCdp({})
    expect(await followScreen(cdp, { width: 876, height: 854 })).toBeUndefined()
    expect(calls.some((call) => call.method === "Browser.setWindowBounds")).toBe(false)
  })

  test("does nothing when the window cannot be read", async () => {
    const { cdp, calls } = fakeCdp({ targetId: "page-1" })
    expect(await followScreen(cdp, { width: 876, height: 854 })).toBeUndefined()
    expect(calls.some((call) => call.method === "Browser.setWindowBounds")).toBe(false)
  })
})
