import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createSignal, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { start, type Cursor, type DamageRect, type Interface as Client, type Framebuffer } from "@manica-dei/vnc"
import { connect } from "@opencode-ai/core/browser/relay"
import { nextDelay } from "./browser-retry"
import { useSDK } from "./sdk"

// ADR-0003: the human's window onto the session browser.
//
// The connection belongs to the session rather than to the pane, so closing the
// pane does not kill the stream and reopening it is instant. That mirrors how
// the terminal behaves.
//
// One connection per session, held here. The pane renders what the store says
// and never opens a socket of its own, because two panes open at once would
// otherwise mean two RFB streams against one display.

export type State = {
  // "reconnecting" is not "failed": the stream dropped unexpectedly and another
  // attempt is coming. The two look alike to a reader but only one is worth
  // waiting for, so they are kept apart.
  status: "idle" | "connecting" | "open" | "closed" | "reconnecting" | "failed"
  // The page the agent's browser is showing. Shown continuously in the pane,
  // because the ADR makes that the mitigation for an agent rendering something
  // that looks like ours. Sourced from the server, which owns the CDP
  // connection; RFB itself carries pixels and has no notion of a URL.
  url: string
  error?: string
  // How many reconnects have been tried for the current drop. Shown so a person
  // can tell a blip from a container that is gone.
  attempt?: number
  // Why the URL could not be read, when the server gave a reason. Kept apart
  // from `error`, which is a connection failure: the stream can be perfectly
  // healthy while the page read is not.
  urlError?: string
}

export const { use: useBrowser, provider: BrowserProvider } = createSimpleContext({
  name: "Browser",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const baseUrl = createMemo(() => sdk().url)
    // The relay reads this header as a raw path, which is what the integration
    // test used. Terminal base64-encodes its directory, but that is for a URL
    // segment and a different concern.
    const directory = createMemo(() => sdk().directory)

    const [store, setStore] = createStore<State>({
      status: "idle",
      url: "",
      urlError: undefined,
    })

    // The cursor shape the server last sent, or undefined for "no local
    // cursor". A signal rather than a store field: it is small, it changes on
    // its own schedule, and the pane reads it directly.
    const [cursor, setCursor] = createSignal<Cursor | undefined>(undefined)

    // Neither belongs in reactive state: a client is not serialisable, and the
    // framebuffer is large.
    let client: Client | undefined
    let socket: WebSocket | undefined
    let generation = 0
    // The generation the live stream was opened under, or -1 when there is
    // none. `dropStream` uses it to ignore a second report of the same failure.
    let openGeneration = -1
    let latest: Framebuffer | undefined
    // The damage that belongs to `latest`. Replayed with it so a pane that
    // subscribes after a frame still knows which region to repaint.
    let latestDamage: DamageRect | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const listeners = new Set<(framebuffer: Framebuffer, damage?: DamageRect) => void>()

    // Reconnect policy. A dropped stream is usually a container restart or a
    // Chromium crash, and both are worth retrying. A stream closed on purpose is
    // not. The delays grow and the attempts are capped; the policy itself lives
    // in `browser-retry` so it can be tested on its own.
    let deliberate = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const stopPolling = () => {
      if (poll) clearInterval(poll)
      poll = undefined
    }

    const stopRetrying = () => {
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
    }

    const stop = () => {
      deliberate = true
      attempt = 0
      openGeneration = -1
      stopRetrying()
      generation++
      stopPolling()
      client?.close()
      socket?.close()
      client = undefined
      socket = undefined
      latest = undefined
      latestDamage = undefined
      setCursor(undefined)
    }

    /**
     * Schedule another attempt after a drop.
     *
     * Returns whether one was scheduled. When the attempts are used up the
     * caller falls back to a terminal failure, so the pane shows an error and a
     * retry control rather than waiting on something that is not coming.
     */
    const scheduleRetry = (): boolean => {
      const delay = nextDelay({ attempt, deliberate })
      if (delay === undefined) return false
      attempt += 1
      stopRetrying()
      setStore({ status: "reconnecting", attempt })
      console.debug(`[browser] reconnecting in ${delay} ms, attempt ${attempt}`)
      // The generation is captured so a timer that outlives the provider — or a
      // deliberate close that happened while it was pending — does nothing.
      const scheduled = generation
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (deliberate || scheduled !== generation) return
        // `open` refuses while a status says it is already trying, so the
        // reconnect status is cleared first.
        setStore({ status: "closed" })
        void open()
      }, delay)
      return true
    }

    /**
     * Handle a stream that stopped when it should not have.
     *
     * Both the socket closing and the poll finding no browser land here, so the
     * retry decision is made once. A drop is retried, because it is usually the
     * container restarting; when the attempts run out the state becomes
     * "failed", which is terminal and carries the reason.
     *
     * It is called from two places that can both fire for one failure: the
     * socket's close callback and the poll. Without a guard the second call
     * spends another attempt on the same drop, so a single flapping event could
     * exhaust the budget. The stream is identified by the generation it was
     * opened under, and a drop for a stream that is already gone is ignored.
     */
    const dropStream = (reason: string) => {
      // A stream that is already gone is ignored. The socket's close callback
      // and the poll can both fire for one failure, and without this the second
      // call spends another attempt on the same drop, so one flapping event
      // could exhaust the budget.
      if (openGeneration === -1) return
      openGeneration = -1
      stopPolling()
      stopRetrying()
      client?.close()
      socket?.close()
      client = undefined
      socket = undefined
      latest = undefined
      latestDamage = undefined
      setCursor(undefined)
      if (scheduleRetry()) return
      setStore({ status: "failed", error: reason })
    }

    const open = async () => {
      if (store.status === "connecting" || store.status === "open" || store.status === "reconnecting") return
      deliberate = false
      const current = ++generation
      openGeneration = current
      setStore({ status: "connecting", error: undefined, urlError: undefined })

      try {
        console.debug("[browser] requesting a relay for", directory())
        const opened = await connect({ url: baseUrl(), directory: directory() })
        console.debug("[browser] relay open, starting RFB")
        if (current !== generation) {
          opened.socket.close()
          return
        }
        socket = opened.socket

        client = await start(opened.transport, {
          queue: opened.queue,
          onFrame: (framebuffer, damage) => {
            console.debug("[browser] frame", framebuffer.width, "x", framebuffer.height, "listeners", listeners.size)
            latest = framebuffer
            latestDamage = damage
            for (const listener of listeners) listener(framebuffer, damage)
          },
          onDesktopSize: (size, framebuffer) => {
            // The framebuffer may have been replaced, so a pane holding the old
            // one must swap. It is delivered like a frame: the panel sizes its
            // canvas from the argument and re-reads `client.framebuffer`.
            console.debug(
              "[browser] desktop size",
              size.width,
              "x",
              size.height,
              "reason",
              size.reason,
              "status",
              size.status,
            )
            latest = framebuffer
            // A resize replaces the framebuffer, so no old region is valid in
            // the new one. The pane repaints fully.
            latestDamage = undefined
            for (const listener of listeners) listener(framebuffer, undefined)
          },
          onClose: (error) => {
            console.debug("[browser] closed", error?.message ?? "(clean)")
            dropStream(error?.message ?? "the connection closed")
          },
          onCursor: (cursor) => {
            // The server sends the cursor shape when it changes, not when it
            // moves, and a zero size means it has no local cursor. The pane
            // draws it; the position is the pane's to track, because the
            // human's pointer is over the pane and not in the container.
            setCursor(cursor.width > 0 && cursor.height > 0 ? cursor : undefined)
          },
          onCutText: () => {
            // The remote clipboard is ignored on purpose. Wiring it to the
            // human's clipboard would hand the agent a write into their machine
            // that they did not ask for.
          },
        })

        if (current !== generation) {
          client.close()
          return
        }
        // A successful open clears the retry budget, so a later drop starts
        // fresh rather than inheriting a spent one.
        attempt = 0
        setStore({ status: "open" })
        // The URL is read once here and once more after a reconnect. Reading it
        // costs a CDP round trip, so it is not read on a timer: the value changes
        // when the agent navigates, and a pane that is open is not the thing that
        // needs to know within the second. The poll below asks a question that
        // costs nothing instead.
        void refreshUrl()
        // Liveness, and only liveness. A killed Chromium does not close its RFB
        // socket, so the socket cannot say the browser is gone; the process
        // state can, and this asks for that rather than reading the page.
        poll = setInterval(() => void checkAlive(), 1000)
      } catch (error) {
        console.debug("[browser] failed", error instanceof Error ? error.message : String(error))
        if (current !== generation) return
        // Opening failed, which is the same situation as a drop: worth retrying
        // with backoff, then terminal.
        if (scheduleRetry()) return
        setStore({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    }

    const close = () => {
      stop()
      setStore({ status: "closed" })
    }

    /**
     * Try again now, after the automatic attempts are used up.
     *
     * A terminal failure is not always permanent — the container may have come
     * back — so a person gets a control rather than only a message.
     */
    const retry = () => {
      stopRetrying()
      attempt = 0
      // `stop` tears the old stream down and marks the teardown deliberate so
      // the retry scheduler stays quiet. This call is not a deliberate stop, so
      // the flag is cleared again before opening.
      stop()
      deliberate = false
      setStore({ status: "closed", error: undefined, attempt: undefined })
      void open()
    }

    /**
     * Subscribe to frames.
     *
     * The latest framebuffer is replayed on subscribe, so a pane mounting after
     * frames have arrived still paints rather than showing an empty canvas until
     * the agent happens to change something.
     */
    const subscribe = (listener: (framebuffer: Framebuffer, damage?: DamageRect) => void) => {
      listeners.add(listener)
      if (latest) listener(latest, latestDamage)
      return () => {
        listeners.delete(listener)
      }
    }

    const refreshUrl = async () => {
      if (store.status !== "open") return
      try {
        const response = await fetch(`${baseUrl()}/browser/url`, {
          headers: { "x-opencode-directory": directory() },
        })
        if (!response.ok) {
          setStore("url", "")
          setStore("urlError", `the server answered ${response.status}`)
          return
        }
        const body = (await response.json()) as { url?: string; error?: string }
        if (typeof body.url === "string" && body.url !== store.url) setStore("url", body.url)
        // A reason from the server is surfaced rather than swallowed. The
        // connection is still fine, so this is separate from `status`.
        const next = typeof body.error === "string" ? body.error : undefined
        if (next !== store.urlError) setStore("urlError", next)
      } catch (error) {
        setStore("urlError", error instanceof Error ? error.message : String(error))
      }
    }

    /**
     * Ask whether the browser is still alive.
     *
     * This is the liveness signal, and it is deliberately not the URL read. A
     * killed Chromium does not close its RFB socket — verified: a direct TCP
     * connection to a killed Xvnc stayed open past five seconds with no FIN — so
     * the socket cannot report the death. The process state can, and this route
     * answers from it without touching Chromium, which is the difference between
     * a field read and a CDP round trip every second.
     */
    const checkAlive = async () => {
      if (store.status !== "open") return
      try {
        const response = await fetch(`${baseUrl()}/browser/status`, {
          headers: { "x-opencode-directory": directory() },
        })
        if (!response.ok) return
        const body = (await response.json()) as { alive?: boolean }
        if (body.alive === false && store.status === "open") {
          console.debug("[browser] the server reports no browser; treating the stream as dropped")
          dropStream("the browser is gone")
        }
      } catch {
        // A transport failure is not a browser death: the server may be busy or
        // restarting, and tearing down a healthy stream on one bad request would
        // be worse than waiting for the next one.
      }
    }

    return {
      state: store,
      open,
      close,
      retry,
      subscribe,
      refreshUrl,
      /** Input goes straight to the display, so the agent sees the human act. */
      pointer: (x: number, y: number, mask: number) => client?.pointer(x, y, mask),
      key: (keysym: number, down: boolean) => client?.key(keysym, down),
      /**
       * Ask the remote desktop to resample to a size. The client ignores a
       * request for the size it already has, which is what keeps a resize from
       * looping, so a caller may call this freely and need not compare.
       */
      resize: (width: number, height: number) => client?.resize(width, height),
      /**
       * The cursor shape the server last sent, or undefined for "no local
       * cursor" — in which case the pane draws its own default arrow.
       */
      cursor,
    }
  },
})
