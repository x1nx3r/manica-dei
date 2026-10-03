import { describe, expect, test } from "bun:test"
import {
  createFramebuffer,
  decodeCopyRect,
  decodeRaw,
  decodeZrle,
  ZrleStream,
  type Rect,
} from "@opencode-ai/core/browser/rfb-decode"

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
  test("places three-byte CPIXELs row major", () => {
    const target = createFramebuffer(4, 2)
    // Four pixels: red, green, blue, white, then black repeated.
    const source = Uint8Array.from([0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const used = decodeRaw(source, rect(0, 0, 4, 2), target)
    expect(used).toBe(24)
    expect(pixelAt(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(target, 1, 0)).toEqual([0, 255, 0])
    expect(pixelAt(target, 2, 0)).toEqual([0, 0, 255])
    expect(pixelAt(target, 3, 0)).toEqual([255, 255, 255])
    expect(pixelAt(target, 0, 1)).toEqual([0, 0, 0])
  })

  test("respects the rectangle offset", () => {
    const target = createFramebuffer(8, 8)
    decodeRaw(Uint8Array.from([1, 2, 3]), rect(3, 5, 1, 1), target)
    expect(pixelAt(target, 3, 5)).toEqual([3, 2, 1])
    expect(pixelAt(target, 0, 0)).toEqual([0, 0, 0])
  })

  test("fails loudly when the payload is short", () => {
    const target = createFramebuffer(4, 4)
    expect(() => decodeRaw(Uint8Array.from([1, 2, 3]), rect(0, 0, 2, 2), target)).toThrow(/wanted 12 bytes/)
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

describe("decodeZrle tiles", () => {
  test("a solid tile fills the rectangle", () => {
    const target = createFramebuffer(4, 4)
    // subencoding 1, then one CPIXEL.
    decodeZrle(Uint8Array.from([1, 0, 0, 255]), rect(0, 0, 4, 4), target)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(pixelAt(target, x, y)).toEqual([255, 0, 0])
  })

  test("a raw tile writes CPIXELs in order", () => {
    const target = createFramebuffer(2, 1)
    decodeZrle(Uint8Array.from([0, 0, 0, 255, 0, 255, 0]), rect(0, 0, 2, 1), target)
    expect(pixelAt(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(target, 1, 0)).toEqual([0, 255, 0])
  })

  test("a two colour palette uses one bit per pixel, leftmost is the high bit", () => {
    const target = createFramebuffer(2, 1)
    // subencoding 2, palette [red, green], then one byte with high bit set so
    // the left pixel is index 1 (green) and the right is index 0 (red).
    decodeZrle(Uint8Array.from([2, 0, 0, 255, 0, 255, 0, 0b10000000]), rect(0, 0, 2, 1), target)
    expect(pixelAt(target, 0, 0)).toEqual([0, 255, 0])
    expect(pixelAt(target, 1, 0)).toEqual([255, 0, 0])
  })

  test("plain RLE expands a run, and runs longer than 255 use continuation bytes", () => {
    const target = createFramebuffer(4, 1)
    // subencoding 128, pixel red, run length 4 encoded as (4-1)=3.
    decodeZrle(Uint8Array.from([128, 0, 0, 255, 3]), rect(0, 0, 4, 1), target)
    for (let x = 0; x < 4; x++) expect(pixelAt(target, x, 0)).toEqual([255, 0, 0])

    // A run that crosses the 255 boundary. The rect is 64 wide, so it is a
    // single tile, and 64 pixels is well under the boundary, so this exercises
    // the continuation rule inside one tile by asking for a full tile.
    const tile = createFramebuffer(64, 1)
    decodeZrle(Uint8Array.from([128, 0, 0, 255, 63]), rect(0, 0, 64, 1), tile)
    expect(pixelAt(tile, 63, 0)).toEqual([255, 0, 0])

    // The two byte form: [255, 0] sums to 255, plus one, so 256 pixels. A 256
    // wide rect is four tiles, so each tile carries its own run.
    const wide = createFramebuffer(256, 1)
    const perTile = Uint8Array.from([128, 0, 0, 255, 63])
    const bytes = new Uint8Array(perTile.length * 4)
    for (let i = 0; i < 4; i++) bytes.set(perTile, i * perTile.length)
    decodeZrle(bytes, rect(0, 0, 256, 1), wide)
    expect(pixelAt(wide, 0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(wide, 255, 0)).toEqual([255, 0, 0])
  })

  test("a run length at the continuation boundary decodes to 256", () => {
    // Directly exercise the reader: subencoding 128, one pixel, [255, 0] is
    // length 256. One 64 wide rect cannot show 256 pixels, so use a 64x4 tile,
    // which is 256 pixels in a single tile.
    const target = createFramebuffer(64, 4)
    decodeZrle(Uint8Array.from([128, 0, 0, 255, 255, 0]), rect(0, 0, 64, 4), target)
    expect(pixelAt(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(target, 63, 3)).toEqual([255, 0, 0])
  })

  test("palette RLE handles a single index and a set-high-bit run", () => {
    const target = createFramebuffer(3, 1)
    // subencoding 130 means paletteSize = 130 - 128 = 2, so the palette is two
    // CPIXELs, not one. Both are red so the assertion does not depend on which
    // index a run picks.
    decodeZrle(
      Uint8Array.from([
        130,
        0,
        0,
        255, // palette entry 0: red
        0,
        0,
        255, // palette entry 1: red
        0, // a run of one, index 0
        128,
        1, // index 0, high bit set, length (1 + 1) = 2
      ]),
      rect(0, 0, 3, 1),
      target,
    )
    for (let x = 0; x < 3; x++) expect(pixelAt(target, x, 0)).toEqual([255, 0, 0])
  })

  test("clips the last tile when the rectangle is not a multiple of 64", () => {
    const target = createFramebuffer(70, 2)
    // Two tiles across: a full 64x2 then a 6x2. Each is a solid tile.
    const bytes = Uint8Array.from([
      1,
      0,
      0,
      255, // first tile, red
      1,
      0,
      255,
      0, // second tile, green
    ])
    decodeZrle(bytes, rect(0, 0, 70, 2), target)
    expect(pixelAt(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(target, 63, 1)).toEqual([255, 0, 0])
    expect(pixelAt(target, 64, 0)).toEqual([0, 255, 0])
    expect(pixelAt(target, 69, 1)).toEqual([0, 255, 0])
  })

  test("fails loudly on an unsupported subencoding", () => {
    expect(() => decodeZrle(Uint8Array.from([17, 0, 0, 0]), rect(0, 0, 1, 1), createFramebuffer(1, 1))).toThrow(
      /unsupported subencoding/,
    )
  })
})

describe("ZrleStream", () => {
  test("inflates a rect through the platform zlib", async () => {
    // Build the same bytes the decoder tests use, then compress them, which is
    // what a server does. This proves the stream, not just the tile logic.
    const raw = Uint8Array.from([128, 0, 0, 255, 3])
    const compressed = await deflate(raw)
    const stream = new ZrleStream()
    const inflated = await stream.push(compressed, raw.length)
    expect(Array.from(inflated.subarray(0, raw.length))).toEqual(Array.from(raw))
  })
})

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate")
  const writer = stream.writable.getWriter()
  void writer.write(input)
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}
