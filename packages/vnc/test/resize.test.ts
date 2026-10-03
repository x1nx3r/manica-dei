import { describe, expect, test } from "bun:test"
import { start } from "../src/client"
import { ByteQueue } from "../src/protocol"
import type { DesktopSize, Framebuffer } from "../src/index"
import { extendedDesktopSize, fakeServer, rawUpdate } from "./fake-server"

// Resizing, against a fake server.
//
// The behaviour that matters is not "a resize happened" but that it cannot loop.
// The specification names the loop twice: a client that answers a resize with a
// non-incremental request, and a client that asks for the size it already has.
// Both are asserted here, because both are silent when they break.

/** Message type 251 is SetDesktopSize. */
const isResize = (bytes: Uint8Array) => bytes[0] === 251
/** Message type 3 is FramebufferUpdateRequest; byte 1 is the incremental flag. */
const isRequest = (bytes: Uint8Array) => bytes[0] === 3

describe("rfb client resize", () => {
  test("resize writes a well-formed SetDesktopSize message", async () => {
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    client.resize(1024, 768)
    const message = server.written.find(isResize)
    expect(message).toBeDefined()
    // width and height sit at offsets 2 and 4, after type and padding.
    expect((message![2]! << 8) | message![3]!).toBe(1024)
    expect((message![4]! << 8) | message![5]!).toBe(768)
    // One screen, sixteen bytes.
    expect(message![6]).toBe(1)
    expect(message!.length).toBe(8 + 16)
    client.close()
  })

  test("a resize to the current size writes nothing", async () => {
    // The fake server starts at 4x2. Asking for 4x2 must be silent, because a
    // server may answer a no-op with a resize rect, and a client that answers
    // that can loop.
    const server = fakeServer([])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    client.resize(4, 2)
    expect(server.written.filter(isResize).length).toBe(0)
    client.close()
  })

  test("an ExtendedDesktopSize reply updates the geometry and the framebuffer", async () => {
    const server = fakeServer([extendedDesktopSize(8, 4, { reason: 1, status: 0 })])
    const queue = new ByteQueue()
    server.begin(queue)
    const sizes: DesktopSize[] = []
    const client = await start(server.transport, { queue, onDesktopSize: (size) => sizes.push(size) })
    await Bun.sleep(30)
    expect(sizes.length).toBeGreaterThan(0)
    expect(sizes[0]!.reason).toBe(1)
    expect(sizes[0]!.status).toBe(0)
    // The framebuffer was replaced, and the getter sees the new one.
    expect(client.framebuffer.width).toBe(8)
    expect(client.framebuffer.height).toBe(4)
    expect(client.framebuffer.data.length).toBe(8 * 4 * 4)
    client.close()
  })

  test("a denied resize does not change the geometry", async () => {
    const server = fakeServer([extendedDesktopSize(8, 4, { reason: 1, status: 3 })])
    const queue = new ByteQueue()
    server.begin(queue)
    const sizes: DesktopSize[] = []
    const client = await start(server.transport, { queue, onDesktopSize: (size) => sizes.push(size) })
    await Bun.sleep(30)
    // The reply is reported, with the error status, but the size is unchanged.
    expect(sizes.length).toBeGreaterThan(0)
    expect(sizes[sizes.length - 1]!.status).toBe(3)
    expect(client.framebuffer.width).toBe(4)
    expect(client.framebuffer.height).toBe(2)
    client.close()
  })

  test("the request after a resize stays incremental", async () => {
    // This is the loop guard, and the assertion that matters most. Dropping the
    // framebuffer and then asking non-incrementally is the combination the
    // specification calls dangerous: the server treats the whole screen as
    // modified and the two bounce forever.
    const server = fakeServer([rawUpdate(2, 1, [255, 0, 0]), extendedDesktopSize(8, 4, { reason: 1 })])
    const queue = new ByteQueue()
    server.begin(queue)
    const frames: Framebuffer[] = []
    const client = await start(server.transport, { queue, onFrame: (framebuffer) => frames.push(framebuffer) })
    await Bun.sleep(60)
    const requests = server.written.filter(isRequest)
    // The very first request is non-incremental: it asks for the whole screen.
    expect(requests[0]?.[1]).toBe(0)
    // Every request after the first frame or resize is incremental.
    const after = requests.slice(1)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((request) => request[1] === 1)).toBe(true)
    client.close()
  })

  test("a state report does not make the client ask non-incrementally again", async () => {
    // A live Xvnc sends an ExtendedDesktopSize state report in reply to every
    // non-incremental request. A client that treats the report as "nothing
    // received" keeps asking non-incrementally, so the server replies with the
    // same rect forever. The rule answers every non-incremental request, so a
    // buggy client collects reports without bound. A correct client sends one
    // non-incremental request, learns it is received, and goes incremental.
    const server = fakeServer([])
    server.rule((request, reply) => {
      if (request[0] === 3 && request[1] === 0) reply(extendedDesktopSize(4, 2, { reason: 0 }))
    })
    const queue = new ByteQueue()
    server.begin(queue)
    const sizes: DesktopSize[] = []
    const client = await start(server.transport, { queue, onDesktopSize: (size) => sizes.push(size) })
    await Bun.sleep(120)
    // The only non-incremental request is the first, so exactly one report.
    expect(sizes.length).toBe(1)
    client.close()
  })

  test("a frame drawn after a resize goes into the new framebuffer", async () => {
    const server = fakeServer([extendedDesktopSize(8, 4, { reason: 1 }), rawUpdate(8, 4, [0, 255, 0])])
    const queue = new ByteQueue()
    server.begin(queue)
    const client = await start(server.transport, { queue })
    await Bun.sleep(60)
    // The getter must reflect the resize, and the pixel must be in the buffer
    // of the new size — not a stale 4x2 one.
    expect(client.framebuffer.width).toBe(8)
    expect(Array.from(client.framebuffer.data.slice(0, 4))).toEqual([0, 255, 0, 255])
    client.close()
  })
})
