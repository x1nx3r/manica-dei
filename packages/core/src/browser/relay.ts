import { ByteQueue, webSocketTransport, type Transport } from "@manica-dei/vnc"

// The relay: opencode's WebSocket path to the session browser.
//
// This is the one piece of the transport that is ours rather than RFB's. The
// protocol client in `@manica-dei/vnc` speaks to any RFB server; this knows the
// endpoint, the ticket, and the directory header that the session server wants.
// Keeping the two apart is deliberate: the client stays a general library, and
// our relay convention stays in the product.

export class RelayError extends Error {
  constructor(message: string) {
    super(`browser relay: ${message}`)
    this.name = "RelayError"
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
      if (!response.ok) throw new RelayError(`ticket request failed with ${response.status}`)
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
        const timer = setTimeout(() => reject(new RelayError("the relay did not open in time")), 30_000)
        socket.addEventListener("open", () => {
          clearTimeout(timer)
          resolve()
        })
        const failed = (event: Event) => {
          clearTimeout(timer)
          reject(new RelayError(`the relay refused the connection (${String((event as CloseEvent).code ?? "")})`))
        }
        socket.addEventListener("error", failed)
        socket.addEventListener("close", failed)
      })

      // The message pump above already delivers into `queue`. `webSocketTransport`
      // would attach a second listener, so the outbound side is built directly.
      return { socket, queue, transport: { write: (bytes) => socket.send(bytes) } }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // A refused upgrade is worth retrying once the browser finishes starting.
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  throw lastError ?? new RelayError("could not open the relay")
}

// `webSocketTransport` is re-exported so a caller that already holds a socket
// (a test, or a different relay) can build the outbound side without reaching
// into the protocol client directly.
export { webSocketTransport }
