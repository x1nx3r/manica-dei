import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { connect, start, type Interface as Client } from "@opencode-ai/core/browser/rfb-client"
import { type Framebuffer } from "@opencode-ai/core/browser/rfb-decode"
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
  status: "idle" | "connecting" | "open" | "closed" | "failed"
  // The page the agent's browser is showing. Shown continuously in the pane,
  // because the ADR makes that the mitigation for an agent rendering something
  // that looks like ours. Sourced from the server, which owns the CDP
  // connection; RFB itself carries pixels and has no notion of a URL.
  url: string
  error?: string
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

    // Neither belongs in reactive state: a client is not serialisable, and the
    // framebuffer is large.
    let client: Client | undefined
    let socket: WebSocket | undefined
    let generation = 0
    let latest: Framebuffer | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const listeners = new Set<(framebuffer: Framebuffer) => void>()

    const stopPolling = () => {
      if (poll) clearInterval(poll)
      poll = undefined
    }

    const stop = () => {
      generation++
      stopPolling()
      client?.close()
      socket?.close()
      client = undefined
      socket = undefined
      latest = undefined
    }

    const open = async () => {
      if (store.status === "connecting" || store.status === "open") return
      const current = ++generation
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
          onFrame: (framebuffer) => {
            console.debug("[browser] frame", framebuffer.width, "x", framebuffer.height, "listeners", listeners.size)
            latest = framebuffer
            for (const listener of listeners) listener(framebuffer)
          },
          onClose: (error) => {
            console.debug("[browser] closed", error?.message ?? "(clean)")
            if (current !== generation) return
            setStore({ status: error ? "failed" : "closed", error: error?.message })
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
        setStore({ status: "open" })
        void refreshUrl()
        // The agent drives navigation over CDP, so there is no event to listen
        // for here. A poll is cheaper than a channel for one consumer.
        poll = setInterval(() => void refreshUrl(), 1000)
      } catch (error) {
        console.debug("[browser] failed", error instanceof Error ? error.message : String(error))
        if (current !== generation) return
        setStore({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    }

    const close = () => {
      stop()
      setStore({ status: "closed" })
    }

    /**
     * Subscribe to frames.
     *
     * The latest framebuffer is replayed on subscribe, so a pane mounting after
     * frames have arrived still paints rather than showing an empty canvas until
     * the agent happens to change something.
     */
    const subscribe = (listener: (framebuffer: Framebuffer) => void) => {
      listeners.add(listener)
      if (latest) listener(latest)
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

    return {
      state: store,
      open,
      close,
      subscribe,
      refreshUrl,
      /** Input goes straight to the display, so the agent sees the human act. */
      pointer: (x: number, y: number, mask: number) => client?.pointer(x, y, mask),
      key: (keysym: number, down: boolean) => client?.key(keysym, down),
    }
  },
})
