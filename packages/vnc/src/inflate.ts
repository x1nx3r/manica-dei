import { ZStream, zlibInflate, zlibInflateInit } from "pako"

// ZRLE needs a zlib inflate that returns an exact number of bytes on demand,
// and is kept open across rectangles.
//
// This is the one place the platform cannot help. `DecompressionStream` has no
// call that means "decompress this input and give me precisely what it
// produced": its `read()` resolves with a chunk or blocks. ZRLE cannot be
// decoded that way, because the size a rectangle inflates to is not derivable
// from its header — a solid tile is four bytes and a raw tile of the same
// header is twelve thousand.
//
// pako is the same zlib that noVNC vendors for this, and it exposes the
// low-level stream: `avail_in`/`next_in` going in, `avail_out`/`next_out`
// coming out. That exact-count contract is what the decoder drives.
//
// License: pako is `(MIT AND Zlib)`. Both are permissive and neither reaches
// the larger work, so this is compatible with the fork's MIT-only rule.

const CHUNK = 1024 * 1024

export class InflateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`zrle inflate: ${message}`)
    this.name = "InflateError"
  }
}

export class Inflator {
  private readonly stream = new ZStream()
  private buffer = new Uint8Array(CHUNK)

  constructor() {
    const status = zlibInflateInit(this.stream)
    if (status !== 0) throw new InflateError("inflateInit failed", status)
    this.stream.output = this.buffer
  }

  /**
   * Decompress exactly `expected` bytes from the current input.
   *
   * Throws when the stream cannot produce that many, which is the reference
   * behaviour and the correct one: a short read means the decoder asked for the
   * wrong field size or the stream desynchronised, and continuing would place
   * pixels at the wrong offsets rather than fail.
   *
   * `remaining` reports how much of `compressed` was not consumed, so a caller
   * feeding a longer buffer can advance its own position.
   */
  inflate(compressed: Uint8Array, expected: number): Uint8Array {
    if (expected > this.buffer.length) {
      this.buffer = new Uint8Array(expected)
      this.stream.output = this.buffer
    }

    this.stream.input = compressed
    this.stream.avail_in = compressed.length
    this.stream.next_in = 0
    this.stream.next_out = 0
    this.stream.avail_out = expected

    // Flush argument is unused by the low-level call, as in the reference.
    const status = zlibInflate(this.stream, 0)
    if (status < 0) throw new InflateError(this.stream.msg || "inflate failed", status)
    if (this.stream.next_out !== expected) {
      throw new InflateError(`wanted ${expected} bytes, produced ${this.stream.next_out}`, status)
    }

    // A view over the shared buffer. The caller must consume it before the next
    // call, which the decoder does — it decodes each field immediately.
    return this.buffer.subarray(0, this.stream.next_out)
  }

  /**
   * How much of the last `inflate` input was not consumed.
   *
   * The decoder feeds the rest of a rectangle's compressed bytes each call and
   * needs to know where the next field continues.
   */
  remaining(): number {
    return this.stream.avail_in
  }
}
