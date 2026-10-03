import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"

import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/icon"

import { useBrowser } from "@/context/browser"
import { useLanguage } from "@/context/language"
import type { Framebuffer } from "@opencode-ai/core/browser/rfb-decode"
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
  // The last frame, held so it can be drawn when the canvas appears. The canvas
  // lives inside a Show on the connection status, so the first replayed frame
  // arrives before the element exists and would otherwise be lost. A static
  // page then never redraws, which is exactly what a blank about:blank looks
  // like.
  let pending: Framebuffer | undefined

  const draw = (framebuffer: Framebuffer) => {
    pending = framebuffer
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
    // Open when the pane appears, since the transport starts the browser on
    // demand and there is nothing to wait for.
    void browser.open()
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
                    : language.t("browser.waiting")}
                </span>
              </div>
            }
          >
            <canvas
              ref={canvas}
              class="absolute inset-0 h-full w-full object-contain outline-none"
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
