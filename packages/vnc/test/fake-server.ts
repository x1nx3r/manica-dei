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

  const transport: Transport = {
    write: (bytes: Uint8Array) => {
      written.push(bytes)
      if (bytes[0] === 3) {
        const next = script.shift()
        if (next) push?.(next)
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
