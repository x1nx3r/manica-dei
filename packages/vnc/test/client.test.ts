import { describe, expect, test } from "bun:test"
import { start } from "../src/client"
import { ByteQueue } from "../src/protocol"
import type { Framebuffer } from "../src/decode"
import { bell, fakeServer, rawUpdate } from "./fake-server"

// The client loop, against a fake server.
//
// The two behaviours worth pinning are the ones naive clients get wrong: a
// still page must still be asked about, and a frame must only be announced when
// pixels actually changed. Both are asserted here rather than by inspection.

describe("rfb client", () => {
  test("completes the handshake and exposes a framebuffer of the server size", async () => {
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
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

  test("keeps asking while the server stays silent, without unbounded growth", async () => {
    // The server never answers. An incremental request is allowed to sit
    // unanswered until the screen changes, so the client must keep asking
    // rather than waiting for an answer — that wait is what makes a static page
    // stay black forever. The count is bounded so it does not hog the network.
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue, idleRequestsPerSecond: 200 })
    await Bun.sleep(80)
    const requests = server.written.filter((bytes) => bytes[0] === 3)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.length).toBeLessThanOrEqual(4)
    client.close()
  })

  test("the first request asks for the whole framebuffer, later ones for changes", async () => {
    const server = fakeServer([rawUpdate(2, 1, [255, 0, 0])])
    const queue = new ByteQueue()
    server.begin(queue)
    const frames: unknown[] = []
    const client = await start(server.transport, { queue, onFrame: () => frames.push(1) })
    await Bun.sleep(60)
    const requests = server.written.filter((bytes) => bytes[0] === 3)
    // incremental is byte 1: zero means send the entire area.
    expect(requests[0]?.[1]).toBe(0)
    // Once a frame has arrived the client only asks for differences. This is
    // asserted only when a frame actually arrived, because the fake answers one
    // request and the ordering of the rest is its own artefact.
    if (frames.length > 0) {
      expect(requests[requests.length - 1]?.[1]).toBe(1)
    } else {
      expect(requests.every((r) => r[1] === 0)).toBe(true)
    }
    client.close()
  })
})
