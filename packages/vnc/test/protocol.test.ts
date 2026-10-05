import { describe, expect, test } from "bun:test"
import {
  ByteQueue,
  encodeFramebufferUpdateRequest,
  encodeKeyEvent,
  encodePointerEvent,
  encodeSetEncodings,
  encodeSetPixelFormat,
  handshake,
  readMessage,
  ENCODING,
  ProtocolError,
} from "../src/protocol"
import { createFramebuffer, ZrleDecoder } from "../src/decode"

// The wire layout, pinned against rfbproto.rst. Several of these encode a bug
// that costs a whole session to find, because a malformed message makes the
// server hang up or desynchronises every later read.

const capture = () => {
  const written: Uint8Array[] = []
  return { written, transport: { write: (bytes: Uint8Array) => written.push(bytes) } }
}

const version = new TextEncoder().encode("RFB 003.008\n")
const bytes = (...values: number[]) => Uint8Array.from(values)

describe("ByteQueue", () => {
  test("hands out exact reads across chunks", async () => {
    const queue = new ByteQueue()
    queue.push(bytes(1, 2))
    queue.push(bytes(3, 4, 5))
    expect(await queue.take(2)).toEqual(bytes(1, 2))
    expect(await queue.take(3)).toEqual(bytes(3, 4, 5))
  })

  test("waits for a read that has not arrived yet", async () => {
    const queue = new ByteQueue()
    const pending = queue.take(4)
    queue.push(bytes(9, 9))
    queue.push(bytes(8, 8))
    expect(await pending).toEqual(bytes(9, 9, 8, 8))
  })

  test("reads 16 and 32 bit integers big-endian", async () => {
    const queue = new ByteQueue()
    queue.push(bytes(0x12, 0x34, 0x00, 0x00, 0x01, 0x02))
    expect(await queue.takeU16()).toBe(0x1234)
    expect(await queue.takeU32()).toBe(0x00000102)
  })

  test("reads a negative signed 32", async () => {
    const queue = new ByteQueue()
    // -239 as an unsigned 32 bit value.
    queue.push(bytes(0xff, 0xff, 0xff, 0x11))
    expect(await queue.takeI32()).toBe(-239)
  })

  // A whole ZRLE update arrives as many small TCP chunks. Taking a large rect
  // consumes several whole chunks, and the queue used to subtract the remaining
  // need rather than each chunk's own length. That under-counted the buffered
  // bytes, so a later read waited forever for bytes it already held — the pane
  // showed black while the server sent a full framebuffer. The reads below are
  // the shape that exposed it, and each is raced against a timeout so a
  // regression fails instead of hanging.
  test("counts buffered bytes across many small chunks", async () => {
    const queue = new ByteQueue()
    const total = 64
    for (let i = 0; i < total; i++) queue.push(bytes(i))
    expect(queue.buffered).toBe(total)

    const first = await queue.take(10)
    expect(first.length).toBe(10)
    expect(queue.buffered).toBe(total - 10)

    const second = await Promise.race([
      queue.take(20),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])
    expect(second).not.toBe("timeout")
    expect(second).toEqual(Uint8Array.from({ length: 20 }, (_, i) => i + 10))
    expect(queue.buffered).toBe(total - 30)
  })

  test("a read that spans whole chunks does not starve a later read", async () => {
    const queue = new ByteQueue()
    // Three-byte chunks so a take(2) leaves a partial head each time.
    for (let i = 0; i < 9; i++) queue.push(bytes(i * 3, i * 3 + 1, i * 3 + 2))
    expect(await queue.take(2)).toEqual(bytes(0, 1))
    // Consuming the whole second chunk must drop the count by three, not by
    // the remainder of the request.
    expect(await queue.take(4)).toEqual(bytes(2, 3, 4, 5))
    expect(queue.buffered).toBe(21)
  })
})

describe("encodeSetPixelFormat", () => {
  test("is exactly 20 bytes with two-byte max fields", () => {
    const encoded = encodeSetPixelFormat()
    // Getting this wrong was a real bug: one byte per max field makes it 17 and
    // every later message misaligns.
    expect(encoded.length).toBe(20)
    expect(encoded[4]).toBe(32) // bits per pixel
    expect(encoded[5]).toBe(24) // depth
    expect(encoded[6]).toBe(0) // little endian
    expect(encoded[7]).toBe(1) // true colour
    // Max fields use protocol byte order, so 255 is 00 ff.
    expect([encoded[8], encoded[9], encoded[10], encoded[11], encoded[12], encoded[13]]).toEqual([
      0, 255, 0, 255, 0, 255,
    ])
    expect([encoded[14], encoded[15], encoded[16]]).toEqual([16, 8, 0]) // red, green, blue shift
  })
})

describe("encodeFramebufferUpdateRequest", () => {
  test("puts width at offset 6 and height at 8", () => {
    const encoded = encodeFramebufferUpdateRequest(1280, 720, false)
    expect(encoded.length).toBe(10)
    expect(encoded[0]).toBe(3)
    expect(encoded[1]).toBe(0)
    // x and y stay zero.
    expect([encoded[2], encoded[3], encoded[4], encoded[5]]).toEqual([0, 0, 0, 0])
    expect((encoded[6]! << 8) | encoded[7]!).toBe(1280)
    expect((encoded[8]! << 8) | encoded[9]!).toBe(720)
  })

  test("marks an incremental request", () => {
    expect(encodeFramebufferUpdateRequest(1, 1, true)[1]).toBe(1)
  })
})

describe("input encoders", () => {
  test("KeyEvent is 8 bytes with the keysym big-endian", () => {
    const encoded = encodeKeyEvent(0xffe3, true)
    expect(encoded.length).toBe(8)
    expect(encoded[0]).toBe(4)
    expect(encoded[1]).toBe(1)
    expect(Array.from(encoded.subarray(4))).toEqual([0, 0, 0xff, 0xe3])
  })

  test("PointerEvent is 6 bytes", () => {
    const encoded = encodePointerEvent(640, 360, 16)
    expect(encoded.length).toBe(6)
    expect(encoded[0]).toBe(5)
    expect(encoded[1]).toBe(16)
    expect((encoded[2]! << 8) | encoded[3]!).toBe(640)
    expect((encoded[4]! << 8) | encoded[5]!).toBe(360)
  })
})

describe("encodeSetEncodings", () => {
  test("carries a signed encoding number", () => {
    const encoded = encodeSetEncodings([16, -239])
    expect(encoded[0]).toBe(2)
    expect((encoded[2]! << 8) | encoded[3]!).toBe(2)
    expect(encoded[4]).toBe(0)
    expect(encoded[7]).toBe(16)
    // -239 as four bytes.
    expect(Array.from(encoded.subarray(8, 12))).toEqual([0xff, 0xff, 0xff, 0x11])
  })
})

describe("handshake", () => {
  const serverInitBytes = (width: number, height: number, name: string) => {
    const nameBytes = new TextEncoder().encode(name)
    const out = new Uint8Array(24 + nameBytes.length)
    out[0] = (width >> 8) & 0xff
    out[1] = width & 0xff
    out[2] = (height >> 8) & 0xff
    out[3] = height & 0xff
    // The pixel format is accepted as-is, bytes 4 to 19.
    out[20] = (nameBytes.length >> 24) & 0xff
    out[21] = (nameBytes.length >> 16) & 0xff
    out[22] = (nameBytes.length >> 8) & 0xff
    out[23] = nameBytes.length & 0xff
    out.set(nameBytes, 24)
    return out
  }

  test("negotiates None and reads ServerInit", async () => {
    const queue = new ByteQueue()
    const { written, transport } = capture()
    queue.push(version)
    queue.push(bytes(1)) // one security type
    queue.push(bytes(1)) // which is None
    queue.push(bytes(0, 0, 0, 0)) // security result ok
    queue.push(serverInitBytes(1280, 720, "root@host"))

    const init = await handshake(queue, transport)
    expect(init).toEqual({ width: 1280, height: 720, name: "root@host" })
    // Version echoed, security chosen, ClientInit shared.
    expect(new TextDecoder().decode(written[0])).toBe("RFB 003.008\n")
    expect(written[1]).toEqual(bytes(1))
    expect(written[2]).toEqual(bytes(1))
  })

  test("rejects a version it cannot speak", async () => {
    const queue = new ByteQueue()
    const { transport } = capture()
    queue.push(new TextEncoder().encode("RFB 003.889\n"))
    await expect(handshake(queue, transport)).rejects.toThrow(/only .* is supported/)
  })

  test("reports a refusal reason when the type count is zero", async () => {
    const queue = new ByteQueue()
    const { transport } = capture()
    const reason = new TextEncoder().encode("too many")
    queue.push(version)
    queue.push(bytes(0))
    queue.push(bytes(0, 0, 0, reason.length))
    queue.push(reason)
    await expect(handshake(queue, transport)).rejects.toThrow(/too many/)
  })

  test("rejects a server that offers no None security", async () => {
    const queue = new ByteQueue()
    const { transport } = capture()
    queue.push(version)
    queue.push(bytes(1, 2)) // a single type, number 2
    await expect(handshake(queue, transport)).rejects.toThrow(/none of which is None/)
  })
})

describe("readMessage", () => {
  const target = () => createFramebuffer(4, 2)
  const zrle = () => new ZrleDecoder()

  test("applies a Raw rect", async () => {
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0, // message type framebuffer update, padding, high byte of count
        1, // one rectangle
        0,
        0,
        0,
        0, // x, y
        0,
        2,
        0,
        1, // width 2, height 1
        0,
        0,
        0,
        0, // encoding raw
        // Two 32bpp PIXELs, little-endian BGRX: red then green.
        0,
        0,
        255,
        0, // red
        0,
        255,
        0,
        0, // green
      ),
    )
    const framebuffer = target()
    const update = await readMessage(queue, framebuffer, zrle())
    expect(update).toEqual({ kind: "rects", rects: 1, changed: true })
    expect(Array.from(framebuffer.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(framebuffer.data.slice(4, 8))).toEqual([0, 255, 0, 255])
  })

  test("decodes a cursor rect and keeps the stream aligned", async () => {
    // The cursor pseudo-rect's payload is the pixels and the mask, written
    // directly. There is no nested rect. The rect's own x and y are the
    // hotspot, not a framebuffer position.
    //
    // An earlier version read a nested rect header here. It never surfaced
    // because the client requested no cursor; a live Xvnc desynchronised on the
    // first cursor the moment -239 was requested.
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0,
        2, // update, padding, two rectangles
        // cursor pseudo rect: hotspot (1,2), size 2x2, encoding -239
        0,
        1,
        0,
        2,
        0,
        2,
        0,
        2,
        0xff,
        0xff,
        0xff,
        0x11,
        // pixels: 2x2 of 32bpp, blue-green-red in memory. Four opaque, then the
        // mask marks the third pixel transparent.
        0,
        0,
        255,
        0,
        0,
        0,
        255,
        0,
        0,
        0,
        255,
        0,
        0,
        0,
        255,
        0,
        // mask: row padded to one byte, MSB leftmost. 0b1100 = valid, valid,
        // transparent, transparent on the top row; none on the bottom.
        0xc0,
        0x00,
        // the real rect, a 2x1 raw at 0,0
        0,
        0,
        0,
        0,
        0,
        2,
        0,
        1,
        0,
        0,
        0,
        0,
        // two PIXELs: red, then green.
        0,
        0,
        255,
        0,
        0,
        255,
        0,
        0,
      ),
    )
    const framebuffer = target()
    const update = await readMessage(queue, framebuffer, zrle())
    expect(update.kind).toBe("rects")
    if (update.kind !== "rects") throw new Error("expected a framebuffer update")
    // The cursor was decoded, with the hotspot from the header's x and y.
    expect(update.cursor?.width).toBe(2)
    expect(update.cursor?.height).toBe(2)
    expect(update.cursor?.hotspotX).toBe(1)
    expect(update.cursor?.hotspotY).toBe(2)
    // The mask set alpha: 255 where the bit is 1, 0 where it is not.
    expect(update.cursor?.pixels[3]).toBe(255)
    expect(update.cursor?.pixels[11]).toBe(0)
    // The real rect was still reached and applied, which only happens if the
    // cursor rect was consumed exactly.
    expect(Array.from(framebuffer.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(framebuffer.data.slice(4, 8))).toEqual([0, 255, 0, 255])
  })

  test("a zero-sized cursor means no cursor", async () => {
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0,
        1, // update, padding, one rectangle
        // cursor pseudo rect at 0,0 sized 0x0
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0xff,
        0xff,
        0xff,
        0x11,
      ),
    )
    const update = await readMessage(queue, target(), zrle())
    if (update.kind !== "rects") throw new Error("expected a framebuffer update")
    expect(update.cursor?.width).toBe(0)
    expect(update.cursor?.height).toBe(0)
    expect(update.cursor?.pixels.length).toBe(0)
  })

  test("a resize and a cursor in one update are both reported", async () => {
    // Xvnc sends both in the same FramebufferUpdate. An earlier shape returned
    // one or the other, so the cursor was dropped whenever a resize came with
    // it, and the cursor never reached the caller.
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0,
        2, // update, padding, two rectangles
        // cursor, 0x0
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0xff,
        0xff,
        0xff,
        0x11,
        // extended desktop size 8x4, reason 0
        0,
        0,
        0,
        0,
        0,
        8,
        0,
        4,
        0xff,
        0xff,
        0xfe,
        0xcc,
        1,
        0,
        0,
        0, // one screen, padding
        0,
        0,
        0,
        1, // id
        0,
        0,
        0,
        0, // x, y
        0,
        8,
        0,
        4, // width, height
        0,
        0,
        0,
        0, // flags
      ),
    )
    const update = await readMessage(queue, target(), zrle())
    if (update.kind !== "rects") throw new Error("expected a framebuffer update")
    expect(update.size?.width).toBe(8)
    expect(update.size?.reason).toBe(0)
    expect(update.cursor?.width).toBe(0)
  })

  test("decodes an X cursor and keeps the stream aligned", async () => {
    // We request the rich cursor, so a server should send that, but the spec
    // says to cope with either and a reader that does not know -240 would
    // desynchronise. The payload is two colours, then a bitmap, then a mask.
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0,
        2, // update, padding, two rectangles
        // X cursor: hotspot (1,0), size 2x1, encoding -240
        0,
        1,
        0,
        0,
        0,
        2,
        0,
        1,
        0xff,
        0xff,
        0xff,
        0x10,
        // primary rgb (red), secondary rgb (blue)
        255,
        0,
        0,
        0,
        0,
        255,
        // bitmap 2x1: left pixel primary, right pixel secondary = 0b10000000
        0x80,
        // mask 2x1: both valid = 0b11000000
        0xc0,
        // the real rect, a 2x1 raw at 0,0
        0,
        0,
        0,
        0,
        0,
        2,
        0,
        1,
        0,
        0,
        0,
        0,
        // two PIXELs: green, then red
        0,
        255,
        0,
        0,
        0,
        0,
        255,
        0,
      ),
    )
    const framebuffer = target()
    const update = await readMessage(queue, framebuffer, zrle())
    if (update.kind !== "rects") throw new Error("expected a framebuffer update")
    expect(update.cursor?.hotspotX).toBe(1)
    // Left pixel uses the primary colour, right the secondary.
    expect(Array.from(update.cursor!.pixels.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(update.cursor!.pixels.slice(4, 8))).toEqual([0, 0, 255, 255])
    // And the real rect was still reached.
    expect(Array.from(framebuffer.data.slice(0, 4))).toEqual([0, 255, 0, 255])
  })

  test("reports a bell without touching the framebuffer", async () => {
    const queue = new ByteQueue()
    queue.push(bytes(2))
    const update = await readMessage(queue, target(), zrle())
    expect(update.kind).toBe("bell")
  })

  test("reads server cut text", async () => {
    const queue = new ByteQueue()
    const text = new TextEncoder().encode("hello")
    queue.push(bytes(3, 0, 0, 0, 0, 0, 0, text.length))
    queue.push(text)
    const update = await readMessage(queue, target(), zrle())
    expect(update).toEqual({ kind: "cut", text: "hello" })
  })

  test("fails loudly on an unknown message type", async () => {
    const queue = new ByteQueue()
    queue.push(bytes(99))
    await expect(readMessage(queue, target(), zrle())).rejects.toThrow(ProtocolError)
  })

  test("skips LastRect without applying it", async () => {
    const queue = new ByteQueue()
    queue.push(bytes(0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x20)) // -224
    const update = await readMessage(queue, target(), zrle())
    expect(update).toEqual({ kind: "rects", rects: 1, changed: false })
  })

  test("applies a CopyRect off another region", async () => {
    const framebuffer = target()
    // Paint (0,0) red first, as a real framebuffer would already hold it.
    framebuffer.data[0] = 255
    framebuffer.data[3] = 255

    // Rect header is x(2) y(2) width(2) height(2) encoding(4), then the
    // CopyRect payload is source x(2) y(2).
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0,
        1, // update, padding, one rectangle
        0,
        1, // x = 1
        0,
        0, // y = 0
        0,
        1, // width = 1
        0,
        1, // height = 1
        0,
        0,
        0,
        1, // encoding = CopyRect
        0,
        0, // source x = 0
        0,
        0, // source y = 0
      ),
    )
    const update = await readMessage(queue, framebuffer, zrle())
    expect(update.kind).toBe("rects")
    // Pixel (1,0) is at byte offset 4 and copied the red from (0,0).
    expect(framebuffer.data[4]).toBe(255)
  })
})
