import type { Interface as Session } from "./cdp-session"

// A CDP client over a WebSocket. The transport is chosen by Chromium's own
// `DevToolsActivePort`, see endpoint.ts for why this replaced the debugging
// pipe.
//
// Transport-only on purpose: it sends calls, correlates replies by id, and
// hands events to a listener. Naming, policy, and which methods the agent may
// reach belong to the tool layer, so CDP method names never reach the model.

export type Message = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: string }
  sessionId?: string
}

export class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: string,
  ) {
    super(`cdp: ${message} (${code})`)
    this.name = "CdpError"
  }
}

export class ClosedError extends Error {
  constructor() {
    super("cdp: the connection closed")
    this.name = "ClosedError"
  }
}

export type Options = {
  // Called for every server-initiated message. Throwing here must not take down
  // the read loop, so it is isolated.
  onEvent?: (message: Message) => void
  // Called once when the socket ends, with a reason when there was one.
  onClose?: (error?: Error) => void
  // Injectable for tests. Defaults to the global WebSocket.
  socketFactory?: (url: string) => WebSocketLike
}

export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Narrow rather than assert: the frame arrives off a socket.
function asMessage(value: unknown): Message {
  if (!isRecord(value)) throw new Error("cdp: message was not an object")
  const message: Message = {}
  if (typeof value.id === "number") message.id = value.id
  if (typeof value.method === "string") message.method = value.method
  if (value.params !== undefined) message.params = value.params
  if (value.result !== undefined) message.result = value.result
  if (typeof value.sessionId === "string") message.sessionId = value.sessionId
  if (isRecord(value.error)) {
    if (typeof value.error.code !== "number" || typeof value.error.message !== "string") {
      throw new Error("cdp: malformed error object")
    }
    message.error = {
      code: value.error.code,
      message: value.error.message,
      ...(typeof value.error.data === "string" ? { data: value.error.data } : {}),
    }
  }
  if (message.id === undefined && message.method === undefined) {
    throw new Error("cdp: message carried neither an id nor a method")
  }
  return message
}

export interface Interface {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  readonly close: () => void
  readonly closed: () => boolean
}

export type Client = Interface

export async function connect(url: string, options: Options = {}): Promise<Interface> {
  const factory = options.socketFactory ?? ((target: string) => new WebSocket(target) as unknown as WebSocketLike)
  const socket = factory(url)

  let closed = false
  let failure: Error | undefined
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const settle = (error?: Error) => {
    if (closed) return
    closed = true
    failure = error
    for (const waiter of pending.values()) waiter.reject(error ?? new ClosedError())
    pending.clear()
    options.onClose?.(error)
  }

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", (event) =>
      reject(new Error(`cdp: socket error ${JSON.stringify(event?.data ?? "")}`)),
    )
  }).catch((error) => {
    settle(error instanceof Error ? error : new Error(String(error)))
    throw error
  })

  socket.addEventListener("message", (event) => {
    if (closed) return
    let message: Message
    try {
      const data = typeof event.data === "string" ? event.data : String(event.data)
      message = asMessage(JSON.parse(data))
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id)!
      pending.delete(message.id)
      if (message.error) waiter.reject(new CdpError(message.error.code, message.error.message, message.error.data))
      else waiter.resolve(message.result)
      return
    }

    try {
      options.onEvent?.(message)
    } catch {}
  })

  socket.addEventListener("close", () => settle())
  socket.addEventListener("error", () => settle(failure))

  return {
    send(method, params = {}) {
      if (closed) return Promise.reject(failure ?? new ClosedError())
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    close() {
      settle()
      try {
        socket.close()
      } catch {}
    },
    closed: () => closed,
  }
}

export type { Session }
