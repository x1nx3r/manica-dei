import type { Transport } from "../src/protocol"

// A fake RFB server for tests. It speaks enough of the protocol to drive the
// client through a handshake and scripted updates, with no socket and no
// external server.
//
// This is the point of the package: a protocol client is hard to trust when the
// only way to test it is to run a real server four layers away. Here the whole
// conversation is in-process bytes.

const encoder = new TextEncoder()

function serverInit(width: number, height: number) {
  const out = new Uint8Array(24)
  out[0] = (width >> 8) & 0xff
  out[1] = width & 0xff
  out[2] = (height >> 8) & 0xff
  out[3] = height & 0xff
  return out
}

export type FakeServer = {
  transport: Transport
  /** Every message the client wrote, for assertions. */
  written: Uint8Array[]
  /**
   * Push the handshake into the queue the client reads from.
   *
   * The client owns its `ByteQueue`, so the fake cannot reach it until the test
   * hands it over. Call this before `start()` or the handshake never arrives
   * and `start()` blocks forever.
   */
  begin(queue: { push: (chunk: Uint8Array) => void }): void
  /**
   * Answer every client request, not just the scripted ones.
   *
   * The rule receives the request bytes and a `reply` sink. It runs after the
   * script, so a test can script the first answer and rule the rest. This is
   * how a loop is proven closed: a rule that answers every non-incremental
   * request lets a buggy client collect replies forever.
   */
  rule(handler: (request: Uint8Array, reply: (bytes: Uint8Array) => void) => void): void
}

/**
 * Build a fake server.
 *
 * `script` is the queue of updates. Each FramebufferUpdateRequest the client
 * writes shifts one update and pushes it back, which matches a real server that
 * only sends pixels in reply to a request.
 */
export function fakeServer(
  script: Array<Uint8Array>,
  size: { width: number; height: number } = { width: 4, height: 2 },
): FakeServer {
  const written: Uint8Array[] = []
  let push: ((chunk: Uint8Array) => void) | undefined
  let respond: ((request: Uint8Array, reply: (bytes: Uint8Array) => void) => void) | undefined

  const transport: Transport = {
    write: (bytes: Uint8Array) => {
      written.push(bytes)
      if (bytes[0] === 3) {
        // A scripted answer, when one is queued. A real server answers only
        // some requests, so the script is the primary mechanism.
        const next = script.shift()
        if (next) push?.(next)
        // And a rule, when the test needs one that depends on the request. This
        // is how a test proves a loop is closed: the rule can answer every
        // request of a given shape, so a client that keeps sending that shape
        // is caught rather than merely unsatisfied.
        respond?.(bytes, (bytes) => push?.(bytes))
      }
    },
  }

  const handshakeBytes = [
    encoder.encode("RFB 003.008\n"),
    Uint8Array.from([1]),
    Uint8Array.from([1]),
    Uint8Array.from([0, 0, 0, 0]),
    serverInit(size.width, size.height),
  ]

  return {
    transport,
    written,
    begin(queue) {
      push = (chunk) => queue.push(chunk)
      for (const chunk of handshakeBytes) push(chunk)
    },
    rule(handler) {
      respond = handler
    },
  }
}

/** An update carrying one Raw rectangle of the given width and height. */
export function rawUpdate(width: number, height: number, rgb: [number, number, number]) {
  // Raw carries whole 32-bit PIXELs in the negotiated format, four bytes each,
  // not ZRLE's three-byte CPIXEL. A test fixture that emitted three bytes per
  // pixel left the client two bytes short and blocked the reader, which the
  // earlier accident of a second handshake replay happened to paper over.
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgb[2]
    pixels[i * 4 + 1] = rgb[1]
    pixels[i * 4 + 2] = rgb[0]
    pixels[i * 4 + 3] = 0
  }
  const header = Uint8Array.from([
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    0,
    0,
    0,
    0,
  ])
  return new Uint8Array([...header, ...pixels])
}

/** A bell, which must never produce a frame. */
export const bell = Uint8Array.from([2])

/**
 * An update carrying one Cursor pseudo-rect (-239).
 *
 * The layout the server sends: the rect header with the hotspot in x and y, then
 * the pixels and the mask written directly, with no nested rect. A width or
 * height of zero has no payload at all.
 */
export function cursorUpdate(
  width: number,
  height: number,
  options: {
    hotspotX?: number
    hotspotY?: number
    rgb?: [number, number, number]
    alpha?: (x: number, y: number) => boolean
  } = {},
) {
  const hotspotX = options.hotspotX ?? 0
  const hotspotY = options.hotspotY ?? 0
  const rgb = options.rgb ?? [255, 0, 0]
  const alpha = options.alpha ?? (() => true)
  const header = Uint8Array.from([
    0,
    0,
    0,
    1,
    (hotspotX >> 8) & 0xff,
    hotspotX & 0xff,
    (hotspotY >> 8) & 0xff,
    hotspotY & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    0xff,
    0xff,
    0xff,
    0x11, // encoding -239
  ])
  if (width === 0 || height === 0) return header

  // PIXELs: four bytes each, blue-green-red in memory.
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgb[2]
    pixels[i * 4 + 1] = rgb[1]
    pixels[i * 4 + 2] = rgb[0]
  }
  const stride = Math.floor((width + 7) / 8)
  const mask = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha(x, y)) mask[y * stride + (x >> 3)]! |= 1 << (7 - (x & 7))
    }
  }
  return new Uint8Array([...header, ...pixels, ...mask])
}

/**
 * An update carrying one ExtendedDesktopSize pseudo-rect.
 *
 * `reason` is the rect's x-position and `status` its y-position; `width` and
 * `height` are the new framebuffer size. A screen with `id` 1 covers the whole
 * desktop, which is the single-screen shape a server sends.
 */
export function extendedDesktopSize(
  width: number,
  height: number,
  options: { reason?: number; status?: number; id?: number } = {},
) {
  const reason = options.reason ?? 0
  const status = options.status ?? 0
  const id = options.id ?? 1
  const header = Uint8Array.from([
    0,
    0,
    0,
    1,
    (reason >> 8) & 0xff,
    reason & 0xff,
    (status >> 8) & 0xff,
    status & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    // -308 as a signed 32-bit big-endian value.
    0xff,
    0xff,
    0xfe,
    0xcc,
  ])
  const body = Uint8Array.from([
    1,
    0,
    0,
    0, // screen count, padding
    0,
    0,
    0,
    id & 0xff, // id
    0,
    0,
    0,
    0, // x, y
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    0,
    0,
    0,
    0, // flags
  ])
  return new Uint8Array([...header, ...body])
}
