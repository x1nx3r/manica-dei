import { execFile } from "node:child_process"
import type { Interface as Cdp } from "./cdp"

// Keep Chromium's window the size of the screen it is on.
//
// Without a window manager nothing resizes the browser window when the screen
// changes, and the screen does change: the human's pane reshapes the framebuffer
// with SetDesktopSize so the picture fills it. The window then keeps its launch
// size on a different-sized screen, so the page is cropped — the right of it off
// the screen, dead desktop below. Verified against a live browser: the
// framebuffer was 876x854 and the window was still 1279x719.
//
// The relay is a byte pipe and never parses RFB, so the backend cannot learn of
// a resize from the wire. It does not need to: the screen is readable, and the
// window is settable. Reconciling the two makes "the window follows the screen"
// true no matter who resized it — the pane, the agent, or xrandr by hand.

/** Read the current screen size from an X display, or undefined if unreadable. */
export async function readScreenSize(display: string): Promise<{ width: number; height: number } | undefined> {
  const output = await new Promise<string | undefined>((resolve) => {
    execFile("xrandr", ["--current"], { env: { ...process.env, DISPLAY: display } }, (error, stdout) => {
      resolve(error ? undefined : stdout)
    })
  })
  return output ? parseXrandrSize(output) : undefined
}

/**
 * Pull the current size out of `xrandr --current` output.
 *
 * The line is `Screen 0: minimum 32 x 32, current 876 x 854, maximum 32768 x
 * 32768`. `current` is the active size, which is what the window must match.
 * Parsed here rather than shelled out again so the shape is testable without a
 * display.
 */
export function parseXrandrSize(output: string): { width: number; height: number } | undefined {
  const match = output.match(/current\s+(\d+)\s*x\s*(\d+)/i)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

/** The window id and bounds a browser reports for its page target. */
type Window = { windowId: number; width: number; height: number }

/** Find the page target, which is the one a window belongs to. */
async function pageTargetId(cdp: Cdp): Promise<string | undefined> {
  const result = (await cdp.send("Target.getTargets")) as
    | { targetInfos?: Array<{ type?: string; targetId?: string }> }
    | undefined
  const page = result?.targetInfos?.find((target) => target.type === "page" && target.targetId)
  return page?.targetId
}

/** Read the browser window for the page target. */
async function currentWindow(cdp: Cdp, targetId: string): Promise<Window | undefined> {
  const result = (await cdp.send("Browser.getWindowForTarget", { targetId })) as
    | { windowId?: number; bounds?: { width?: number; height?: number } }
    | undefined
  const windowId = result?.windowId
  const width = result?.bounds?.width
  const height = result?.bounds?.height
  if (typeof windowId !== "number" || typeof width !== "number" || typeof height !== "number") return undefined
  return { windowId, width, height }
}

/**
 * Reconcile the window with the screen, once.
 *
 * Returns the size it set, or undefined when there was nothing to do or the
 * question could not be answered. Every step is allowed to fail quietly: a
 * browser that is starting, a target that is not there yet, or a screen that
 * cannot be read are all normal, and a caller on a timer will try again.
 */
export async function followScreen(
  cdp: Cdp,
  screen: { width: number; height: number },
): Promise<{ width: number; height: number } | undefined> {
  const targetId = await pageTargetId(cdp)
  if (!targetId) return undefined
  const window = await currentWindow(cdp, targetId)
  if (!window) return undefined
  // Chromium reports a window one pixel smaller than it was asked for on X11 —
  // verified live, `setWindowBounds 1076` came back as `1075`. Comparing
  // strictly would therefore correct it on every tick, forever, a fight with no
  // end. A pixel of drift is Chromium's accounting, not a stale window.
  const drift = Math.abs(window.width - screen.width) + Math.abs(window.height - screen.height)
  if (drift <= 2) return undefined
  await cdp.send("Browser.setWindowBounds", {
    windowId: window.windowId,
    bounds: { left: 0, top: 0, width: screen.width, height: screen.height, windowState: "normal" },
  })
  return screen
}

/**
 * Watch the screen and keep the window matched, until stopped.
 *
 * The interval is deliberately slow. A resize is rare and the correction does
 * not need to be instant; polling faster would only add work to a loop that runs
 * for the life of the browser.
 */
export function watchWindow(
  input: { display: string; cdp: () => Cdp | undefined },
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  const interval = options.intervalMs ?? 2_000
  let stopped = false
  const tick = async () => {
    if (stopped) return
    const cdp = input.cdp()
    if (!cdp) return
    try {
      const screen = await readScreenSize(input.display)
      if (!screen || stopped) return
      const changed = await followScreen(cdp, screen)
      // Only a correction is worth a line. The common case is "already
      // matched", and logging that every interval would drown the log.
      if (changed) console.debug(`[browser] window followed the screen to ${changed.width}x${changed.height}`)
    } catch (error) {
      // A missed reconcile is not worth failing the browser over; the next tick
      // tries again.
      options.onError?.(error)
    }
  }
  const timer = setInterval(() => void tick(), interval)
  // The first reconcile should not wait a full interval, because the launch size
  // is the wrong size whenever the pane has already asked for its own.
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
