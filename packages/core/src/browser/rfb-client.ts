import { createFramebuffer, ZrleDecoder, type Framebuffer } from "./rfb-decode"
import {
  ByteQueue,
  type Transport,
  encodeFramebufferUpdateRequest,
  encodeKeyEvent,
  encodePointerEvent,
  handshake,
  readMessage,
  type ServerInit,
} from "./rfb-protocol"

export type { Transport }

// The RFB client: the human's window onto the session browser.
//
// Assembly rather than protocol work. Transport carries bytes, the protocol
// layer frames them, the decoder turns them into pixels, and this drives the
// whole loop.
//
// Two things it must get right and that a naive loop gets wrong:
//
// - A FramebufferUpdateRequest is not answered one for one. An update may
//   satisfy several requests, so outstanding requests are tracked and only
//   one is sent when the previous update has been consumed. Otherwise the
//   server queues a backlog and latency grows without bound.
// - A redraw is only announced when pixels actually changed. A bell or a
//   skipped pseudo-rect must not schedule a frame.

export type Options = {
  // Called when the framebuffer changed and should be drawn. Not called for
  // bells, cut text, or pseudo-rects.
  onFrame?: (framebuffer: Framebuffer) => void
  // Called once when the session ends, with a reason when there was one.
  onClose?: (error?: Error) => void
  // Called for server cut text, which carries the remote clipboard.
  onCutText?: (text: string) => void
  // How many updates to request per second when the screen is idle. Continuous
  // updates keep latency low; a rate keeps an idle session cheap.
  idleRequestsPerSecond?: number
}

export class RfbError extends Error {
  constructor(message: string) {
    super(`rfb client: ${message}`)
    this.name = "RfbError"
  }
}

export interface Interface {
  readonly init: ServerInit
  readonly framebuffer: Framebuffer
  // Ask for the next update. The loop does this itself, so a caller only needs
  // it to wake an idle session.
  readonly request: () => void
  readonly key: (keysym: number, down: boolean) => void
  readonly pointer: (x: number, y: number, mask: number) => void
  readonly close: () => void
  readonly closed: () => boolean
}

const DEFAULT_IDLE_RATE = 20

/**
 * Run a session against a transport.
 *
 * Resolves once the handshake completes, so the caller has a framebuffer to
 * draw from that point on. Updates then arrive through `onFrame`.
 */
export async function start(transport: Transport, options: Options & { queue?: ByteQueue } = {}): Promise<Interface> {
  const idleRate = options.idleRequestsPerSecond ?? DEFAULT_IDLE_RATE
  // The queue is injectable so the transport that fills it can be built first,
  // which is what a socket needs.
  const queue = options.queue ?? new ByteQueue()
  const zrle = new ZrleDecoder()

  let closed = false
  let failure: Error | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const init = await handshake(queue, transport)
  const framebuffer = createFramebuffer(init.width, init.height)

  const finish = (error?: Error) => {
    if (closed) return
    closed = true
    failure = error
    if (idleTimer) clearTimeout(idleTimer)
    options.onClose?.(error)
  }

  // Requests are not gated on the previous one being answered. The server may
  // legitimately hold an incremental request indefinitely — it answers when the
  // screen changes — so waiting for an answer before asking again is a deadlock
  // on any page that stays still. That is exactly what a static CAPTCHA does:
  // one request goes out, nothing comes back, and the client waits forever.
  //
  // The specification warns about the other extreme, a client that "hogs the
  // network" by sending incremental requests without limit, so the outbound
  // count is bounded rather than unbounded.
  const MAX_OUTSTANDING = 4
  let outstanding = 0
  let received = false

  const request = () => {
    if (closed) return
    if (outstanding >= MAX_OUTSTANDING) return
    outstanding++
    transport.write(encodeFramebufferUpdateRequest(init.width, init.height, received))
  }

  const scheduleIdleRequest = () => {
    if (closed) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => {
        idleTimer = undefined
        // Ask on every wake. The server holds an incremental request until
        // something changes, so a wake with nothing to report must still ask
        // again or the session goes deaf.
        request()
        scheduleIdleRequest()
      },
      Math.max(50, Math.floor(1000 / idleRate)),
    )
  }

  const loop = async () => {
    try {
      for (;;) {
        if (closed) return
        // Block on the next message. The wake timer above issues requests.
        const update = await readMessage(queue, framebuffer, zrle)
        if (update.kind === "cut") {
          options.onCutText?.(update.text)
          continue
        }
        if (update.kind === "bell" || update.kind === "colourMap") continue

        if (outstanding > 0) outstanding--
        received = true
        if (update.changed) options.onFrame?.(framebuffer)
        // Ask again, and keep the idle wake alive.
        request()
        scheduleIdleRequest()
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }

  // Kick the loop and the first request off together.
  void loop()
  request()
  scheduleIdleRequest()

  return {
    init,
    framebuffer,
    request,
    key: (keysym, down) => {
      if (!closed) transport.write(encodeKeyEvent(keysym, down))
    },
    pointer: (x, y, mask) => {
      if (!closed) transport.write(encodePointerEvent(x, y, mask))
    },
    close: () => {
      finish()
    },
    closed: () => closed,
  }
}

/**
 * Build a transport over a WebSocket.
 *
 * Binary frames both ways, because RFB is a byte protocol and the relay is a
 * byte pipe. A string frame would mean something upstream is wrong, so it is
 * rejected rather than coerced.
 */
export function webSocketTransport(socket: WebSocket, queue: ByteQueue): Transport {
  socket.binaryType = "arraybuffer"
  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data
    if (data instanceof ArrayBuffer) queue.push(new Uint8Array(data))
    else if (data instanceof Uint8Array) queue.push(data)
  })
  return {
    write: (bytes: Uint8Array) => socket.send(bytes),
  }
}

/**
 * Fetch a ticket from the session server and open the relay.
 *
 * The ticket authorises the upgrade, so the WebSocket carries it in the query
 * string rather than credentials.
 */
export async function connect(options: {
  url: string
  directory: string
  maxAttempts?: number
}): Promise<{ socket: WebSocket; queue: ByteQueue; transport: Transport }> {
  const attempts = options.maxAttempts ?? 5
  let lastError: Error | undefined

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${options.url}/browser/connect-token`, {
        method: "POST",
        headers: { "x-opencode-directory": options.directory },
      })
      if (!response.ok) throw new RfbError(`ticket request failed with ${response.status}`)
      const { ticket } = (await response.json()) as { ticket: string }

      const socketUrl = new URL(options.url)
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:"
      socketUrl.pathname = `${socketUrl.pathname.replace(/\/$/, "")}/browser/connect`
      socketUrl.searchParams.set("ticket", ticket)
      socketUrl.searchParams.set("directory", options.directory)

      const queue = new ByteQueue()
      const socket = new WebSocket(socketUrl.toString())
      socket.binaryType = "arraybuffer"

      // The message listener is attached before waiting for `open`. A WebSocket
      // discards messages that arrive with no listener attached, and the server
      // sends its version banner as soon as it accepts — which happens within
      // the window we would otherwise be awaiting `open` in. Losing those 12
      // bytes stalls the handshake forever, and the failure looks like a
      // healthy connection that never produces anything.
      //
      // Every shape the browser can deliver is handled. Binary is expected, and
      // text is decoded as latin-1 rather than dropped, because a relay that
      // sends bytes as a text frame is a real possibility and losing them would
      // be indistinguishable from the server sending nothing.
      const pump = (data: unknown) => {
        if (data instanceof ArrayBuffer) queue.push(new Uint8Array(data))
        else if (data instanceof Uint8Array) queue.push(data)
        else if (ArrayBuffer.isView(data)) queue.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        else if (typeof data === "string") {
          const bytes = new Uint8Array(data.length)
          for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff
          queue.push(bytes)
        }
      }
      socket.addEventListener("message", (event: MessageEvent) => pump(event.data))

      // The relay starts the browser on demand, so the first attempt can take
      // as long as Chromium does to launch. Failing fast here would give up on
      // a cold session that is about to succeed.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RfbError("the relay did not open in time")), 30_000)
        socket.addEventListener("open", () => {
          clearTimeout(timer)
          resolve()
        })
        const failed = (event: Event) => {
          clearTimeout(timer)
          reject(new RfbError(`the relay refused the connection (${String((event as CloseEvent).code ?? "")})`))
        }
        socket.addEventListener("error", failed)
        socket.addEventListener("close", failed)
      })

      return { socket, queue, transport: { write: (bytes) => socket.send(bytes) } }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // A refused upgrade is worth retrying once the browser finishes starting.
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  throw lastError ?? new RfbError("could not open the relay")
}
