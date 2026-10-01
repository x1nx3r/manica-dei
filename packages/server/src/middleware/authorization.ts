import { ServerAuth } from "../auth"
import { parseCookies, sessionCookieHeader, signSession, verifySession, SESSION_COOKIE } from "../shared/session-cookie"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// Credentials reach the middleware three ways: the ?auth_token= query
// (browser flow — issues a session cookie), Basic (API clients), and the
// session cookie itself (subresources, WebSocket, EventSource).
type Credential =
  | (ServerAuth.DecodedCredentials & { readonly _tag: "token" | "basic" })
  | { readonly _tag: "cookie"; readonly value: string }

function emptyCredential(): Credential {
  return {
    _tag: "basic",
    username: "",
    password: Redacted.make(""),
  }
}

function decodeCredential(input: string): Effect.Effect<ServerAuth.DecodedCredentials> {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: () => ({ username: "", password: Redacted.make("") }),
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return { username: "", password: Redacted.make("") }
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Credential> {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token)
    return decodeCredential(token).pipe(Effect.map((credential) => ({ ...credential, _tag: "token" as const })))
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match)
    return decodeCredential(match[1]).pipe(Effect.map((credential) => ({ ...credential, _tag: "basic" as const })))
  const cookie = parseCookies(request.headers.cookie).get(SESSION_COOKIE)
  if (cookie) return Effect.succeed({ _tag: "cookie" as const, value: cookie })
  return Effect.succeed(emptyCredential())
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect
        const credential = yield* credentialFromRequest(request)
        if (credential._tag === "cookie") {
          if (Option.isSome(config.password) && verifySession(credential.value, config.password.value))
            return yield* effect
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
          return yield* new UnauthorizedError({ message: "Authentication required" })
        }
        if (!ServerAuth.authorized(credential, config)) {
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
          return yield* new UnauthorizedError({ message: "Authentication required" })
        }
        if (credential._tag === "token" && Option.isSome(config.password)) {
          const password = config.password.value
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(
              HttpServerResponse.setHeader(response, "set-cookie", sessionCookieHeader(signSession(password))),
            ),
          )
        }
        return yield* effect
      }),
    )
  }),
)
