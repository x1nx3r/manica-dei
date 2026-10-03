import { createFramebuffer, ZrleDecoder, type Framebuffer } from "./decode"
import {
  ByteQueue,
  type Transport,
  encodeFramebufferUpdateRequest,
  encodeKeyEvent,
  encodePointerEvent,
  encodeSetDesktopSize,
  handshake,
  readMessage,
  type DesktopSize,
  type Screen,
  type ServerInit,
} from "./protocol"

export type { Transport }

// The RFB client: connect to a server, receive updates, send input.
//
// Assembly rather than protocol work. Transport carries bytes, the protocol
// layer frames them, the decoder turns them into pixels, and this drives the
// whole loop.
//
// Two things it must get right and that a naive loop gets wrong:
//
// - FramebufferUpdateRequest is not answered one for one, and an incremental
//   request may be held indefinitely until the screen changes. The client
//   therefore keeps asking on a timer rather than waiting for an answer, which
//   is what keeps a static page from staying dark, and bounds how many
//   requests it leaves outstanding so it does not hog the network.
// - A redraw is only announced when pixels actually changed. A bell or a
//   skipped pseudo-rect must not schedule a frame.

export type Options = {
  // Called when the framebuffer changed and should be drawn. Not called for
  // bells, cut text, or pseudo-rects.
  onFrame?: (framebuffer: Framebuffer) => void
  // Called when the desktop geometry is reported or changes. The framebuffer is
  // the new one when the size changed, and the same one otherwise. A caller
  // that holds the framebuffer must swap to this one.
  onDesktopSize?: (size: DesktopSize, framebuffer: Framebuffer) => void
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
  // The current framebuffer. It is replaced when the desktop is resized, so a
  // caller must read it after `onDesktopSize` rather than caching it.
  readonly framebuffer: Framebuffer
  // Ask for the next update. The loop does this itself, so a caller only needs
  // it to wake an idle session.
  readonly request: () => void
  // Request a new desktop size. A no-op when the size is already current, which
  // is required: a server that receives a request for the size it already has
  // may send a resize rect for no change, and a client that answers that can
  // loop. The result arrives through `onDesktopSize`.
  readonly resize: (width: number, height: number) => void
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
  // The current geometry, which a resize can change. `received` stays true
  // across a resize: the specification says the client may assume the
  // framebuffer is retained, and the way to say so is to keep incremental set.
  // Sending a non-incremental request after a resize makes the session loop.
  let width = init.width
  let height = init.height
  let framebuffer = createFramebuffer(width, height)
  // The screens the server last described, kept so a resize can name them by
  // the id the server gave.
  let screens: Screen[] = []

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
    transport.write(encodeFramebufferUpdateRequest(width, height, received))
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

        if (update.kind === "desktopSize") {
          // A resize is not a frame. The reason and status decide whether the
          // geometry actually changed: reason 1 means we asked, and then the
          // status must be 0 for the change to have happened. On a denial the
          // width and height fields are undefined, so they must not be trusted.
          const accepted = update.size.reason !== 1 || update.size.status === 0
          // The screens are kept regardless: even a denied reply describes the
          // current layout, and the ids are what a later request must name.
          screens = update.size.screens
          if (accepted && (update.size.width !== width || update.size.height !== height)) {
            width = update.size.width
            height = update.size.height
            framebuffer = createFramebuffer(width, height)
          }
          options.onDesktopSize?.(update.size, framebuffer)
          // Ask again, in case the update carried nothing else.
          request()
          scheduleIdleRequest()
          continue
        }

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
    // A getter, not the value: a resize replaces the buffer, and a caller that
    // kept the old reference would draw the new frame into the wrong size.
    get framebuffer() {
      return framebuffer
    },
    request,
    resize: (nextWidth, nextHeight) => {
      if (closed) return
      // A request for the size that is already current is not sent. The
      // specification says a server should only send a resize rect for an
      // actual change, and a client that answers a no-op can loop, so the
      // surest guard is to never ask for a no-op.
      if (nextWidth === width && nextHeight === height) return
      transport.write(encodeSetDesktopSize(nextWidth, nextHeight, screens))
    },
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
