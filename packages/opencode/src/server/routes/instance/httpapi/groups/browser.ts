import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization, BrowserConnectAuthorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ConnectTokenSchema } from "./browser-token-schema"

// ADR-0003: the human's browser is outside the container, and RFB listens on
// container loopback. This route is the bridge, and it is shaped exactly like
// the PTY connect route: a ticket-authenticated WebSocket that carries the
// protocol bytes both ways.
//
// The relay is a byte pipe. It does not parse RFB, which keeps the display
// protocol in the client and the server ignorant of it.

const root = "/browser"

export const BrowserPaths = {
  connectToken: `${root}/connect-token`,
  connect: `${root}/connect`,
  url: `${root}/url`,
  status: `${root}/status`,
} as const

export const UrlState = Schema.Struct({
  // The page the agent's browser is showing. Empty while nothing is open.
  url: Schema.String,
  // Why the URL is empty, when it is empty for a reason other than "no browser
  // is running". Present so a reader can tell a broken server from an idle one.
  error: Schema.optional(Schema.String),
})

export const BrowserStatus = Schema.Struct({
  // Whether a browser is running. Answered from the process state, without
  // touching Chromium: the page URL needs a CDP round trip, liveness does not,
  // and a caller that only needs liveness should not pay for the round trip.
  alive: Schema.Boolean,
})

export const CursorQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
})

export const BrowserApi = HttpApi.make("browser").add(
  HttpApiGroup.make("browser")
    .add(
      // The page URL lives in the agent's Chromium, reachable only over CDP,
      // and RFB carries pixels with no notion of a URL. The server owns that
      // connection, so it is the one that can answer this. The pane shows it
      // continuously, which the ADR makes the mitigation for an agent
      // rendering a convincing login page inside our own interface.
      HttpApiEndpoint.get("url", BrowserPaths.url, {
        query: CursorQuery,
        success: described(UrlState, "The page the browser is showing"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.url",
          summary: "Read the session browser page URL",
          description: "The URL the shared browser is currently showing, or empty when it is not running.",
        }),
      ),
    )
    .add(
      // A liveness check that costs nothing: the browser service answers from
      // the child process state. The pane needs this because a killed Chromium
      // does not close its RFB socket, so the socket is not a liveness signal —
      // but reading the page URL to find out is needless Chromium work.
      HttpApiEndpoint.get("status", BrowserPaths.status, {
        query: CursorQuery,
        success: described(BrowserStatus, "Whether the session browser is running"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.status",
          summary: "Check whether the session browser is running",
          description: "Whether a browser process is alive for this session, without reading its page.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("connectToken", BrowserPaths.connectToken, {
        success: described(ConnectTokenSchema, "WebSocket connect token"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.connectToken",
          summary: "Create a browser connect ticket",
          description: "Create a short-lived ticket for opening the session browser WebSocket.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("connect", BrowserPaths.connect, {
        query: CursorQuery,
        success: described(Schema.Boolean, "Connected session"),
        error: [HttpApiError.Forbidden, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.connect",
          summary: "Connect to the session browser",
          description:
            "Establish a WebSocket connection carrying the Remote Framebuffer Protocol to the session browser, so the human can watch and drive the same Chromium the agent controls.",
          transform: (operation) => ({
            ...operation,
            parameters: [
              ...(operation.parameters ?? []),
              ...["directory", "workspace", "ticket"].map((name) => ({
                in: "query",
                name,
                schema: { type: "string" },
              })),
            ],
          }),
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "browser", description: "Browser websocket route." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(BrowserConnectAuthorization),
)

export const BrowserConnectApi = BrowserApi
export { Authorization }
