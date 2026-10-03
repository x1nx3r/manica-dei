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
} from "@opencode-ai/core/browser/rfb-protocol"
import { createFramebuffer, ZrleStream } from "@opencode-ai/core/browser/rfb-decode"

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
  const zrle = () => new ZrleStream()

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
        0,
        0,
        255, // red
        0,
        255,
        0, // green
      ),
    )
    const framebuffer = target()
    const update = await readMessage(queue, framebuffer, zrle())
    expect(update).toEqual({ kind: "rects", rects: 1, changed: true })
    expect(Array.from(framebuffer.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(framebuffer.data.slice(4, 8))).toEqual([0, 255, 0, 255])
  })

  test("consumes the cursor pseudo rect so the stream stays aligned", async () => {
    // A cursor rect is a header, then its own rect whose pixel data must be
    // read. Treating the pseudo rect as payload-less desynchronises everything
    // after it, which is the trap this pins.
    const queue = new ByteQueue()
    queue.push(
      bytes(
        0,
        0,
        0,
        2, // update, padding, two rectangles
        // cursor pseudo rect at 0,0 sized 2x2
        0,
        0,
        0,
        0,
        0,
        2,
        0,
        2,
        0xff,
        0xff,
        0xff,
        0x11, // encoding -239
        // its pixel rect
        0,
        0,
        0,
        0,
        0,
        2,
        0,
        2,
        0,
        0,
        0,
        0, // encoding raw
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12, // 2x2 of three byte pixels
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
        0,
        0,
        255,
        0,
        255,
        0,
      ),
    )
    const framebuffer = target()
    const update = await readMessage(queue, framebuffer, zrle())
    expect(update.kind).toBe("rects")
    // The real rect was reached and applied, which only happens if the cursor
    // rect was consumed exactly.
    expect(Array.from(framebuffer.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(framebuffer.data.slice(4, 8))).toEqual([0, 255, 0, 255])
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
