// ZRLE decoding, driving an exact-count inflate field by field.
//
// The shape here is the part that matters, and it was wrong at first. ZRLE
// cannot be decoded by inflating the whole rectangle and then parsing it: the
// inflated size is not derivable from the header, because a solid tile of a
// 64x64 rect is four bytes while a raw tile of the same rect is twelve
// thousand. A client that tries to size the whole rect first must guess, and
// the guess is wrong in both directions.
//
// So the decoder pulls. It inflates one field at a time — the subencoding, then
// the pixels it implies, then the next field — and the size is always known
// exactly. The one zlib stream spans the connection and is never reset.
//
// The reference for this shape is noVNC's `core/decoders/zrle.js` and its
// `core/inflator.js`, studied in `ref/` and recorded in
// `ref/ZRLE-REFERENCE.md`. That code is MPL-2.0 and is not copied; the layout
// it demonstrates is in the RFB specification, which is what this follows.

import { Inflator, InflateError } from "./rfb-inflate"

const TILE = 64
const BYTES_PER_CPIXEL = 3

export type Rect = { x: number; y: number; width: number; height: number }

export type Framebuffer = {
  width: number
  height: number
  // RGBA, 4 bytes per pixel, row major.
  data: Uint8Array
}

export function createFramebuffer(width: number, height: number): Framebuffer {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

/** Write RGB bytes from `source` at `at` into the framebuffer as RGBA. */
function writePixel(target: Framebuffer, x: number, y: number, source: Uint8Array, at = 0) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return
  const offset = (y * target.width + x) * 4
  target.data[offset] = source[at] ?? 0
  target.data[offset + 1] = source[at + 1] ?? 0
  target.data[offset + 2] = source[at + 2] ?? 0
  target.data[offset + 3] = 255
}

/**
 * Write a CPIXEL, which is B, G, R in the negotiated little-endian order.
 *
 * Kept separate from `writePixel` on purpose: a CPIXEL is a ZRLE type and its
 * bytes are reversed relative to the RGB a caller usually has. Folding the two
 * together broke Raw and CopyRect, which carry whole PIXELs already in order.
 */
function writeCPixel(target: Framebuffer, x: number, y: number, source: Uint8Array, at = 0) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return
  const offset = (y * target.width + x) * 4
  target.data[offset] = source[at + 2] ?? 0
  target.data[offset + 1] = source[at + 1] ?? 0
  target.data[offset + 2] = source[at] ?? 0
  target.data[offset + 3] = 255
}

/**
 * The ZRLE decoder for one connection.
 *
 * Holds the single zlib stream, which spans every rectangle, and the compressed
 * bytes for the rectangle currently being decoded.
 */
export class ZrleDecoder {
  private readonly inflator = new Inflator()
  // The unsent compressed bytes for the current rect. The inflator takes what
  // it needs for each field, so the decoder tracks its own position.
  private compressed: Uint8Array = new Uint8Array(0)
  private position = 0

  /** Begin a rectangle. The stream itself is not reset. */
  begin(compressed: Uint8Array) {
    this.compressed = compressed
    this.position = 0
  }

  /** Inflate exactly `count` bytes, consuming compressed input as needed. */
  private take(count: number): Uint8Array {
    const remaining = this.compressed.subarray(this.position)
    const out = this.inflator.inflate(remaining, count)
    // Advance by what this call consumed. `remaining()` is measured against the
    // subarray just passed, so subtracting it from the whole buffer would
    // overshoot on every call after the first.
    this.position += remaining.length - this.inflator.remaining()
    return out
  }

  /**
   * Read one CPIXEL.
   *
   * Copied rather than returned as a view. The inflator hands back a view over
   * one shared buffer, so a held view is overwritten by the next field read —
   * which showed up as a run length byte landing in the blue channel of the
   * previous pixel. Any value that outlives the next `take` must be a copy.
   */
  private readCPixel(): Uint8Array {
    return Uint8Array.from(this.take(BYTES_PER_CPIXEL))
  }

  /** A run length: bytes summing to length - 1, with 255 continuing. */
  private readRunLength(): number {
    let length = 0
    for (;;) {
      const byte = this.take(1)[0]!
      length += byte
      if (byte !== 255) return length + 1
    }
  }

  decodeRect(rect: Rect, target: Framebuffer): void {
    for (let tileY = 0; tileY < rect.height; tileY += TILE) {
      const height = Math.min(TILE, rect.height - tileY)
      for (let tileX = 0; tileX < rect.width; tileX += TILE) {
        const width = Math.min(TILE, rect.width - tileX)
        this.decodeTile(rect.x + tileX, rect.y + tileY, width, height, target)
      }
    }
  }

  private decodeTile(x: number, y: number, width: number, height: number, target: Framebuffer) {
    const subencoding = this.take(1)[0]!
    const total = width * height
    // Runs cross rows, so index the tile linearly and derive coordinates.
    const at = (index: number): [number, number] => [x + (index % width), y + Math.floor(index / width)]

    if (subencoding === 0) {
      // Raw: total CPIXELs, one inflate for the whole field.
      const pixels = Uint8Array.from(this.take(total * BYTES_PER_CPIXEL))
      for (let index = 0; index < total; index++) {
        const [px, py] = at(index)
        writeCPixel(target, px, py, pixels, index * BYTES_PER_CPIXEL)
      }
      return
    }

    if (subencoding === 1) {
      const colour = this.readCPixel()
      for (let index = 0; index < total; index++) {
        const [px, py] = at(index)
        writeCPixel(target, px, py, colour)
      }
      return
    }

    if (subencoding >= 2 && subencoding <= 16) {
      const paletteSize = subencoding
      const palette = Uint8Array.from(this.take(paletteSize * BYTES_PER_CPIXEL))
      const bits = paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : 4
      const mask = (1 << bits) - 1
      const perByte = Math.floor(8 / bits)

      // The high bits are the leftmost pixels, and each row is padded to a whole
      // byte, so a fresh byte is read at the start of every row. `used` starts
      // at `perByte` so the first pixel of the first row takes a byte rather
      // than reading from an uninitialised one.
      let index = 0
      for (let row = 0; row < height; row++) {
        let byte = 0
        let used = perByte
        for (let column = 0; column < width; column++) {
          if (used === perByte) {
            byte = this.take(1)[0]!
            used = 0
          }
          const shift = 8 - bits * (used + 1)
          const paletteIndex = (byte >> shift) & mask
          const [px, py] = at(index)
          writeCPixel(target, px, py, palette, paletteIndex * BYTES_PER_CPIXEL)
          index++
          used++
        }
      }
      return
    }

    if (subencoding === 128) {
      let index = 0
      while (index < total) {
        const colour = this.readCPixel()
        const length = this.readRunLength()
        for (let i = 0; i < length && index < total; i++, index++) {
          const [px, py] = at(index)
          writeCPixel(target, px, py, colour)
        }
      }
      return
    }

    if (subencoding >= 130) {
      const paletteSize = subencoding - 128
      const palette = Uint8Array.from(this.take(paletteSize * BYTES_PER_CPIXEL))

      let index = 0
      while (index < total) {
        let paletteIndex = this.take(1)[0]!
        let length = 1
        if (paletteIndex >= 128) {
          paletteIndex -= 128
          length = this.readRunLength()
        }
        if (paletteIndex >= paletteSize) {
          throw new InflateError(`palette index ${paletteIndex} out of range for ${paletteSize}`, 0)
        }
        for (let i = 0; i < length && index < total; i++, index++) {
          const [px, py] = at(index)
          writeCPixel(target, px, py, palette, paletteIndex * BYTES_PER_CPIXEL)
        }
      }
      return
    }

    throw new InflateError(`unsupported subencoding ${subencoding}`, 0)
  }
}

/** Raw and CopyRect, which do not involve the ZRLE stream. */
const BYTES_PER_PIXEL = 4

function readPixel(source: Uint8Array, offset: number): [number, number, number] {
  return [source[offset + 2] ?? 0, source[offset + 1] ?? 0, source[offset] ?? 0]
}

export function decodeRaw(source: Uint8Array, rect: Rect, target: Framebuffer): number {
  const needed = rect.width * rect.height * BYTES_PER_PIXEL
  if (source.length < needed) throw new Error(`raw: rect wanted ${needed} bytes, had ${source.length}`)
  let offset = 0
  for (let row = 0; row < rect.height; row++) {
    for (let column = 0; column < rect.width; column++) {
      writePixel(target, rect.x + column, rect.y + row, Uint8Array.from(readPixel(source, offset)))
      offset += BYTES_PER_PIXEL
    }
  }
  return needed
}

export function decodeCopyRect(source: Uint8Array, rect: Rect, target: Framebuffer): void {
  if (source.length < 4) throw new Error("copyrect: wanted 4 bytes")
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const sourceX = view.getUint16(0)
  const sourceY = view.getUint16(2)

  const scratch = new Uint8Array(rect.width * rect.height * 4)
  for (let row = 0; row < rect.height; row++) {
    for (let column = 0; column < rect.width; column++) {
      const src = (sourceY + row) * target.width + (sourceX + column)
      const dst = (row * rect.width + column) * 4
      if (sourceX + column >= target.width || sourceY + row >= target.height) continue
      scratch[dst] = target.data[src * 4]!
      scratch[dst + 1] = target.data[src * 4 + 1]!
      scratch[dst + 2] = target.data[src * 4 + 2]!
      scratch[dst + 3] = target.data[src * 4 + 3]!
    }
  }

  for (let row = 0; row < rect.height; row++) {
    for (let column = 0; column < rect.width; column++) {
      const from = (row * rect.width + column) * 4
      writePixel(target, rect.x + column, rect.y + row, scratch, from)
    }
  }
}
