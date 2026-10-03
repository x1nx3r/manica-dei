import { createFramebuffer, decodeCopyRect, decodeRaw, ZrleDecoder, type Framebuffer } from "./decode"

// The pixel format we negotiate. It belongs to the protocol rather than the
// decoder, since it is what `SetPixelFormat` sends and what every encoding
// interprets against.
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

// The RFB protocol: version exchange, security negotiation, and the messages
// that carry a framebuffer.
//
// Written against rfbproto.rst. The layout details that matter:
//
// - Version is 12 bytes, "RFB 003.008\n" for 3.8.
// - Security: the server sends a count then that many types. 0 means failure,
//   and the reason follows in four bytes.
// - ServerInit gives width, height, a 16 byte pixel format, then a name whose
//   length is a 32 bit field.
// - A FramebufferUpdate is one byte of type, one of padding, a 16 bit rectangle
//   count, then rectangles of 12 header bytes each followed by their encoding's
//   payload.
// - The cursor pseudo-encoding is followed by its own pixel rectangle, so a
//   reader that does not know the pseudo-encoding desynchronises the stream.
// - A single zlib stream spans the connection, so ZRLE rectangles inflate in
//   order and must never be decoded out of step.

const VERSION_3_8 = "RFB 003.008\n"

export const ENCODING = {
  raw: 0,
  copyRect: 1,
  zrle: 16,
  cursor: -239,
  cursorAlpha: -240,
  desktopSize: -223,
  lastRect: -224,
} as const

const MESSAGE = {
  framebufferUpdate: 0,
  setColourMapEntries: 1,
  bell: 2,
  serverCutText: 3,
} as const

const SECURITY = {
  none: 1,
} as const

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`rfb: ${message}`)
    this.name = "ProtocolError"
  }
}

export type ServerInit = {
  width: number
  height: number
  name: string
}

/**
 * Accumulates bytes and hands out exact reads.
 *
 * A stream arrives in arbitrary chunks while the protocol needs fixed sizes, so
 * every read waits for its full length. This is the one place that has to get
 * framing exactly right or the whole session desynchronises.
 */
export class ByteQueue {
  private chunks: Uint8Array[] = []
  private length = 0
  private waiters: Array<() => void> = []

  push(chunk: Uint8Array) {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.length += chunk.length
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  get buffered() {
    return this.length
  }

  async take(count: number): Promise<Uint8Array> {
    while (this.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    const out = new Uint8Array(count)
    let offset = 0
    while (offset < count) {
      const head = this.chunks[0]!
      const needed = count - offset
      if (head.length <= needed) {
        out.set(head, offset)
        offset += head.length
        this.chunks.shift()
      } else {
        out.set(head.subarray(0, needed), offset)
        this.chunks[0] = head.subarray(needed)
        offset += needed
      }
      this.length -= needed
    }
    return out
  }

  async takeU8() {
    return (await this.take(1))[0]!
  }

  async takeU16() {
    const bytes = await this.take(2)
    return (bytes[0]! << 8) | bytes[1]!
  }

  async takeU32() {
    const bytes = await this.take(4)
    return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  }

  async takeI32() {
    const value = await this.takeU32()
    return value > 0x7fffffff ? value - 0x100000000 : value
  }
}

/** A sink the client writes to. The socket, in the app. */
export type Transport = {
  write: (bytes: Uint8Array) => void
}

const encoder = new TextEncoder()

function message(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes)
}

/** Version exchange. We only speak 3.8, so anything else fails loudly. */
export async function handshake(queue: ByteQueue, transport: Transport) {
  const version = await queue.take(12)
  const text = new TextDecoder().decode(version)
  if (text !== VERSION_3_8) {
    throw new ProtocolError(`server offered ${JSON.stringify(text)}, only ${JSON.stringify(VERSION_3_8)} is supported`)
  }
  transport.write(encoder.encode(VERSION_3_8))

  const count = await queue.takeU8()
  if (count === 0) {
    const length = await queue.takeU32()
    const reason = new TextDecoder().decode(await queue.take(length))
    throw new ProtocolError(`server refused the connection: ${reason}`)
  }
  const types = Array.from(await queue.take(count))
  if (!types.includes(SECURITY.none)) {
    throw new ProtocolError(`server offers security types ${types.join(",")}, none of which is None`)
  }
  transport.write(message([SECURITY.none]))

  const result = await queue.takeU32()
  if (result !== 0) {
    // 3.8 sends a reason after a failure, which is worth surfacing.
    const length = await queue.takeU32().catch(() => 0)
    const reason = length ? new TextDecoder().decode(await queue.take(length)) : "no reason given"
    throw new ProtocolError(`security failed: ${reason}`)
  }

  // ClientInit: shared, so the agent and the human can hold the same session.
  transport.write(message([1]))

  const width = await queue.takeU16()
  const height = await queue.takeU16()
  await queue.take(16) // pixel format, fixed by the client below
  const nameLength = await queue.takeU32()
  const name = nameLength ? new TextDecoder("utf-8").decode(await queue.take(nameLength)) : ""

  transport.write(encodeSetPixelFormat())
  transport.write(encodeSetEncodings([ENCODING.zrle, ENCODING.copyRect, ENCODING.raw]))

  return { width, height, name } satisfies ServerInit
}

/** SetPixelFormat: 3 padding bytes, then the 16 byte format. */
export function encodeSetPixelFormat() {
  const bytes = new Uint8Array(20)
  bytes[0] = 0
  let offset = 4
  bytes[offset++] = PIXEL_FORMAT.bitsPerPixel
  bytes[offset++] = PIXEL_FORMAT.depth
  bytes[offset++] = PIXEL_FORMAT.bigEndian ? 1 : 0
  bytes[offset++] = PIXEL_FORMAT.trueColour ? 1 : 0
  // The three max fields are two bytes each and use protocol byte order, which
  // is big-endian, even when pixel data is little-endian. Writing one byte each
  // makes the message 13 bytes and every later message misaligns.
  const setMax = (value: number) => {
    bytes[offset++] = (value >> 8) & 0xff
    bytes[offset++] = value & 0xff
  }
  setMax(PIXEL_FORMAT.redMax)
  setMax(PIXEL_FORMAT.greenMax)
  setMax(PIXEL_FORMAT.blueMax)
  bytes[offset++] = PIXEL_FORMAT.redShift
  bytes[offset++] = PIXEL_FORMAT.greenShift
  bytes[offset++] = PIXEL_FORMAT.blueShift
  return bytes
}

/** SetEncodings: 1 padding byte, a 16 bit count, then that many signed 32s. */
export function encodeSetEncodings(encodings: number[]) {
  const bytes = new Uint8Array(4 + encodings.length * 4)
  bytes[0] = 2
  bytes[2] = (encodings.length >> 8) & 0xff
  bytes[3] = encodings.length & 0xff
  encodings.forEach((encoding, index) => {
    const value = encoding >>> 0
    bytes[4 + index * 4] = (value >> 24) & 0xff
    bytes[5 + index * 4] = (value >> 16) & 0xff
    bytes[6 + index * 4] = (value >> 8) & 0xff
    bytes[7 + index * 4] = value & 0xff
  })
  return bytes
}

/**
 * FramebufferUpdateRequest. Width and height sit at offsets 6 and 8: the layout
 * is type, incremental, x, y, width, height. Writing them at 4 and 6 puts them
 * in the x and y slots and asks for a zero sized region.
 */
export function encodeFramebufferUpdateRequest(width: number, height: number, incremental: boolean) {
  const bytes = new Uint8Array(10)
  bytes[0] = 3
  bytes[1] = incremental ? 1 : 0
  bytes[6] = (width >> 8) & 0xff
  bytes[7] = width & 0xff
  bytes[8] = (height >> 8) & 0xff
  bytes[9] = height & 0xff
  return bytes
}

/** KeyEvent: one byte down flag, two padding, then the four byte keysym. */
export function encodeKeyEvent(keysym: number, down: boolean) {
  const bytes = new Uint8Array(8)
  bytes[0] = 4
  bytes[1] = down ? 1 : 0
  bytes[4] = (keysym >> 24) & 0xff
  bytes[5] = (keysym >> 16) & 0xff
  bytes[6] = (keysym >> 8) & 0xff
  bytes[7] = keysym & 0xff
  return bytes
}

/** PointerEvent: one byte button mask, then x and y as 16 bit each. */
export function encodePointerEvent(x: number, y: number, mask: number) {
  const bytes = new Uint8Array(6)
  bytes[0] = 5
  bytes[1] = mask & 0xff
  bytes[2] = (x >> 8) & 0xff
  bytes[3] = x & 0xff
  bytes[4] = (y >> 8) & 0xff
  bytes[5] = y & 0xff
  return bytes
}

export type RectHeader = { x: number; y: number; width: number; height: number; encoding: number }

/**
 * Read one server message and apply it to the framebuffer.
 *
 * Returns what happened so a caller can react, for example to redraw only after
 * pixels changed.
 */
export type Update =
  | { kind: "rects"; rects: number; changed: boolean }
  | { kind: "bell" }
  | { kind: "cut"; text: string }
  | { kind: "colourMap" }

export async function readMessage(
  queue: ByteQueue,
  target: Framebuffer,
  zrle: ZrleDecoder,
  onRect?: (rect: RectHeader) => void,
): Promise<Update> {
  const type = await queue.takeU8()

  if (type === MESSAGE.bell) return { kind: "bell" }

  if (type === MESSAGE.serverCutText) {
    await queue.take(3) // padding
    const length = await queue.takeU32()
    const text = new TextDecoder().decode(await queue.take(length))
    return { kind: "cut", text }
  }

  if (type === MESSAGE.setColourMapEntries) {
    await queue.take(1) // padding
    const count = await queue.takeU16()
    await queue.take(count * 6)
    return { kind: "colourMap" }
  }

  if (type !== MESSAGE.framebufferUpdate) {
    throw new ProtocolError(`unknown server message type ${type}`)
  }

  await queue.take(1) // padding
  const count = await queue.takeU16()
  let changed = false

  for (let index = 0; index < count; index++) {
    const header = await readRectHeader(queue)
    onRect?.(header)

    if (header.encoding === ENCODING.lastRect || header.encoding === ENCODING.desktopSize) continue

    if (header.encoding === ENCODING.cursor || header.encoding === ENCODING.cursorAlpha) {
      // A cursor pseudo-rect is followed by its own pixel rectangle, so it must
      // be consumed or the stream desynchronises.
      const nested = await readRectHeader(queue)
      await skipRect(queue, nested)
      continue
    }

    changed = (await applyRect(queue, header, target, zrle)) || changed
  }

  return { kind: "rects", rects: count, changed }
}

async function readRectHeader(queue: ByteQueue): Promise<RectHeader> {
  return {
    x: await queue.takeU16(),
    y: await queue.takeU16(),
    width: await queue.takeU16(),
    height: await queue.takeU16(),
    encoding: await queue.takeI32(),
  }
}

async function skipRect(queue: ByteQueue, header: RectHeader) {
  if (header.encoding === ENCODING.raw) {
    // PIXELs, not CPIXELs: the full 32 bits we negotiate.
    await queue.take(header.width * header.height * 4)
    return
  }
  if (header.encoding === ENCODING.zrle) {
    const length = await queue.takeU32()
    await queue.take(length)
    return
  }
  if (header.encoding === ENCODING.copyRect) {
    await queue.take(4)
    return
  }
  throw new ProtocolError(`cannot skip a rect with encoding ${header.encoding}`)
}

/** Apply one rectangle and report whether it changed pixels. */
async function applyRect(
  queue: ByteQueue,
  header: RectHeader,
  target: Framebuffer,
  zrle: ZrleDecoder,
): Promise<boolean> {
  if (header.encoding === ENCODING.raw) {
    // PIXELs, not CPIXELs: the full 32 bits we negotiate.
    const payload = await queue.take(header.width * header.height * 4)
    decodeRaw(payload, header, target)
    return true
  }

  if (header.encoding === ENCODING.copyRect) {
    const payload = await queue.take(4)
    decodeCopyRect(payload, header, target)
    return true
  }

  if (header.encoding === ENCODING.zrle) {
    const length = await queue.takeU32()
    const compressed = await queue.take(length)
    // The decoder pulls fields out of the one stream that spans the
    // connection. It cannot be given a pre-inflated rectangle: the size is not
    // derivable from the header, so it inflates exactly what each field needs.
    zrle.begin(compressed)
    zrle.decodeRect(header, target)
    return true
  }

  throw new ProtocolError(`unsupported encoding ${header.encoding}`)
}
