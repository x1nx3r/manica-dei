import { describe, expect, test } from "bun:test"
import { createFramebuffer, decodeCopyRect, decodeRaw, ZrleDecoder, type Rect } from "../src/decode"

// ZRLE and the simple encodings, pinned against the RFB specification.
//
// The fixtures are built here and then compressed with the platform's own
// deflate, so a decode is a real round trip rather than a hand-copied blob. A
// blob copied from a buggy encoder would only prove the bug is consistent.

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
const pixelAt = (framebuffer: ReturnType<typeof createFramebuffer>, x: number, y: number) => {
  const offset = (y * framebuffer.width + x) * 4
  return [framebuffer.data[offset], framebuffer.data[offset + 1], framebuffer.data[offset + 2]]
}

describe("decodeRaw", () => {
  test("places four-byte PIXELs row major", () => {
    const target = createFramebuffer(4, 2)
    // Four pixels of 32bpp, little-endian BGRX: red, green, blue, white, then
    // black repeated. Raw carries whole PIXELs, not ZRLE's 3-byte CPIXEL, and
    // reading three bytes per pixel desynchronises the next rect header.
    const px = (r: number, g: number, b: number) => [b, g, r, 0]
    const source = Uint8Array.from([
      ...px(255, 0, 0),
      ...px(0, 255, 0),
      ...px(0, 0, 255),
      ...px(255, 255, 255),
      ...px(0, 0, 0),
      ...px(0, 0, 0),
      ...px(0, 0, 0),
      ...px(0, 0, 0),
    ])
    const used = decodeRaw(source, rect(0, 0, 4, 2), target)
    expect(used).toBe(32)
    expect(pixelAt(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(target, 1, 0)).toEqual([0, 255, 0])
    expect(pixelAt(target, 2, 0)).toEqual([0, 0, 255])
    expect(pixelAt(target, 3, 0)).toEqual([255, 255, 255])
    expect(pixelAt(target, 0, 1)).toEqual([0, 0, 0])
  })

  test("respects the rectangle offset", () => {
    const target = createFramebuffer(8, 8)
    decodeRaw(Uint8Array.from([3, 2, 1, 0]), rect(3, 5, 1, 1), target)
    expect(pixelAt(target, 3, 5)).toEqual([1, 2, 3])
    expect(pixelAt(target, 0, 0)).toEqual([0, 0, 0])
  })

  test("fails loudly when the payload is short", () => {
    const target = createFramebuffer(4, 4)
    expect(() => decodeRaw(Uint8Array.from([1, 2, 3]), rect(0, 0, 2, 2), target)).toThrow(/wanted 16 bytes/)
  })
})

describe("decodeCopyRect", () => {
  test("copies a region from elsewhere in the framebuffer", () => {
    const target = createFramebuffer(8, 8)
    // Paint a red block at (0,0) then copy it to (4,4).
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const offset = (y * 8 + x) * 4
        target.data[offset] = 255
        target.data[offset + 3] = 255
      }
    const source = Uint8Array.from([0, 0, 0, 0])
    decodeCopyRect(source, rect(4, 4, 2, 2), target)
    expect(pixelAt(target, 4, 4)).toEqual([255, 0, 0])
    expect(pixelAt(target, 5, 5)).toEqual([255, 0, 0])
    expect(pixelAt(target, 6, 6)).toEqual([0, 0, 0])
  })

  test("handles an overlapping copy without smearing", () => {
    // A one pixel shift to the right must not duplicate the first column.
    const target = createFramebuffer(4, 1)
    const set = (x: number, r: number) => {
      target.data[x * 4] = r
      target.data[x * 4 + 3] = 255
    }
    set(0, 10)
    set(1, 20)
    set(2, 30)
    decodeCopyRect(Uint8Array.from([0, 0, 0, 0]), rect(1, 0, 2, 1), target)
    expect(pixelAt(target, 1, 0)[0]).toBe(10)
    expect(pixelAt(target, 2, 0)[0]).toBe(20)
  })
})

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate")
  const writer = stream.writable.getWriter()
  void writer.write(input)
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

// ZRLE, against the pull interface.
//
// Each fixture builds the inflated bytes a tile would decompress to, then
// compresses them with pako — which is what the server does. The decoder takes
// only the compressed form, so a test cannot accidentally assert against a
// shape the wire never carries. That mistake is exactly what hid the earlier
// whole-rect design.

/** Compress a tile's inflated bytes into the stream a rect carries. */
const compress = (inflated: number[]) => deflate(Uint8Array.from(inflated))
const pixel = (framebuffer: ReturnType<typeof createFramebuffer>, x: number, y: number) => {
  const o = (y * framebuffer.width + x) * 4
  return [framebuffer.data[o], framebuffer.data[o + 1], framebuffer.data[o + 2]]
}
/** A CPIXEL is three bytes, little-endian BGR (the low three of a 32bpp pixel). */
const cpixel = (r: number, g: number, b: number) => [b, g, r]

describe("ZrleDecoder", () => {
  test("a solid tile fills the rectangle", async () => {
    const target = createFramebuffer(4, 4)
    const decoder = new ZrleDecoder()
    decoder.begin(await compress([1, ...cpixel(255, 0, 0)]))
    decoder.decodeRect(rect(0, 0, 4, 4), target)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(pixel(target, x, y)).toEqual([255, 0, 0])
  })

  test("a raw tile writes CPIXELs in order", async () => {
    const target = createFramebuffer(2, 1)
    const decoder = new ZrleDecoder()
    decoder.begin(await compress([0, ...cpixel(255, 0, 0), ...cpixel(0, 255, 0)]))
    decoder.decodeRect(rect(0, 0, 2, 1), target)
    expect(pixel(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixel(target, 1, 0)).toEqual([0, 255, 0])
  })

  test("a two colour palette uses one bit per pixel, leftmost is the high bit", async () => {
    const target = createFramebuffer(2, 1)
    const decoder = new ZrleDecoder()
    // subencoding 2, palette red then green, then 0b10000000: left is index 1.
    decoder.begin(await compress([2, ...cpixel(255, 0, 0), ...cpixel(0, 255, 0), 0b10000000]))
    decoder.decodeRect(rect(0, 0, 2, 1), target)
    expect(pixel(target, 0, 0)).toEqual([0, 255, 0])
    expect(pixel(target, 1, 0)).toEqual([255, 0, 0])
  })

  test("plain RLE expands a run, and 255 continues the length", async () => {
    const target = createFramebuffer(4, 1)
    const decoder = new ZrleDecoder()
    // subencoding 128, red, run length 4 as (4 - 1) = 3.
    decoder.begin(await compress([128, ...cpixel(255, 0, 0), 3]))
    decoder.decodeRect(rect(0, 0, 4, 1), target)
    for (let x = 0; x < 4; x++) expect(pixel(target, x, 0)).toEqual([255, 0, 0])
  })

  test("a run length at the continuation boundary decodes to 256", async () => {
    const target = createFramebuffer(64, 4)
    const decoder = new ZrleDecoder()
    // [255, 0] sums to 255, plus one, so 256 pixels. A 64x4 tile is 256 pixels.
    decoder.begin(await compress([128, ...cpixel(255, 0, 0), 255, 0]))
    decoder.decodeRect(rect(0, 0, 64, 4), target)
    expect(pixel(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixel(target, 63, 3)).toEqual([255, 0, 0])
  })

  test("palette RLE handles a bare index and a set-high-bit run", async () => {
    const target = createFramebuffer(3, 1)
    const decoder = new ZrleDecoder()
    // subencoding 130 means paletteSize 2, so two CPIXELs of palette.
    decoder.begin(await compress([130, ...cpixel(255, 0, 0), ...cpixel(255, 0, 0), 0, 128, 1]))
    decoder.decodeRect(rect(0, 0, 3, 1), target)
    for (let x = 0; x < 3; x++) expect(pixel(target, x, 0)).toEqual([255, 0, 0])
  })

  test("clips the last tile when the rectangle is not a multiple of 64", async () => {
    const target = createFramebuffer(70, 2)
    const decoder = new ZrleDecoder()
    // Two tiles across: a full 64x2 then a 6x2, each solid.
    decoder.begin(await compress([1, ...cpixel(255, 0, 0), 1, ...cpixel(0, 255, 0)]))
    decoder.decodeRect(rect(0, 0, 70, 2), target)
    expect(pixel(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixel(target, 63, 1)).toEqual([255, 0, 0])
    expect(pixel(target, 64, 0)).toEqual([0, 255, 0])
    expect(pixel(target, 69, 1)).toEqual([0, 255, 0])
  })

  test("fails loudly on an unsupported subencoding", async () => {
    const decoder = new ZrleDecoder()
    decoder.begin(await compress([17, 0, 0, 0]))
    expect(() => decoder.decodeRect(rect(0, 0, 1, 1), createFramebuffer(1, 1))).toThrow(/unsupported subencoding/)
  })

  test("carries one zlib stream across two rectangles", async () => {
    // The stream spans the connection, so a second rect inflates from the same
    // deflator rather than a fresh one. Compressing both together and feeding
    // them in order is what the server does.
    const both = await deflate(Uint8Array.from([1, ...cpixel(255, 0, 0), 1, ...cpixel(0, 0, 255)]))
    const decoder = new ZrleDecoder()
    const target = createFramebuffer(2, 1)
    // One stream, one begin: the decoder reads the first tile, then the second.
    decoder.begin(both)
    decoder.decodeRect(rect(0, 0, 1, 1), target)
    decoder.decodeRect(rect(1, 0, 1, 1), target)
    expect(pixel(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixel(target, 1, 0)).toEqual([0, 0, 255])
  })
})
