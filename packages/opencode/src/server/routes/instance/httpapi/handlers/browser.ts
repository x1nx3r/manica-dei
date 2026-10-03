import * as InstanceState from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import { Browser } from "@opencode-ai/core/browser"
import { connectPage, currentUrl } from "@opencode-ai/core/browser/cdp-session"
import { BrowserTicket } from "@opencode-ai/core/browser/ticket"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import net from "node:net"
import { BrowserConnectApi } from "../groups/browser"
import { BROWSER_CONNECT_TICKET_QUERY } from "@/server/shared/browser-ticket"
import { WebSocketTracker } from "../websocket-tracker"

// ADR-0003: the human's framebuffer lives on container loopback, so this route
// carries it to their browser. It is a byte pipe: the relay does not parse RFB,
// which keeps the display protocol in the client.
//
// Shaped exactly like the PTY connect route, including the outbox queue that
// keeps frames in order and the close frame, because the same hazards apply:
// a slow reader must not interleave with a close, and the upstream socket has
// to be torn down whichever side finishes first.

export const browserConnectHandlers = HttpApiBuilder.group(BrowserConnectApi, "browser", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const unregister = registerDisposer((directory) =>
      Effect.runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))

    const browser = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    return handlers
      .handle("url", () =>
        Effect.gen(function* () {
          const endpoint = yield* browser(Browser.Service.use((service) => service.endpoint)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!endpoint) return { url: "" }
          // Page commands live on the page's own socket, so a page connection
          // is how the location is read.
          return yield* Effect.tryPromise({
            try: async () => {
              const page = await connectPage(endpoint, { timeoutMs: 1000 })
              try {
                return { url: await currentUrl(page) }
              } finally {
                page.close()
              }
            },
            catch: () => "unreachable" as const,
          }).pipe(Effect.catch(() => Effect.succeed({ url: "" })))
        }),
      )
      .handle("connectToken", () =>
        Effect.gen(function* () {
          const tickets = yield* BrowserTicket.Service
          const instance = yield* InstanceState.context
          const workspaceID = yield* WorkspaceRef
          return yield* tickets.issue({ directory: instance.directory, workspaceID: workspaceID ?? undefined })
        }),
      )
      .handleRaw(
        "connect",
        Effect.fn("BrowserHttpApi.connect")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
          // On demand: whichever side asks first starts the browser, and the
          // other joins the same instance. A session that never browses pays
          // nothing, and there is no ordering problem between the agent and the
          // human.
          const info = yield* browser(Browser.Service.use((service) => service.ensure)).pipe(
            Effect.catch((error) =>
              Effect.logError("unable to start the session browser", { message: error.message }).pipe(
                Effect.as(undefined),
              ),
            ),
          )
          if (!info) return HttpServerResponse.empty({ status: 503 })

          const port = info.rfbPort

          // A ticket authorises the upgrade, exactly as the PTY route does. It is
          // a scoped capability created by an authenticated caller, not the
          // authentication itself.
          const tickets = yield* BrowserTicket.Service
          const instance = yield* InstanceState.context
          const workspaceID = yield* WorkspaceRef
          const ticket = new URL(ctx.request.url, "http://localhost").searchParams.get(BROWSER_CONNECT_TICKET_QUERY)
          if (ticket) {
            const valid = yield* tickets.consume({
              ticket,
              directory: instance.directory,
              workspaceID: workspaceID ?? undefined,
            })
            if (!valid) return HttpServerResponse.empty({ status: 403 })
          }

          // Connect upstream before upgrading, so a refusal is a plain HTTP
          // error rather than a socket that opens and immediately closes.
          const upstream = yield* Effect.tryPromise({
            try: () =>
              new Promise<net.Socket>((resolve, reject) => {
                const socket = net.connect({ host: "127.0.0.1", port })
                socket.once("connect", () => resolve(socket))
                socket.once("error", reject)
              }),
            catch: () => "unreachable" as const,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!upstream) return HttpServerResponse.empty({ status: 404 })

          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer

          const closeAccepted = (event: Socket.CloseEvent) =>
            socket
              .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
              .pipe(
                Effect.timeout("1 second"),
                Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
                Effect.catch(() => Effect.void),
              )

          const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
          if (!registered) {
            upstream.destroy()
            yield* closeAccepted(WebSocketTracker.SERVER_CLOSING_EVENT())
            return HttpServerResponse.empty()
          }

          // One writer drains one queue, so upstream bytes and the close frame
          // cannot interleave.
          const outbox = yield* Queue.unbounded<Uint8Array | Socket.CloseEvent>()

          const onUpstreamData = (chunk: Buffer) => Queue.offerUnsafe(outbox, new Uint8Array(chunk))
          const onUpstreamEnd = () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000))
          upstream.on("data", onUpstreamData)
          upstream.on("end", onUpstreamEnd)
          upstream.on("error", onUpstreamEnd)
          upstream.on("close", onUpstreamEnd)

          const drain = Effect.gen(function* () {
            while (true) {
              const item = yield* Queue.take(outbox)
              yield* write(item).pipe(Effect.catch(() => Effect.void))
              if (item instanceof Socket.CloseEvent) return
            }
          })

          // Whatever arrives from the human is written straight upstream. RFB
          // carries its own input messages, so there is nothing to interpret.
          const pump = socket.runRaw((message) => {
            if (typeof message === "string") return
            try {
              upstream.write(Buffer.from(message))
            } catch {}
          })

          yield* Effect.race(drain, pump).pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                upstream.off("data", onUpstreamData)
                upstream.off("end", onUpstreamEnd)
                upstream.off("error", onUpstreamEnd)
                upstream.off("close", onUpstreamEnd)
                upstream.destroy()
              }),
            ),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
).pipe(Layer.provide(locationServiceMapLayer))
