export const BROWSER_CONNECT_TICKET_QUERY = "ticket"

const BROWSER_CONNECT_PATH = /^\/browser\/connect$/

// Auth middleware skips Basic Auth when this matches; the browser connect
// handler then validates the ticket. Same shape as the PTY route.
export function isBrowserConnectPath(pathname: string) {
  return BROWSER_CONNECT_PATH.test(pathname)
}

export function hasBrowserConnectTicketURL(url: URL) {
  return isBrowserConnectPath(url.pathname) && !!url.searchParams.get(BROWSER_CONNECT_TICKET_QUERY)
}
