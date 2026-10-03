import { readFile } from "node:fs/promises"
import path from "node:path"

// Chromium's debugging endpoint.
//
// The transport is a loopback WebSocket per target, reached by reading the port
// Chromium chose for itself. `--remote-debugging-pipe` was tried first and
// replaced: Chromium attaches the pipe to a browser target, so `Page`,
// `Runtime`, and `DOM` are absent from it and no page can be driven. See
// ADR-0003, "Corrected: the debugging pipe".
//
// `--remote-debugging-port=0` means Chromium picks a free port rather than us
// guessing one, and it publishes the port and the browser path in
// `DevToolsActivePort` inside the profile directory. We read it back. There is
// no race to lose and no port to reserve.

const PORTS_FILE = "DevToolsActivePort"
const READ_TIMEOUT_MS = 10_000
const READ_INTERVAL_MS = 50

export class EndpointError extends Error {
  constructor(message: string) {
    super(`chromium endpoint: ${message}`)
    this.name = "EndpointError"
  }
}

export type Endpoint = {
  // The port Chromium is listening on, on loopback.
  port: number
  // The browser-scope WebSocket path, e.g. /devtools/browser/<uuid>.
  browserPath: string
  // ws://127.0.0.1:<port><browserPath>
  browserUrl: string
  // http origin for the /json endpoints.
  http: string
}

/**
 * Read `DevToolsActivePort` from a profile directory.
 *
 * The file holds two lines: the port, then the browser's websocket path. It is
 * written once the server is listening, so the wait is for the file rather than
 * a fixed sleep.
 */
export async function readEndpoint(userDataDir: string, timeoutMs = READ_TIMEOUT_MS): Promise<Endpoint> {
  const file = path.join(userDataDir, PORTS_FILE)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new EndpointError(`no ${PORTS_FILE} in ${userDataDir} after ${timeoutMs}ms: ${String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, READ_INTERVAL_MS))
      continue
    }

    const lines = text.split("\n")
    const port = Number((lines[0] ?? "").trim())
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      // The file can exist before it is fully written, so treat a bad port as
      // "not yet" until the deadline rather than failing outright.
      if (Date.now() >= deadline)
        throw new EndpointError(`${PORTS_FILE} carried no usable port: ${JSON.stringify(lines[0])}`)
      await new Promise((resolve) => setTimeout(resolve, READ_INTERVAL_MS))
      continue
    }

    const browserPath = (lines[1] ?? "").trim() || `/devtools/browser`
    const normalized = browserPath.startsWith("/") ? browserPath : `/${browserPath}`
    return {
      port,
      browserPath: normalized,
      browserUrl: `ws://127.0.0.1:${port}${normalized}`,
      http: `http://127.0.0.1:${port}`,
    }
  }
}

/** The websocket URL for a page target, from the /json list endpoint. */
export async function pageTargetUrl(endpoint: Endpoint, timeoutMs = READ_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${endpoint.http}/json/list`)
      if (response.ok) {
        const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      }
    } catch {
      // The HTTP endpoint can refuse before the server is ready.
    }
    if (Date.now() >= deadline) throw new EndpointError("no page target appeared")
    await new Promise((resolve) => setTimeout(resolve, READ_INTERVAL_MS))
  }
}
