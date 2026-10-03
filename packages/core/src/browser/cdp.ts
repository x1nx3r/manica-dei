import type { Readable, Writable } from "node:stream"
import { decodeAll, encodeMessage } from "./cdp-pipe"

// A CDP client over the remote debugging pipe. Framing lives in cdp-pipe.ts and
// is proven against a live browser in the tests.
//
// Deliberately transport-only: it sends method calls, correlates replies by id,
// and hands events to a listener. Naming, policy, and which methods the agent
// may reach belong to the caller, the same way the ADR keeps CDP method names
// on the server side and out of the model's reach.

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
    super("cdp: the pipe closed")
    this.name = "ClosedError"
  }
}

export type Options = {
  // Called for every server-initiated message. Errors thrown here must not
  // escape into the read loop.
  onEvent?: (message: Message) => void
  // Called once when the pipe ends, for any reason.
  onClose?: (error?: Error) => void
}

export interface Interface {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  readonly close: () => void
  readonly closed: () => boolean
}

export type Client = Interface

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// The payload arrives over a pipe, so narrow it rather than assert. A frame
// that is not a CDP message is a protocol error, not a crash.
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

export function make(toChromium: Writable, fromChromium: Readable, options: Options = {}): Interface {
  let buffer: Buffer = Buffer.alloc(0)
  let nextId = 1
  let closed = false
  let failure: Error | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const settle = (error?: Error) => {
    if (closed) return
    closed = true
    failure = error
    for (const waiter of pending.values()) {
      waiter.reject(error ?? new ClosedError())
    }
    pending.clear()
    options.onClose?.(error)
  }

  fromChromium.on("data", (chunk: Buffer) => {
    if (closed) return
    buffer = Buffer.concat([buffer, chunk])
    let payloads: string[]
    try {
      const decoded = decodeAll(buffer)
      payloads = decoded.payloads
      buffer = decoded.rest
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const payload of payloads) {
      let message: Message
      try {
        message = asMessage(JSON.parse(payload))
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id)!
        pending.delete(message.id)
        if (message.error) waiter.reject(new CdpError(message.error.code, message.error.message, message.error.data))
        else waiter.resolve(message.result)
        continue
      }
      // Server-initiated events must never take down the read loop.
      try {
        options.onEvent?.(message)
      } catch {}
    }
  })

  fromChromium.on("error", (error: Error) => settle(error))
  fromChromium.on("end", () => settle())
  fromChromium.on("close", () => settle())

  return {
    send(method, params = {}) {
      if (closed) return Promise.reject(failure ?? new ClosedError())
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          toChromium.write(encodeMessage(JSON.stringify({ id, method, params })))
        } catch (error) {
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    close() {
      settle()
    },
    closed: () => closed,
  }
}
