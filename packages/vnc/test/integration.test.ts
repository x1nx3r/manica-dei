import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import net from "node:net"
import { start, type Interface } from "../src/client"
import { ByteQueue } from "../src/protocol"
import { type Cursor, type DesktopSize, type Framebuffer } from "../src/index"
import { start as startXvnc, type Server } from "./xvnc"

// The client against a real RFB server.
//
// Everything else in this package runs against a fake. This is the one place a
// real Xvnc is in the loop, which is what the extraction was for: the client can
// be pointed at a server with no relay, no backend, and no session between them.
//
// What only a live server can show: that Xvnc accepts a resize at all, and that
// a real server does not enter the loop the specification warns about.
//
// It also documents two behaviours of a bare Xvnc that a fake would not teach:
//
// - The server sends an ExtendedDesktopSize rect on its own, in reply to the
//   first non-incremental request, with reason 0. That is how the client learns
//   the screen ids it must echo back in a resize.
// - A display with nothing drawing on it is static. No frames arrive until
//   something changes the screen, and a resize is the cheapest way to force
//   that. A test that waits for frames on an idle display waits forever.
//
// Guarded, because it spawns Xvnc: it must pass when MANUS_INTEGRATION=1 is set
// on a machine with Xvnc installed, and skip silently otherwise.

const guard = process.env.MANUS_INTEGRATION === "1"
const hasXvnc = Bun.spawnSync(["which", "Xvnc"]).exitCode === 0
const skip = !guard || !hasXvnc
const reason = skip ? (!guard ? "set MANUS_INTEGRATION=1" : "Xvnc not installed") : undefined

describe.skipIf(skip)(reason ?? "rfb integration", () => {
  let server: Server

  beforeAll(async () => {
    server = await startXvnc({ width: 800, height: 600, acceptSetDesktopSize: true })
  })

  afterAll(async () => {
    await server?.stop()
  })

  /** Open a client against the live server and collect what it reports. */
  async function connect(): Promise<{
    client: Interface
    frames: Framebuffer[]
    sizes: DesktopSize[]
    cursors: Cursor[]
    stop: () => void
  }> {
    const frames: Framebuffer[] = []
    const sizes: DesktopSize[] = []
    const cursors: Cursor[] = []
    // The queue must be the one the transport fills. `start` builds its own
    // when none is given, and the handshake would then wait on an empty queue
    // while the socket feeds a different one — which looks like a server that
    // never speaks.
    const { transport, queue, close } = await tcpTransport(server.port)
    const client = await start(transport, {
      queue,
      onFrame: (framebuffer) => frames.push(framebuffer),
      onDesktopSize: (size) => sizes.push(size),
      onCursor: (cursor) => cursors.push(cursor),
    })
    return { client, frames, sizes, cursors, stop: close }
  }

  /** Wait for a predicate, or give up. Returns whether it became true. */
  async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await Bun.sleep(100)
    return predicate()
  }

  test("completes the handshake and reports the server geometry", async () => {
    const { client, sizes, stop } = await connect()
    try {
      expect(client.init.width).toBe(800)
      expect(client.init.height).toBe(600)
      expect(client.framebuffer.data.length).toBe(800 * 600 * 4)

      // Xvnc sends the current layout unprompted, with reason 0 and the screen
      // id a later resize must name.
      const ok = await waitFor(() => sizes.length > 0)
      expect(ok).toBe(true)
      const initial = sizes[0]!
      console.log(
        `[vnc] initial ${initial.width}x${initial.height} reason=${initial.reason} screens=${initial.screens.length}`,
      )
      expect(initial.reason).toBe(0)
      expect(initial.width).toBe(800)
      expect(initial.screens.length).toBe(1)
      expect(initial.screens[0]!.id).toBeGreaterThan(0)
    } finally {
      client.close()
      stop()
    }
  }, 30_000)

  test("decodes a real framebuffer after a change", async () => {
    const { client, frames, stop } = await connect()
    try {
      // Force a repaint: an idle Xvnc with nothing drawing on it sends no
      // frames, and a resize marks the whole screen changed.
      client.resize(1024, 512)
      const ok = await waitFor(() => frames.length > 0)
      console.log(`[vnc] frames=${frames.length} size=${client.framebuffer.width}x${client.framebuffer.height}`)
      expect(ok).toBe(true)
      // The frame is decoded into the buffer of the new geometry.
      expect(client.framebuffer.width).toBe(1024)
      expect(client.framebuffer.height).toBe(512)
      expect(client.framebuffer.data.length).toBe(1024 * 512 * 4)
    } finally {
      client.close()
      stop()
    }
  }, 30_000)

  test("a resize is accepted with the status the specification defines", async () => {
    const { client, sizes, stop } = await connect()
    try {
      client.resize(640, 480)

      const ok = await waitFor(() => sizes.some((size) => size.reason === 1))
      const reply = sizes.find((size) => size.reason === 1)
      console.log(
        `[vnc] resize reply=${reply ? `${reply.width}x${reply.height} reason=${reply.reason} status=${reply.status}` : "none"}`,
      )
      expect(ok).toBe(true)
      // Reason 1 is "this client asked". Status 0 is success. A non-zero status
      // means the server refused, which only a live server can tell us.
      expect(reply!.status).toBe(0)
      expect(client.framebuffer.width).toBe(640)
      expect(client.framebuffer.height).toBe(480)
    } finally {
      client.close()
      stop()
    }
  }, 30_000)

  test("requests the rich cursor and receives one", async () => {
    // The client asks for -239, so a server declares the cursor locally. What a
    // headless Xvnc sends is a zero-sized shape: it has no cursor of its own,
    // so the pane draws a default. A non-zero shape needs a client window with
    // its own cursor, which this display does not have, and the decode of one is
    // pinned by the unit tests instead.
    const { client, cursors, stop } = await connect()
    try {
      const ok = await waitFor(() => cursors.length > 0)
      console.log(`[vnc] cursor=${cursors[0] ? `${cursors[0].width}x${cursors[0].height}` : "none"}`)
      expect(ok).toBe(true)
      expect(cursors[0]!.width).toBe(0)
      expect(cursors[0]!.height).toBe(0)
      // And the session is still healthy: the cursor did not desynchronise the
      // stream, which is exactly what an earlier version did.
      client.resize(600, 400)
      expect(await waitFor(() => client.framebuffer.width === 600)).toBe(true)
    } finally {
      client.close()
      stop()
    }
  }, 30_000)

  test("the live server does not loop after a resize", async () => {
    // The end-to-end version of the loop guard. If the client answers a resize
    // with a non-incremental request, Xvnc treats the whole screen as modified
    // and the two bounce forever, each reply carrying reason 1 again. A settled
    // session produces one reply and then quiet.
    const { client, sizes, frames, stop } = await connect()
    try {
      await waitFor(() => sizes.some((size) => size.reason === 1), 2_000)
      const before = sizes.filter((size) => size.reason === 1).length
      client.resize(720, 400)
      await Bun.sleep(3000)
      const mine = sizes.filter((size) => size.reason === 1).length
      const afterSettle = frames.length
      await Bun.sleep(2000)
      const growth = frames.length - afterSettle
      console.log(`[vnc] resize replies=${mine - before} frames after settle=${afterSettle} growth in 2s=${growth}`)
      // One request, one reply. A loop would keep producing them.
      expect(mine - before).toBeLessThan(5)
      // And the frame stream is flat, not growing without bound.
      expect(growth).toBeLessThan(50)
    } finally {
      client.close()
      stop()
    }
  }, 30_000)
})

/**
 * A transport over a TCP socket, and a queue it feeds.
 *
 * Xvnc speaks RFB over TCP, not WebSocket, so this is the transport the package
 * takes for a direct connection. It is also the demonstration that the package
 * does not care what carries the bytes.
 */
async function tcpTransport(port: number): Promise<{
  transport: { write: (bytes: Uint8Array) => void }
  queue: ByteQueue
  close: () => void
}> {
  const socket = net.connect({ host: "127.0.0.1", port })
  const queue = new ByteQueue()
  // The listener is attached before waiting for `connect`. RFB servers send the
  // version banner as soon as they accept, and a listener attached after the
  // connection resolves can miss those bytes — which stalls the handshake
  // forever and looks like a server that never speaks.
  socket.on("data", (chunk: Buffer) => queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  return {
    transport: { write: (bytes) => socket.write(bytes) },
    queue,
    close: () => socket.destroy(),
  }
}
