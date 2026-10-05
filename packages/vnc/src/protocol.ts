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
  // The extended form. A client asking for both receives this one, and only a
  // client that has received it may send SetDesktopSize. We request this rather
  // than the plain form so we can read the reason and the status of a resize.
  extendedDesktopSize: -308,
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
 * A screen in the desktop. Part of ExtendedDesktopSize and SetDesktopSize.
 *
 * `id` identifies a screen across changes: the client must send back the id the
 * server last gave it, so the server can tell a moved screen from a new one.
 */
export type Screen = {
  id: number
  x: number
  y: number
  width: number
  height: number
  flags: number
}

/**
 * The desktop geometry, as reported by an ExtendedDesktopSize pseudo-rect.
 *
 * `reason` is the rect's x-position: 0 for a change by other means or a reply to
 * a state query, 1 when this client asked for it, 2 when another client did.
 * `status` is the rect's y-position: meaningful when `reason` is 1, where 0
 * means success and non-zero is an error code.
 */
export type DesktopSize = {
  width: number
  height: number
  reason: number
  status: number
  screens: Screen[]
}

/**
 * A cursor shape sent by the server.
 *
 * The header's x and y are the **hotspot**, not a framebuffer position. A
 * cursor of width or height zero means the server has no local cursor and the
 * caller should draw its own default.
 *
 * `pixels` is RGBA, row major, `width * height * 4`, with alpha from the
 * server's validity mask: 255 where the bit is set, 0 where it is not.
 */
export type Cursor = {
  width: number
  height: number
  hotspotX: number
  hotspotY: number
  pixels: Uint8Array
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
        // The whole chunk leaves the queue, so the count drops by its length,
        // not by the remaining need. Subtracting `needed` here over-counts when
        // the chunk is shorter, which drifts the total below the real buffered
        // bytes and makes a later read wait for bytes it already holds.
        this.length -= head.length
      } else {
        out.set(head.subarray(0, needed), offset)
        this.chunks[0] = head.subarray(needed)
        offset += needed
        this.length -= needed
      }
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
  transport.write(
    encodeSetEncodings([
      ENCODING.zrle,
      ENCODING.copyRect,
      ENCODING.raw,
      // Declares that we can cope with a resize and will send SetDesktopSize.
      // The server sends an ExtendedDesktopSize rect in reply to our first
      // non-incremental request, which is how we learn the screen ids.
      ENCODING.extendedDesktopSize,
      // Declares that we draw the cursor ourselves, so the server sends its
      // shape instead of painting it into the framebuffer. The rich cursor is
      // the one we ask for: it is the spec encoding, the server prefers it over
      // the X cursor, and its payload has no nested encoding word.
      ENCODING.cursor,
    ]),
  )

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

/**
 * SetDesktopSize (message 251): request a new framebuffer size.
 *
 * The message may only be sent once the client has received an
 * ExtendedDesktopSize rect, and the screen `id` values must be the ones the
 * server last sent — the server uses them to tell a moved screen from a new
 * one. With no known screens this sends a single screen covering the whole
 * framebuffer, which is the shape a single-screen server expects, but the id
 * comes from `screens` when one is known.
 *
 * Layout: type, padding, width, height, screen count, padding, then 16 bytes
 * per screen.
 */
export function encodeSetDesktopSize(width: number, height: number, screens: Screen[] = []) {
  const list: Screen[] =
    screens.length > 0
      ? screens.map((screen) => ({ ...screen, x: 0, y: 0, width, height }))
      : [{ id: 0, x: 0, y: 0, width, height, flags: 0 }]
  const bytes = new Uint8Array(8 + list.length * 16)
  bytes[0] = 251
  bytes[2] = (width >> 8) & 0xff
  bytes[3] = width & 0xff
  bytes[4] = (height >> 8) & 0xff
  bytes[5] = height & 0xff
  bytes[6] = list.length & 0xff
  let offset = 8
  const u16 = (value: number) => {
    bytes[offset++] = (value >> 8) & 0xff
    bytes[offset++] = value & 0xff
  }
  const u32 = (value: number) => {
    bytes[offset++] = (value >>> 24) & 0xff
    bytes[offset++] = (value >>> 16) & 0xff
    bytes[offset++] = (value >>> 8) & 0xff
    bytes[offset++] = value & 0xff
  }
  for (const screen of list) {
    u32(screen.id)
    u16(screen.x)
    u16(screen.y)
    u16(screen.width)
    u16(screen.height)
    u32(screen.flags)
  }
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
  // A FramebufferUpdate. It may carry pixel rectangles, a resize, a cursor, or
  // any combination: Xvnc routinely sends a cursor and a resize in one update.
  // An earlier shape treated these as exclusive and silently dropped the cursor
  // whenever a resize was present.
  | { kind: "rects"; rects: number; changed: boolean; size?: DesktopSize; cursor?: Cursor }
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
  // A resize describes the desktop, not the pixels, and an update carrying one
  // must not also carry pixel changes. It is reported separately so the caller
  // can reallocate before drawing.
  let size: DesktopSize | undefined
  // A cursor is a shape, not a framebuffer region, so it is reported on its own
  // rather than merged into the pixel rectangles.
  let cursor: Cursor | undefined

  for (let index = 0; index < count; index++) {
    const header = await readRectHeader(queue)
    onRect?.(header)

    if (header.encoding === ENCODING.lastRect) continue

    if (header.encoding === ENCODING.extendedDesktopSize) {
      size = await readExtendedDesktopSize(queue, header)
      continue
    }

    if (header.encoding === ENCODING.desktopSize) {
      // The plain form carries only the new size and no screen ids or status.
      // We ask for the extended form, so a server should prefer it, but the
      // spec says to support both. Without ids we cannot send SetDesktopSize,
      // so this is reported as a size change with no screens.
      size = { width: header.width, height: header.height, reason: 0, status: 0, screens: [] }
      continue
    }

    if (header.encoding === ENCODING.cursor) {
      cursor = await readCursor(queue, header)
      continue
    }

    if (header.encoding === ENCODING.cursorAlpha) {
      // The X cursor is a different shape: two colours and two bitmaps, and a
      // zero size again means no cursor. We ask for the rich cursor, so a server
      // should send that, but the spec says to cope with either.
      cursor = await readXCursor(queue, header)
      continue
    }

    changed = (await applyRect(queue, header, target, zrle)) || changed
  }

  // One update may carry a resize and a cursor together, so the result holds
  // whichever were present rather than choosing one.
  return {
    kind: "rects",
    rects: count,
    changed,
    ...(size ? { size } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

/**
 * Read the body of an ExtendedDesktopSize pseudo-rect.
 *
 * The rect's own x and y hold the reason and the status; width and height are
 * the new framebuffer size. The screens follow, sixteen bytes each, and their
 * ids must be kept so a later SetDesktopSize can name them.
 */
async function readExtendedDesktopSize(queue: ByteQueue, header: RectHeader): Promise<DesktopSize> {
  const screenCount = await queue.takeU8()
  await queue.take(3) // padding
  const screens: Screen[] = []
  for (let i = 0; i < screenCount; i++) {
    screens.push({
      id: await queue.takeU32(),
      x: await queue.takeU16(),
      y: await queue.takeU16(),
      width: await queue.takeU16(),
      height: await queue.takeU16(),
      flags: await queue.takeU32(),
    })
  }
  return {
    width: header.width,
    height: header.height,
    reason: header.x,
    status: header.y,
    screens,
  }
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

/** The shape a zero-sized cursor decodes to: nothing to draw. */
const HIDDEN_CURSOR: Cursor = { width: 0, height: 0, hotspotX: 0, hotspotY: 0, pixels: new Uint8Array(0) }

/**
 * Read a Cursor pseudo-rect (encoding -239).
 *
 * The rect's own x and y are the hotspot. The payload follows **directly**: the
 * whole cursor's PIXELs, then a validity bitmask. It is not a nested rectangle,
 * and a zero-sized cursor has no payload at all.
 *
 * An earlier version read a nested rect header here. It never showed because the
 * client requested no cursor, so no such rect arrived. The moment -239 was
 * requested against a live Xvnc, the stream desynchronised on the first cursor.
 *
 * The pixels are the negotiated format, so four bytes each, blue-green-red in
 * memory. The mask is row-padded and most-significant-bit leftmost, and a set
 * bit means the pixel is opaque.
 */
async function readCursor(queue: ByteQueue, header: RectHeader): Promise<Cursor> {
  if (header.width === 0 || header.height === 0) return HIDDEN_CURSOR

  const raw = await queue.take(header.width * header.height * 4)
  const mask = await queue.take(cursorMaskBytes(header.width) * header.height)

  const pixels = new Uint8Array(header.width * header.height * 4)
  const stride = cursorMaskBytes(header.width)
  for (let y = 0; y < header.height; y++) {
    for (let x = 0; x < header.width; x++) {
      const at = (y * header.width + x) * 4
      const bit = (mask[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1
      pixels[at] = raw[at + 2]!
      pixels[at + 1] = raw[at + 1]!
      pixels[at + 2] = raw[at]!
      pixels[at + 3] = bit ? 255 : 0
    }
  }
  return { width: header.width, height: header.height, hotspotX: header.x, hotspotY: header.y, pixels }
}

/**
 * Read an X Cursor pseudo-rect (encoding -240).
 *
 * A different shape from the rich cursor: two RGB colours, then a one-bit
 * bitmap choosing between them, then a validity mask. A zero size again means
 * no cursor. We request the rich cursor, so a server should send that, but the
 * spec says to cope with either and the decode is small.
 */
async function readXCursor(queue: ByteQueue, header: RectHeader): Promise<Cursor> {
  if (header.width === 0 || header.height === 0) return HIDDEN_CURSOR

  const colours = await queue.take(6)
  const stride = cursorMaskBytes(header.width)
  const bitmap = await queue.take(stride * header.height)
  const mask = await queue.take(stride * header.height)

  const pixels = new Uint8Array(header.width * header.height * 4)
  for (let y = 0; y < header.height; y++) {
    for (let x = 0; x < header.width; x++) {
      const at = (y * header.width + x) * 4
      const primary = (bitmap[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1
      const valid = (mask[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1
      const from = primary ? 0 : 3
      pixels[at] = colours[from]!
      pixels[at + 1] = colours[from + 1]!
      pixels[at + 2] = colours[from + 2]!
      pixels[at + 3] = valid ? 255 : 0
    }
  }
  return { width: header.width, height: header.height, hotspotX: header.x, hotspotY: header.y, pixels }
}

/** A cursor bitmask row is padded to whole bytes, and holds one bit per pixel. */
function cursorMaskBytes(width: number): number {
  return Math.floor((width + 7) / 8)
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
