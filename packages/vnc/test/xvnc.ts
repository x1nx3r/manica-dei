import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"

// A bare Xvnc, started and stopped by a test.
//
// The point of the package extraction is that the client can be pointed at any
// RFB server without the product in between. This is the smallest thing that is
// a real server: Xvnc, no Chromium, no relay, no session. A test that uses it
// exercises the wire and nothing else.

const DISPLAY_BASE = 100
const PORT_BASE = 5900
const START_TIMEOUT_MS = 10_000
const PROBE_INTERVAL_MS = 100

export type Server = {
  /** The RFB port, on loopback. */
  port: number
  /** The X display number, without the colon. */
  display: number
  /** Stop the server and wait for it to exit. */
  stop: () => Promise<void>
}

/** Wait for the RFB banner, which is the first twelve bytes a server sends. */
export async function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500, () => done(false))
    socket.on("data", (data: Buffer) => done(data.toString("latin1").startsWith("RFB ")))
    socket.on("error", () => done(false))
  })
}

/**
 * Start Xvnc on loopback with no authentication and a fixed geometry.
 *
 * `acceptSetDesktopSize` is passed explicitly rather than relying on the
 * default, so the resize test proves the flag we intend rather than the
 * build's default. An absurd geometry is rejected by the server, which is how
 * the denial path is exercised.
 */
export async function start(
  options: { width?: number; height?: number; acceptSetDesktopSize?: boolean } = {},
): Promise<Server> {
  const width = options.width ?? 1280
  const height = options.height ?? 720
  const accept = options.acceptSetDesktopSize ?? true
  // A random display and port, so parallel tests do not collide.
  const display = DISPLAY_BASE + Math.floor(Math.random() * 900)
  const port = PORT_BASE + (display - DISPLAY_BASE)

  const args = [
    `:${display}`,
    "-geometry",
    `${width}x${height}`,
    "-depth",
    "24",
    "-SecurityTypes",
    "None",
    "-rfbport",
    String(port),
    "-nolisten",
    "tcp",
  ]
  if (accept) args.push("-AcceptSetDesktopSize")

  const child: ChildProcess = spawn("Xvnc", args, { stdio: "ignore" })

  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    // Escalate if it does not go quietly, so a stuck server cannot hang CI.
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    await exited
    clearTimeout(timer)
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probe(port)) return { port, display, stop }
    if (child.exitCode !== null) {
      throw new Error(`Xvnc exited with code ${child.exitCode}`)
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
  }

  await stop()
  throw new Error(`Xvnc on port ${port} never answered`)
}
