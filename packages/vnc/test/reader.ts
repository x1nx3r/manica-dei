import net from "node:net"

// A minimal RFB reader for tests: enough of the protocol to fetch one
// framebuffer and inspect its pixels. A caller that has a live display needs to
// look at what is actually on it.
//
// This is test infrastructure, not the product client. It reads Raw rectangles
// only, opens no security, and never writes input. It is deliberately a
// separate, simpler code path from `src/`, so that a bug in the client is not
// shared by the thing used to check the client.

const RAW = 0

export type Framebuffer = {
  width: number
  height: number
  // Pixels examined.
  total: number
  // Pixels with every channel above 200, which a rendered page has and a blank
  // display does not.
  light: number
  // Pixels with every channel below 24, which the dark launch page has and the
  // blank white display does not.
  dark: number
  // Approximate, capped so a photographic page does not allocate a huge set.
  distinctColors: number
}

class Reader {
  private buffer = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private failure: Error | undefined

  constructor(socket: net.Socket) {
    // One persistent listener. Attaching a listener per read puts the socket
    // into flowing mode and drops anything that arrives between reads.
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake()
    })
    socket.on("error", (error) => {
      this.failure = error
      this.wake()
    })
    socket.on("close", () => {
      this.failure ??= new Error("rfb socket closed")
      this.wake()
    })
  }

  private wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  async take(n: number): Promise<Buffer> {
    while (this.buffer.length < n) {
      if (this.failure) throw this.failure
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }
}

export async function readFramebuffer(port: number, opts: { maxColors?: number } = {}): Promise<Framebuffer> {
  const maxColors = opts.maxColors ?? 512
  const socket = net.connect({ host: "127.0.0.1", port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  const reader = new Reader(socket)

  try {
    // Handshake: version echo, then choose the "None" security type.
    const version = await reader.take(12)
    socket.write(version)
    const typeCount = (await reader.take(1))[0]!
    const types = await reader.take(typeCount)
    if (!types.includes(1)) throw new Error(`no None security type, got ${[...types].join(",")}`)
    socket.write(Buffer.from([1]))
    const securityResult = (await reader.take(4)).readUInt32BE(0)
    if (securityResult !== 0) throw new Error(`security result ${securityResult}`)

    // ClientInit with shared = 1.
    socket.write(Buffer.from([1]))

    // ServerInit.
    const header = await reader.take(24)
    const width = header.readUInt16BE(0)
    const height = header.readUInt16BE(2)
    const nameLength = header.readUInt32BE(20)
    await reader.take(nameLength)

    // Ask for 32bpp true colour, red/green/blue in that order. The three max
    // fields are two bytes each and use protocol byte order (big-endian), even
    // though pixel data follows the little-endian flag below. Getting any of
    // this wrong desyncs the stream and the server hangs up.
    const format = Buffer.from([
      32,
      24,
      0,
      1, // bpp, depth, big-endian, true-colour
      0,
      255,
      0,
      255,
      0,
      255, // red max, green max, blue max
      16,
      8,
      0, // red shift, green shift, blue shift
      0,
      0,
      0, // padding
    ])
    socket.write(Buffer.concat([Buffer.from([0, 0, 0, 0]), format]))

    // Raw only, so every rect is a fixed size and framing is trivial.
    socket.write(Buffer.concat([Buffer.from([2, 0]), Buffer.from([0, 1]), Buffer.from([0, 0, 0, RAW])]))

    // A non-incremental request for the whole framebuffer. Layout is
    // type, incremental, x, y, width, height, so width sits at offset 6.
    const request = Buffer.alloc(10)
    request[0] = 3
    request[1] = 0
    request.writeUInt16BE(0, 2)
    request.writeUInt16BE(0, 4)
    request.writeUInt16BE(width, 6)
    request.writeUInt16BE(height, 8)
    socket.write(request)

    // Read updates until a whole update has been consumed. Returning after the
    // first rectangle would report only the top strip, which is not the page.
    //
    // Every pixel is examined. Sparse sampling aliases: a stride that divides
    // evenly into the layout can miss the rendered region entirely and report a
    // blank screen that is not blank.
    let total = 0
    let light = 0
    let dark = 0
    const colors = new Set<number>()

    for (;;) {
      const type = (await reader.take(1))[0]!
      if (type !== 0) {
        // Bell (2) or server cut text (3). Skip and keep waiting.
        if (type === 2) await reader.take(3)
        if (type === 3) {
          await reader.take(3)
          const length = (await reader.take(4)).readUInt32BE(0)
          await reader.take(length)
        }
        continue
      }
      await reader.take(1)
      const rects = (await reader.take(2)).readUInt16BE(0)
      for (let i = 0; i < rects; i++) {
        const rect = await reader.take(12)
        const w = rect.readUInt16BE(4)
        const h = rect.readUInt16BE(6)
        const encoding = rect.readInt32BE(8)
        if (encoding !== RAW) throw new Error(`expected Raw, got encoding ${encoding}`)
        const payload = await reader.take(w * h * 4)
        for (let p = 0; p < w * h; p++) {
          // Little-endian 32bpp: byte 0 is blue, 1 green, 2 red.
          const o = p * 4
          const r = payload[o + 2]!
          const g = payload[o + 1]!
          const b = payload[o]!
          total++
          if (r > 200 && g > 200 && b > 200) light++
          if (r < 24 && g < 24 && b < 24) dark++
          if (colors.size < maxColors) colors.add((r << 16) | (g << 8) | b)
        }
      }
      // A whole update is in hand. Enough to judge the screen.
      return { width, height, total, light, dark, distinctColors: colors.size }
    }
  } finally {
    socket.destroy()
  }
}
