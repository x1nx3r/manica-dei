// ZRLE and the simple rectangle encodings.
//
// Written against the RFB specification (rfbproto.rst), not from memory. The
// details that matter and are easy to get wrong:
//
// - ZRLE is tiled 64x64, left to right then top to bottom, with the last tile of
//   each row and column smaller when the rectangle is not a multiple of 64.
// - A single zlib stream spans the whole connection, so rectangles must be
//   inflated strictly in order.
// - CPIXEL is 3 bytes for 32bpp true colour with depth 24 or less and all
//   intensity bits in the low three bytes. Not 4.
// - Packed palette bit fields are big-endian: the most significant bits are the
//   leftmost pixels in each row.
//
// The decoder produces RGBA bytes ready for a canvas, so nothing downstream has
// to know the pixel format.

export const PIXEL_FORMAT = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColour: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
} as const

/** 3 bytes, since every intensity fits in the low three bytes of a 32bpp pixel. */
const BYTES_PER_CPIXEL = 3
const TILE = 64

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

/** A CPIXEL is the low three bytes, little-endian, as RGB. */
function readCPixel(source: Uint8Array, offset: number): [number, number, number] {
  const b = source[offset] ?? 0
  const g = source[offset + 1] ?? 0
  const r = source[offset + 2] ?? 0
  return [r, g, b]
}

function writePixel(target: Framebuffer, x: number, y: number, rgb: [number, number, number]) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return
  const offset = (y * target.width + x) * 4
  target.data[offset] = rgb[0]
  target.data[offset + 1] = rgb[1]
  target.data[offset + 2] = rgb[2]
  target.data[offset + 3] = 255
}

/** Raw: width * height CPIXELs. */
export function decodeRaw(source: Uint8Array, rect: Rect, target: Framebuffer): number {
  const needed = rect.width * rect.height * BYTES_PER_CPIXEL
  if (source.length < needed) throw new Error(`zrle: Raw rect wanted ${needed} bytes, had ${source.length}`)
  let offset = 0
  for (let row = 0; row < rect.height; row++) {
    for (let column = 0; column < rect.width; column++) {
      writePixel(target, rect.x + column, rect.y + row, readCPixel(source, offset))
      offset += BYTES_PER_CPIXEL
    }
  }
  return needed
}

/**
 * CopyRect: the eight-byte payload names a source position to copy from. The
 * destination is `rect`. The source region may overlap, so copy through a
 * scratch buffer rather than in place.
 */
export function decodeCopyRect(source: Uint8Array, rect: Rect, target: Framebuffer): void {
  if (source.length < 4) throw new Error("zrle: CopyRect wanted 4 bytes")
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const sourceX = view.getUint16(0)
  const sourceY = view.getUint16(2)

  const scratch = new Uint8Array(rect.width * rect.height * 4)
  for (let row = 0; row < rect.height; row++) {
    for (let column = 0; column < rect.width; column++) {
      const fromX = sourceX + column
      const fromY = sourceY + row
      const dst = (row * rect.width + column) * 4
      if (fromX < 0 || fromY < 0 || fromX >= target.width || fromY >= target.height) continue
      const src = (fromY * target.width + fromX) * 4
      scratch[dst] = target.data[src]!
      scratch[dst + 1] = target.data[src + 1]!
      scratch[dst + 2] = target.data[src + 2]!
      scratch[dst + 3] = target.data[src + 3]!
    }
  }

  for (let row = 0; row < rect.height; row++) {
    for (let column = 0; column < rect.width; column++) {
      const from = (row * rect.width + column) * 4
      writePixel(target, rect.x + column, rect.y + row, [scratch[from]!, scratch[from + 1]!, scratch[from + 2]!])
    }
  }
}

/** Read the run length that follows a run pixel: bytes summing, 255 continues. */
function readRunLength(source: Uint8Array, offset: number): { length: number; next: number } {
  let sum = 0
  for (;;) {
    const byte = source[offset]
    if (byte === undefined) throw new Error("zrle: run length ran off the end")
    offset++
    sum += byte
    if (byte !== 255) return { length: sum + 1, next: offset }
  }
}

/**
 * Decode one ZRLE tile into the framebuffer at (tileX, tileY).
 *
 * The tile is a subencoding byte, then a payload that depends on it. Plain RLE
 * and palette RLE may run across rows, so a run counter drives placement rather
 * than a row/column pair.
 */
function decodeTile(
  source: Uint8Array,
  offset: number,
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
  target: Framebuffer,
): number {
  const subencoding = source[offset]
  if (subencoding === undefined) throw new Error("zrle: tile ran off the end")
  offset++

  const total = tileWidth * tileHeight
  // Runs cross rows, so index into the tile linearly and derive x and y.
  const at = (index: number): [number, number] => [tileX + (index % tileWidth), tileY + Math.floor(index / tileWidth)]

  if (subencoding === 0) {
    for (let index = 0; index < total; index++) {
      const [x, y] = at(index)
      writePixel(target, x, y, readCPixel(source, offset))
      offset += BYTES_PER_CPIXEL
    }
    return offset
  }

  if (subencoding === 1) {
    const colour = readCPixel(source, offset)
    offset += BYTES_PER_CPIXEL
    for (let index = 0; index < total; index++) {
      const [x, y] = at(index)
      writePixel(target, x, y, colour)
    }
    return offset
  }

  if (subencoding >= 2 && subencoding <= 16) {
    // Packed palette: 1, 2, or 4 bits per pixel depending on palette size.
    const paletteSize = subencoding
    const palette: Array<[number, number, number]> = []
    for (let i = 0; i < paletteSize; i++) {
      palette.push(readCPixel(source, offset))
      offset += BYTES_PER_CPIXEL
    }

    const bitsPerPixel = paletteSize === 2 ? 1 : paletteSize <= 4 ? 2 : 4
    const pixelsPerByte = 8 / bitsPerPixel
    let index = 0
    while (index < total) {
      const byte = source[offset]
      if (byte === undefined) throw new Error("zrle: palette row ran off the end")
      offset++
      // Big-endian bit order: the most significant bits are the leftmost
      // pixels in the row. Padding aligns each row on the tile's own width,
      // not the rectangle's, so only whole bytes are consumed here.
      for (let slot = 0; slot < pixelsPerByte && index < total; slot++) {
        const shift = 8 - bitsPerPixel * (slot + 1)
        const paletteIndex = (byte >> shift) & ((1 << bitsPerPixel) - 1)
        if (paletteIndex >= paletteSize) throw new Error(`zrle: palette index ${paletteIndex} out of range`)
        const [x, y] = at(index)
        writePixel(target, x, y, palette[paletteIndex]!)
        index++
      }
    }
    return offset
  }

  if (subencoding === 128) {
    // Plain RLE. Runs may cross rows, and each run is a pixel then a length.
    let index = 0
    while (index < total) {
      const colour = readCPixel(source, offset)
      offset += BYTES_PER_CPIXEL
      const run = readRunLength(source, offset)
      offset = run.next
      for (let i = 0; i < run.length && index < total; i++, index++) {
        const [x, y] = at(index)
        writePixel(target, x, y, colour)
      }
    }
    return offset
  }

  if (subencoding >= 130) {
    // Palette RLE: a palette, then runs of palette indices.
    const paletteSize = subencoding - 128
    const palette: Array<[number, number, number]> = []
    for (let i = 0; i < paletteSize; i++) {
      palette.push(readCPixel(source, offset))
      offset += BYTES_PER_CPIXEL
    }

    let index = 0
    while (index < total) {
      const first = source[offset]
      if (first === undefined) throw new Error("zrle: palette run ran off the end")
      offset++

      if ((first & 0x80) === 0) {
        // A run of one, written as a bare index.
        const [x, y] = at(index)
        writePixel(target, x, y, palette[first] ?? [0, 0, 0])
        index++
        continue
      }

      const paletteIndex = first - 128
      const run = readRunLength(source, offset)
      offset = run.next
      const colour = palette[paletteIndex] ?? [0, 0, 0]
      for (let i = 0; i < run.length && index < total; i++, index++) {
        const [x, y] = at(index)
        writePixel(target, x, y, colour)
      }
    }
    return offset
  }

  throw new Error(`zrle: unsupported subencoding ${subencoding}`)
}

/**
 * Decode a whole ZRLE rectangle from already-inflated bytes.
 *
 * Tiles run left to right then top to bottom, and the final tile in each row and
 * column is clipped to the rectangle.
 */
export function decodeZrle(inflated: Uint8Array, rect: Rect, target: Framebuffer): void {
  let offset = 0
  for (let tileY = 0; tileY < rect.height; tileY += TILE) {
    const tileHeight = Math.min(TILE, rect.height - tileY)
    for (let tileX = 0; tileX < rect.width; tileX += TILE) {
      const tileWidth = Math.min(TILE, rect.width - tileX)
      offset = decodeTile(inflated, offset, rect.x + tileX, rect.y + tileY, tileWidth, tileHeight, target)
    }
  }
}

/**
 * Holds the one zlib stream ZRLE requires for the connection.
 *
 * The stream spans rectangles, so it cannot be reset per rect. This uses the
 * platform's native inflate rather than a dependency, which keeps the no new
 * dependency rule intact.
 */
export class ZrleStream {
  // The writer's type differs between this package's tsconfig and the
  // opencode one, so it is inferred. The reader is named, because inferring it
  // resolves to a wider type that loses the read() signature.
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private queue: Promise<void> = Promise.resolve()

  constructor() {
    // "deflate" is zlib wrapping, which is what RFB specifies.
    const stream = new DecompressionStream("deflate")
    // The two tsconfigs in this repo resolve these getters differently, so each
    // is narrowed with the cast that the other side accepts. Both are standard
    // shapes; only the lib declarations disagree.
    this.writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>
    this.reader = stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>
  }

  /**
   * Push compressed bytes and return everything the stream can give back.
   *
   * Reads are serialised because the underlying stream is single-consumer and
   * rectangles must inflate in order.
   */
  async push(compressed: Uint8Array, expected: number): Promise<Uint8Array> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      await this.writer.write(compressed)
      const chunks: Uint8Array[] = []
      let length = 0
      // Read until at least the expected size is available. The stream may hand
      // back more than one chunk for a single write.
      while (length < expected) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          length += value.length
        }
      }
      const out = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    } finally {
      release()
    }
  }
}
