import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/icon"

import { useBrowser } from "@/context/browser"
import { useLanguage } from "@/context/language"
import type { Framebuffer } from "@manica-dei/vnc"
import { toKeysym } from "./keysym"

// ADR-0003: the human's window onto the session browser.
//
// A canvas, not an image, because ZRLE delivers partial rectangles and a full
// re-encode per frame would throw that away.
//
// The URL is read-only and always visible. The ADR makes that the mitigation
// for the shared-browser risk: the human sees whatever the agent's browser
// shows, so the one thing that must never be ambiguous is where it is.
//
// There is no address bar and no recents. The agent owns navigation; the human
// watches and can type and click into the page.

export function BrowserPanel(props: { stacked?: boolean; onClose?: () => void } = {}) {
  const browser = useBrowser()
  const language = useLanguage()

  let canvas: HTMLCanvasElement | undefined
  let container: HTMLDivElement | undefined

  // The container's size and the frame's size, both reactive, so the canvas can
  // be fitted to the container. A canvas has no intrinsic layout, so the fit is
  // computed here rather than left to CSS.
  const [box, setBox] = createStore({ width: 0, height: 0 })
  const [frameSize, setFrameSize] = createSignal<{ width: number; height: number } | undefined>(undefined)

  /**
   * The largest box that fits the container at the framebuffer's aspect ratio,
   * centred by the transform in the style below.
   *
   * Zero until a frame has been drawn and the container measured, which
   * collapses the canvas rather than stretching it, so the picture is never
   * distorted while a size is still unknown.
   */
  const fit = createMemo(() => {
    const frame = frameSize()
    if (!frame || box.width === 0 || box.height === 0) return { width: "0px", height: "0px" }
    const scale = Math.min(box.width / frame.width, box.height / frame.height)
    return {
      width: `${Math.max(1, Math.floor(frame.width * scale))}px`,
      height: `${Math.max(1, Math.floor(frame.height * scale))}px`,
    }
  })

  /**
   * The CSS cursor for the canvas.
   *
   * The server sends the cursor as a shape, and the browser composites it: a
   * data URL with the hotspot is enough, and it avoids drawing an overlay at a
   * position we would have to track through every frame. When the server has no
   * local cursor — a zero-sized shape, which is what a headless Xvnc sends — the
   * default arrow stands in, or the pane would have no pointer at all.
   *
   * The shape is scaled to match the canvas, because the canvas is scaled to fit
   * the container and a framebuffer-sized cursor would look wrong beside it.
   */
  const cursorStyle = createMemo(() => {
    const shape = browser.cursor()
    const frame = frameSize()
    if (!shape || !frame || box.width === 0 || box.height === 0) return "default"
    const scale = Math.min(box.width / frame.width, box.height / frame.height)
    const width = Math.max(1, Math.round(shape.width * scale))
    const height = Math.max(1, Math.round(shape.height * scale))
    const hotspotX = Math.round(shape.hotspotX * scale)
    const hotspotY = Math.round(shape.hotspotY * scale)

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) return "default"
    const image = new ImageData(new Uint8ClampedArray(shape.pixels), shape.width, shape.height)
    // Draw through an offscreen canvas so the browser scales with smoothing.
    const source = document.createElement("canvas")
    source.width = shape.width
    source.height = shape.height
    const sourceContext = source.getContext("2d")
    if (!sourceContext) return "default"
    sourceContext.putImageData(image, 0, 0)
    context.drawImage(source, 0, 0, shape.width, shape.height, 0, 0, width, height)
    return `url(${canvas.toDataURL()}) ${hotspotX} ${hotspotY}, default`
  })

  // The last frame, held so it can be drawn when the canvas appears. The canvas
  // lives inside a Show on the connection status, so the first replayed frame
  // arrives before the element exists and would otherwise be lost. A static
  // page then never redraws, which is exactly what a blank about:blank looks
  // like.
  let pending: Framebuffer | undefined

  /**
   * The framebuffer size that would fill the container, or undefined when the
   * current one is close enough.
   *
   * The remote is resized to the pane's *aspect ratio*, not its pixel size: the
   * agent shares this display and may be reading it, so the pixel budget stays
   * near what it already is and only the shape changes. A change smaller than
   * half a percent of either dimension is ignored, because a dragged panel
   * passes through many near-identical shapes and each resize costs the agent a
   * full repaint.
   */
  const target = (frame: { width: number; height: number }, area: { width: number; height: number }) => {
    if (area.width === 0 || area.height === 0) return undefined
    const wanted = area.width / area.height
    const current = frame.width / frame.height
    if (Math.abs(wanted - current) / current < 0.005) return undefined
    // Keep the pixel count, so the shape changes without the cost of the
    // picture changing with it.
    const pixels = frame.width * frame.height
    let width = Math.round(Math.sqrt(pixels * wanted))
    let height = Math.round(width / wanted)
    // The server accepts 32..32768; stay inside it and keep 16-bit sanity.
    width = Math.max(32, Math.min(32768, width))
    height = Math.max(32, Math.min(32768, height))
    return { width, height }
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined

  const draw = (framebuffer: Framebuffer) => {
    pending = framebuffer
    setFrameSize((current) =>
      current?.width === framebuffer.width && current.height === framebuffer.height
        ? current
        : { width: framebuffer.width, height: framebuffer.height },
    )
    if (!canvas) return
    if (canvas.width !== framebuffer.width || canvas.height !== framebuffer.height) {
      canvas.width = framebuffer.width
      canvas.height = framebuffer.height
    }
    const context = canvas.getContext("2d")
    if (!context) return
    const image = new ImageData(new Uint8ClampedArray(framebuffer.data), framebuffer.width, framebuffer.height)
    context.putImageData(image, 0, 0)
  }

  onMount(() => {
    const unsubscribe = browser.subscribe(draw)
    onCleanup(unsubscribe)

    // Track the container so the fit follows a resize, a panel drag, or the
    // window changing.
    if (typeof ResizeObserver !== "undefined" && container) {
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        if (!rect) return
        setBox({ width: rect.width, height: rect.height })

        // Fill the container by reshaping the remote, but only once the pane has
        // settled. A drag fires this many times a second; each resize marks the
        // whole framebuffer changed, so asking on every tick would flood both
        // the human's pane and the agent's view.
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          resizeTimer = undefined
          const frame = frameSize()
          if (!frame) return
          const next = target(frame, rect)
          if (next) browser.resize(next.width, next.height)
        }, 400)
      })
      observer.observe(container)
      onCleanup(() => observer.disconnect())
    }
    onCleanup(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
    })
  })

  // Open once, when the pane appears and nothing has connected yet. Reconnects
  // after a drop are the provider's business: it retries with backoff and, when
  // the attempts run out, offers `retry`. An effect that reopened on every
  // "closed" would fight that scheduler and would also reopen the instant
  // somebody closed the pane on purpose.
  createEffect(() => {
    if (browser.state.status === "idle") void browser.open()
  })

  // The canvas is created after the connection opens, so the frame that was
  // replayed on subscribe is drawn here once the element exists.
  createEffect(() => {
    if (browser.state.status !== "open") return
    const frame = pending
    if (frame) queueMicrotask(() => draw(frame))
  })

  // The URL is polled because the agent drives navigation over CDP and there is
  // no event here when it moves.
  createEffect(() => {
    if (browser.state.status === "open") void browser.refreshUrl()
  })

  /**
   * Map a pointer event to framebuffer coordinates.
   *
   * The canvas is letterboxed inside its container, so the rect has to be
   * intersected with the drawn area before scaling. Dividing by the rect alone
   * would be wrong whenever the aspect ratios differ.
   */
  const toFramebuffer = (event: MouseEvent): { x: number; y: number } | undefined => {
    if (!canvas) return undefined
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    const x = Math.round(((event.clientX - rect.left) / rect.width) * canvas.width)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * canvas.height)
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return undefined
    return { x, y }
  }

  const pointer = (event: MouseEvent, mask: number) => {
    const position = toFramebuffer(event)
    if (!position) return
    browser.pointer(position.x, position.y, mask)
  }

  // RFB button mask bits: one is left, two is middle, four is right.
  const maskFor = (event: MouseEvent) => {
    if (event.button === 0) return 1
    if (event.button === 1) return 2
    if (event.button === 2) return 4
    return 0
  }

  const status = createMemo(() => browser.state.status)

  return (
    <aside
      id="browser-panel"
      role="region"
      aria-label={language.t("browser.title")}
      class="relative shrink-0 overflow-hidden bg-v2-background-bg-base"
      classList={{
        "w-full": !props.stacked,
        "min-w-0 h-full flex-1": !props.stacked,
      }}
    >
      <div class="absolute inset-0 flex flex-col">
        <div class="h-10 shrink-0 flex items-center gap-2 px-2 border-b border-border-weaker-base">
          <TooltipV2 value={language.t("browser.title")}>
            <span class="shrink-0 text-text-weak" aria-hidden="true">
              <Icon name="window-cursor" size="small" />
            </span>
          </TooltipV2>

          {/*
            Continuously visible, and never editable. This is the ADR's
            mitigation: the human can always tell which page is on screen.
          */}
          <div
            class="flex-1 min-w-0 truncate px-2 py-0.5 rounded-md bg-surface-base text-12-regular text-text-weak"
            title={browser.state.url}
            aria-label={language.t("browser.currentUrl")}
          >
            {browser.state.url ||
              (browser.state.urlError
                ? language.t("browser.urlFailed", { reason: browser.state.urlError })
                : language.t("browser.noUrl"))}
          </div>

          <span class="shrink-0 px-2 py-0.5 rounded-full bg-surface-base text-11-medium text-text-weak">
            {status() === "open"
              ? language.t("browser.shared")
              : status() === "connecting"
                ? language.t("common.loading")
                : status() === "failed"
                  ? language.t("browser.failed")
                  : language.t("browser.closed")}
          </span>

          <TooltipV2 value={language.t("browser.close")}>
            <IconButtonV2
              variant="ghost"
              size="small"
              icon={<Icon name="close-small" />}
              aria-label={language.t("browser.close")}
              onClick={() => {
                browser.close()
                props.onClose?.()
              }}
            />
          </TooltipV2>
        </div>

        <div ref={container} class="relative flex-1 min-h-0 bg-black">
          <Show
            when={status() === "open"}
            fallback={
              <div class="h-full flex flex-col items-center justify-center gap-2 text-13-regular text-text-weak">
                <span>
                  {status() === "failed"
                    ? (browser.state.error ?? language.t("browser.failed"))
                    : status() === "reconnecting"
                      ? language.t("browser.reconnectingAttempt", { attempt: browser.state.attempt ?? 1 })
                      : language.t("browser.waiting")}
                </span>
                {/* A terminal failure may still be temporary, so a person gets a
                    control rather than only a message. Nothing automatic comes
                    after the attempts are used up. */}
                <Show when={status() === "failed"}>
                  <button
                    type="button"
                    class="px-2 py-1 rounded border border-border-weak-base text-text-base hover:bg-surface-raised-base-hover"
                    onClick={() => browser.retry()}
                  >
                    {language.t("browser.retry")}
                  </button>
                </Show>
              </div>
            }
          >
            <canvas
              ref={canvas}
              // The canvas keeps the framebuffer's own pixel size, which the
              // draw code sets, and is scaled by CSS. `object-contain` does
              // nothing on a canvas, so the fit is done explicitly: the element
              // is sized to the largest box with the framebuffer's aspect
              // ratio, centred. That keeps the picture undistorted and makes the
              // pointer mapping below a single ratio against a rect that is
              // exactly the image.
              class="absolute outline-none"
              style={{
                width: fit().width,
                height: fit().height,
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                cursor: cursorStyle(),
                "image-rendering": "auto",
              }}
              tabindex={0}
              onMouseMove={(event) => pointer(event, 0)}
              onMouseDown={(event) => {
                pointer(event, maskFor(event))
                event.currentTarget.focus()
              }}
              onMouseUp={(event) => pointer(event, 0)}
              onContextMenu={(event) => event.preventDefault()}
              onWheel={(event) => {
                // RFB carries the wheel as an edge-triggered button bit, so a
                // wheel event becomes a press and release of bit four or five.
                const position = toFramebuffer(event)
                if (!position) return
                event.preventDefault()
                const bit = event.deltaY < 0 ? 8 : 16
                browser.pointer(position.x, position.y, bit)
                browser.pointer(position.x, position.y, 0)
              }}
              onKeyDown={(event) => {
                // Keys become X11 keysyms, which is a table rather than a
                // transform. Unmapped keys are dropped rather than guessed.
                const keysym = toKeysym(event)
                if (keysym === undefined) return
                event.preventDefault()
                browser.key(keysym, true)
              }}
              onKeyUp={(event) => {
                const keysym = toKeysym(event)
                if (keysym === undefined) return
                event.preventDefault()
                browser.key(keysym, false)
              }}
            />
          </Show>
        </div>
      </div>
    </aside>
  )
}
