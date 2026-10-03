import { describe, expect, test } from "bun:test"
import { start } from "../src/client"
import { ByteQueue } from "../src/protocol"
import type { Cursor } from "../src/index"
import { cursorUpdate, extendedDesktopSize, fakeServer } from "./fake-server"

// The cursor, against a fake server.
//
// A live Xvnc on a headless display always sends a zero-sized cursor, so the
// non-zero shape cannot be exercised against the real server in this
// environment. The byte layout is fixed by the specification, and it is pinned
// here with a hand-built rect so the decode is proven even when no live server
// produces one.

describe("rfb client cursor", () => {
  test("reports a cursor shape with its hotspot", async () => {
    const server = fakeServer([cursorUpdate(2, 2, { hotspotX: 1, hotspotY: 2, rgb: [10, 20, 30] })])
    const queue = new ByteQueue()
    server.begin(queue)
    const cursors: Cursor[] = []
    const client = await start(server.transport, { queue, onCursor: (cursor) => cursors.push(cursor) })
    await Bun.sleep(30)
    expect(cursors.length).toBe(1)
    const cursor = cursors[0]!
    expect(cursor.width).toBe(2)
    expect(cursor.height).toBe(2)
    // The header's x and y are the hotspot, not a framebuffer position.
    expect(cursor.hotspotX).toBe(1)
    expect(cursor.hotspotY).toBe(2)
    // The pixel is RGBA, in that byte order, with alpha from the mask.
    expect(Array.from(cursor.pixels.slice(0, 4))).toEqual([10, 20, 30, 255])
    client.close()
  })

  test("a mask bit of zero makes a pixel transparent", async () => {
    // The top-left pixel is kept and the one beside it dropped.
    const server = fakeServer([cursorUpdate(2, 1, { alpha: (x) => x === 0 })])
    const queue = new ByteQueue()
    server.begin(queue)
    const cursors: Cursor[] = []
    const client = await start(server.transport, { queue, onCursor: (cursor) => cursors.push(cursor) })
    await Bun.sleep(30)
    const cursor = cursors[0]!
    expect(cursor.pixels[3]).toBe(255)
    expect(cursor.pixels[7]).toBe(0)
    client.close()
  })

  test("a zero-sized cursor is delivered as an empty shape", async () => {
    // A headless Xvnc sends this: no local cursor, so the pane draws its own.
    const server = fakeServer([cursorUpdate(0, 0)])
    const queue = new ByteQueue()
    server.begin(queue)
    const cursors: Cursor[] = []
    const client = await start(server.transport, { queue, onCursor: (cursor) => cursors.push(cursor) })
    await Bun.sleep(30)
    expect(cursors.length).toBe(1)
    expect(cursors[0]!.width).toBe(0)
    expect(cursors[0]!.pixels.length).toBe(0)
    client.close()
  })

  test("a cursor and a resize in one update both arrive", async () => {
    // A live Xvnc sends these together. When the update reported only one, the
    // cursor was dropped whenever a resize accompanied it.
    const server = fakeServer([new Uint8Array([...cursorUpdate(0, 0), ...extendedDesktopSize(8, 4, { reason: 0 })])])
    const queue = new ByteQueue()
    server.begin(queue)
    const cursors: Cursor[] = []
    const sizes: number[] = []
    const client = await start(server.transport, {
      queue,
      onCursor: (cursor) => cursors.push(cursor),
      onDesktopSize: (size) => sizes.push(size.width),
    })
    await Bun.sleep(30)
    expect(cursors.length).toBe(1)
    expect(sizes).toEqual([8])
    client.close()
  })

  test("the stream stays aligned across repeated cursor changes", async () => {
    // Xvnc sends a cursor rect on every change, and a headless display sends
    // zero-sized ones in a stream. A framing mistake shows up as the reader
    // stalling on the second.
    const server = fakeServer([cursorUpdate(0, 0), cursorUpdate(0, 0), cursorUpdate(0, 0)])
    const queue = new ByteQueue()
    server.begin(queue)
    const cursors: Cursor[] = []
    const client = await start(server.transport, { queue, onCursor: (cursor) => cursors.push(cursor) })
    await Bun.sleep(60)
    expect(cursors.length).toBeGreaterThanOrEqual(2)
    client.close()
  })
})
