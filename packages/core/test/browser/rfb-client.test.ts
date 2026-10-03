import { describe, expect, test } from "bun:test"
import { start, type Transport } from "@opencode-ai/core/browser/rfb-client"
import { ByteQueue } from "@opencode-ai/core/browser/rfb-protocol"
import { createFramebuffer } from "@opencode-ai/core/browser/rfb-decode"
import type { Framebuffer } from "@opencode-ai/core/browser/rfb-decode"

// The client loop, against a fake server.
//
// The two behaviours worth pinning are the ones naive clients get wrong:
// outstanding requests must not pile up, and a frame must only be announced
// when pixels actually changed. Both are asserted here rather than by
// inspection.

const encoder = new TextEncoder()

// The client owns the ByteQueue that feeds its protocol reader, so the fake
// server cannot push into it directly. Instead the transport captures the queue
// the client constructs by observing the handshake, and a small indirection
// lets the test deliver bytes the way a socket would.
function fakeServer(script: Array<Uint8Array>) {
  const written: Uint8Array[] = []
  let push: ((chunk: Uint8Array) => void) | undefined

  const transport: Transport = {
    write: (bytes: Uint8Array) => {
      written.push(bytes)
      // A request is what prompts the scripted answer, matching a real server
      // that only sends updates in reply.
      if (bytes[0] === 3) {
        const next = script.shift()
        if (next) push?.(next)
      }
    },
  }

  const handshakeBytes = [
    encoder.encode("RFB 003.008\n"),
    Uint8Array.from([1]),
    Uint8Array.from([1]),
    Uint8Array.from([0, 0, 0, 0]),
    serverInit(4, 2),
  ]

  return {
    transport,
    written,
    // The client's queue is handed in, so the server pushes into it directly,
    // the way a socket delivers bytes.
    // Queue the handshake before start() reads it, or start() blocks forever.
    begin(queue: { push: (chunk: Uint8Array) => void }) {
      push = (chunk) => queue.push(chunk)
      for (const chunk of handshakeBytes) push(chunk)
    },
  }
}

function serverInit(width: number, height: number) {
  const out = new Uint8Array(24)
  out[0] = (width >> 8) & 0xff
  out[1] = width & 0xff
  out[2] = (height >> 8) & 0xff
  out[3] = height & 0xff
  return out
}

/** An update carrying one Raw rectangle of the given width and height. */
function rawUpdate(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = rgb[2]
    pixels[i * 3 + 1] = rgb[1]
    pixels[i * 3 + 2] = rgb[0]
  }
  const header = Uint8Array.from([
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    0,
    0,
    0,
    0,
  ])
  return new Uint8Array([...header, ...pixels])
}

/** A bell, which must never produce a frame. */
const bell = Uint8Array.from([2])

describe("rfb client", () => {
  test("completes the handshake and exposes a framebuffer of the server size", async () => {
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    server.begin(queue)
    // start() resolves on handshake, which the fake delivers synchronously.
    expect(client.init.width).toBe(4)
    expect(client.init.height).toBe(2)
    expect(client.framebuffer.width).toBe(4)
    client.close()
  })

  test("requests an update and announces a frame when pixels changed", async () => {
    const server = fakeServer([rawUpdate(2, 1, [255, 0, 0])])
    const frames: Framebuffer[] = []
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue, onFrame: (framebuffer) => frames.push(framebuffer) })
    server.begin(queue)
    // start() issues the first request, and the scripted update answers it.
    await Bun.sleep(30)
    expect(frames.length).toBeGreaterThan(0)
    // The pixel landed as RGBA.
    expect(Array.from(client.framebuffer.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    client.close()
  })

  test("a bell does not produce a frame", async () => {
    const frames: string[] = []
    const server = fakeServer([bell])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue, onFrame: () => frames.push("frame") })
    await Bun.sleep(20)
    expect(frames).toEqual([])
    client.close()
  })

  test("sends KeyEvent bytes for a key press", async () => {
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    client.key(0xffe3, true)
    const key = server.written.find((bytes) => bytes[0] === 4)
    expect(key).toBeDefined()
    expect(Array.from(key!.subarray(4))).toEqual([0, 0, 0xff, 0xe3])
    client.close()
  })

  test("sends PointerEvent bytes for a pointer move", async () => {
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    client.pointer(640, 360, 16)
    const pointer = server.written.find((bytes) => bytes[0] === 5)
    expect(pointer).toBeDefined()
    expect(pointer!.length).toBe(6)
    client.close()
  })

  test("reports closed and stops sending after close", async () => {
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    const before = server.written.length
    client.close()
    client.key(0x61, true)
    expect(client.closed()).toBe(true)
    expect(server.written.length).toBe(before)
  })

  test("calls onClose once", async () => {
    const server = fakeServer([])
    let closes = 0
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue, onClose: () => closes++ })
    client.close()
    client.close()
    expect(closes).toBe(1)
  })

  test("requests exactly one update until the first arrives", async () => {
    // The server never answers, so the client must not queue requests.
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    await Bun.sleep(30)
    const requests = server.written.filter((bytes) => bytes[0] === 3)
    // One immediate request, and idle wake-ups are gated by the same flag.
    expect(requests.length).toBe(1)
    client.close()
  })
})
