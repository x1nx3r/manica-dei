import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { CdpError, ClosedError, make, type Message } from "@opencode-ai/core/browser/cdp"
import { encodeMessage } from "@opencode-ai/core/browser/cdp-pipe"

// The client against a fake pipe. No browser needed, so this runs everywhere;
// the live round trip is asserted separately in cdp-pipe-live.test.ts.

function harness(options: { onEvent?: (message: Message) => void; onClose?: (error?: Error) => void } = {}) {
  const toChromium = new PassThrough()
  const fromChromium = new PassThrough()
  const sent: Array<{ id: number; method: string; params: unknown }> = []
  toChromium.on("data", (chunk: Buffer) => {
    for (const payload of chunk.toString("utf8").split("\0")) {
      if (payload) sent.push(JSON.parse(payload))
    }
  })
  const client = make(toChromium, fromChromium, options)
  const reply = (message: Message) => fromChromium.write(encodeMessage(JSON.stringify(message)))
  return { client, sent, reply, fromChromium, toChromium }
}

describe("cdp client", () => {
  test("correlates a reply by id", async () => {
    const { client, sent, reply } = harness()
    const promise = client.send("Browser.getVersion")
    expect(sent[0]?.method).toBe("Browser.getVersion")
    reply({ id: sent[0]!.id, result: { product: "Chrome/154" } })
    expect(await promise).toEqual({ product: "Chrome/154" })
  })

  test("sends params", async () => {
    const { client, sent, reply } = harness()
    const promise = client.send("Page.navigate", { url: "http://localhost:5173/" })
    expect(sent[0]?.params).toEqual({ url: "http://localhost:5173/" })
    reply({ id: sent[0]!.id, result: {} })
    await promise
  })

  test("keeps concurrent calls apart", async () => {
    const { client, sent, reply } = harness()
    const a = client.send("A")
    const b = client.send("B")
    expect(sent.map((m) => m.method)).toEqual(["A", "B"])
    // Answer out of order, which the id correlation must survive.
    reply({ id: sent[1]!.id, result: "second" })
    reply({ id: sent[0]!.id, result: "first" })
    expect(await a).toBe("first")
    expect(await b).toBe("second")
  })

  test("rejects with CdpError on a protocol error", async () => {
    const { client, sent, reply } = harness()
    const promise = client.send("Bad.method")
    reply({ id: sent[0]!.id, error: { code: -32601, message: "wasn't found" } })
    await expect(promise).rejects.toThrow(CdpError)
    await promise.catch((error: CdpError) => {
      expect(error.code).toBe(-32601)
      expect(error.message).toContain("wasn't found")
    })
  })

  test("delivers events to the listener", async () => {
    const events: Message[] = []
    const { reply } = harness({ onEvent: (message) => events.push(message) })
    reply({ method: "Page.loadEventFired", params: { timestamp: 1 } })
    await Bun.sleep(5)
    expect(events.map((e) => e.method)).toEqual(["Page.loadEventFired"])
  })

  test("an event listener that throws does not break the pipe", async () => {
    const seen: string[] = []
    const { client, sent, reply } = harness({
      onEvent: () => {
        throw new Error("listener exploded")
      },
    })
    reply({ method: "Some.event" })
    await Bun.sleep(5)
    // The client still works afterwards.
    const promise = client.send("Later")
    reply({ id: sent[0]!.id, result: "ok" })
    expect(await promise).toBe("ok")
    expect(seen).toEqual([])
  })

  test("rejects in-flight calls when the pipe ends", async () => {
    const { client, fromChromium } = harness()
    const promise = client.send("Hang")
    fromChromium.end()
    await expect(promise).rejects.toThrow(ClosedError)
  })

  test("reports closed and rejects new calls after close", async () => {
    const { client } = harness()
    client.close()
    expect(client.closed()).toBe(true)
    await expect(client.send("After")).rejects.toThrow(ClosedError)
  })

  test("handles two replies arriving in one chunk", async () => {
    const { client, sent, reply, fromChromium } = harness()
    const a = client.send("A")
    const b = client.send("B")
    // Write both messages into a single chunk.
    fromChromium.write(
      Buffer.concat([
        encodeMessage(JSON.stringify({ id: sent[0]!.id, result: "first" })),
        encodeMessage(JSON.stringify({ id: sent[1]!.id, result: "second" })),
      ]),
    )
    expect(await a).toBe("first")
    expect(await b).toBe("second")
  })

  test("calls onClose once", async () => {
    let closes = 0
    const { client, fromChromium } = harness({ onClose: () => closes++ })
    fromChromium.end()
    client.close()
    await Bun.sleep(5)
    expect(closes).toBe(1)
  })
})
