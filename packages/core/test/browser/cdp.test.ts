import { describe, expect, test } from "bun:test"
import { CdpError, ClosedError, connect, type WebSocketLike } from "@opencode-ai/core/browser/cdp"

// The client against a fake socket, so this runs everywhere. The live round
// trip against a real Chromium is asserted in browser-cdp.test.ts.

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  closed = false
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
    // The real WebSocket fires open asynchronously; so does this.
    if (type === "open") queueMicrotask(() => listener({}))
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.emit("close", {})
  }

  emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  reply(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) })
  }

  parse(index: number) {
    return JSON.parse(this.sent[index]!) as { id: number; method: string; params: unknown }
  }
}

async function harness(options: Parameters<typeof connect>[1] = {}) {
  const socket = new FakeSocket()
  const client = await connect("ws://127.0.0.1:1/devtools/browser/x", {
    ...options,
    socketFactory: () => socket,
  })
  return { client, socket }
}

describe("cdp client", () => {
  test("correlates a reply by id", async () => {
    const { client, socket } = await harness()
    const promise = client.send("Browser.getVersion")
    expect(socket.parse(0).method).toBe("Browser.getVersion")
    socket.reply({ id: socket.parse(0).id, result: { product: "Chrome/154" } })
    expect(await promise).toEqual({ product: "Chrome/154" })
  })

  test("sends params", async () => {
    const { client, socket } = await harness()
    const promise = client.send("Page.navigate", { url: "http://localhost:5173/" })
    expect(socket.parse(0).params).toEqual({ url: "http://localhost:5173/" })
    socket.reply({ id: socket.parse(0).id, result: {} })
    await promise
  })

  test("keeps concurrent calls apart, answering out of order", async () => {
    const { client, socket } = await harness()
    const a = client.send("A")
    const b = client.send("B")
    expect([socket.parse(0).method, socket.parse(1).method]).toEqual(["A", "B"])
    socket.reply({ id: socket.parse(1).id, result: "second" })
    socket.reply({ id: socket.parse(0).id, result: "first" })
    expect(await a).toBe("first")
    expect(await b).toBe("second")
  })

  test("rejects with CdpError on a protocol error", async () => {
    const { client, socket } = await harness()
    const promise = client.send("Bad.method")
    socket.reply({ id: socket.parse(0).id, error: { code: -32601, message: "wasn't found" } })
    await expect(promise).rejects.toThrow(CdpError)
    await promise.catch((error: CdpError) => {
      expect(error.code).toBe(-32601)
      expect(error.message).toContain("wasn't found")
    })
  })

  test("delivers events to the listener", async () => {
    const events: string[] = []
    const { socket } = await harness({ onEvent: (message) => events.push(message.method ?? "") })
    socket.reply({ method: "Page.loadEventFired", params: { timestamp: 1 } })
    expect(events).toEqual(["Page.loadEventFired"])
  })

  test("an event listener that throws does not break the connection", async () => {
    const { client, socket } = await harness({
      onEvent: () => {
        throw new Error("listener exploded")
      },
    })
    socket.reply({ method: "Some.event" })
    const promise = client.send("Later")
    socket.reply({ id: socket.parse(0).id, result: "ok" })
    expect(await promise).toBe("ok")
  })

  test("rejects in-flight calls when the socket closes", async () => {
    const { client, socket } = await harness()
    const promise = client.send("Hang")
    socket.close()
    await expect(promise).rejects.toThrow(ClosedError)
  })

  test("reports closed and rejects new calls after close", async () => {
    const { client, socket } = await harness()
    client.close()
    expect(client.closed()).toBe(true)
    expect(socket.closed).toBe(true)
    await expect(client.send("After")).rejects.toThrow(ClosedError)
  })

  test("a frame that is not a CDP message settles the client", async () => {
    const { client, socket } = await harness()
    const promise = client.send("Hang")
    socket.emit("message", { data: JSON.stringify({ nothing: true }) })
    await expect(promise).rejects.toThrow(/neither an id nor a method/)
    expect(client.closed()).toBe(true)
  })

  test("invalid JSON settles the client", async () => {
    const { client, socket } = await harness()
    const promise = client.send("Hang")
    socket.emit("message", { data: "not json" })
    await expect(promise).rejects.toThrow()
    expect(client.closed()).toBe(true)
  })

  test("calls onClose once", async () => {
    let closes = 0
    const { client, socket } = await harness({ onClose: () => closes++ })
    socket.close()
    client.close()
    expect(closes).toBe(1)
  })
})
