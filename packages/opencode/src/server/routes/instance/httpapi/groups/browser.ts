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
} as const

export const CursorQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
})

export const BrowserApi = HttpApi.make("browser").add(
  HttpApiGroup.make("browser")
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
