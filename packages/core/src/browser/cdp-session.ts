import { type Endpoint, pageTargetUrl } from "./endpoint"
import * as Cdp from "./cdp"

// A page-scoped CDP connection.
//
// Chromium exposes one WebSocket per target, at `/devtools/page/{targetId}`.
// Connecting to the page's own socket is how page commands work: `Page`,
// `Runtime`, and `DOM` live there, with no session routing and no sessionId on
// the wire. This is what chrome-remote-interface does, and it is why attaching
// through the browser socket was wrong: that socket only carries browser-scope
// domains.
//
// The browser socket is still the right place to *list* targets, which is what
// endpoint.ts does over HTTP for the same reason.

export class PageError extends Error {
  constructor(message: string) {
    super(`cdp page: ${message}`)
    this.name = "PageError"
  }
}

export interface Interface {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  readonly url: string
  readonly close: () => void
}

export type Options = {
  onEvent?: Cdp.Options["onEvent"]
  onClose?: Cdp.Options["onClose"]
  // How long to wait for a page target to appear. Production wants the default;
  // tests want it short.
  timeoutMs?: number
}

/**
 * Connect to the page target and return a client scoped to it.
 *
 * A fresh page appears as Chromium starts, so the target is waited for rather
 * than read once.
 */
export async function connectPage(endpoint: Endpoint, options: Options = {}): Promise<Interface> {
  const url = await pageTargetUrl(endpoint, options.timeoutMs).catch((error) => {
    throw new PageError(`no page target: ${String(error)}`)
  })

  const client = await Cdp.connect(url, options)

  return {
    url,
    send: (method, params = {}) => client.send(method, params),
    close: () => client.close(),
  }
}

/** The page's current URL, so a report is what the browser actually has. */
export async function currentUrl(client: Interface): Promise<string> {
  const result = (await client.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  })) as { result?: { value?: unknown } }
  const value = result.result?.value
  return typeof value === "string" ? value : ""
}
