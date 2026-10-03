import { ServerAuth } from "@/server/auth"
import {
  parseCookies,
  sessionCookieHeader,
  signSession,
  verifySession,
  SESSION_COOKIE,
} from "@opencode-ai/server/shared/session-cookie"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { hasBrowserConnectTicketURL } from "@/server/shared/browser-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@opencode-ai/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

// Credentials reach the middleware three ways: the ?auth_token= query
// (browser flow — issues a session cookie), Basic (API clients), and the
// session cookie itself (subresources, WebSocket, EventSource).
export type Credential =
  | (ServerAuth.DecodedCredentials & { readonly _tag: "token" | "basic" })
  | { readonly _tag: "cookie"; readonly value: string }

function emptyCredential(): Credential {
  return {
    _tag: "basic",
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(effect: Effect.Effect<A, E, R>, credential: Credential, config: ServerAuth.Info) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (credential._tag === "cookie") {
      if (!(Option.isSome(config.password) && verifySession(credential.value, config.password.value))) {
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new HttpApiError.Unauthorized({})
      }
      return yield* effect
    }
    if (!ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
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
  })
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

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
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

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: Credential,
  config: ServerAuth.Info,
) {
  if (!ServerAuth.required(config)) return effect
  if (credential._tag === "cookie") {
    if (!(Option.isSome(config.password) && verifySession(credential.value, config.password.value)))
      return Effect.succeed(
        HttpServerResponse.empty({
          status: UNAUTHORIZED,
          headers: { "www-authenticate": WWW_AUTHENTICATE },
        }),
      )
    return effect
  }
  if (!ServerAuth.authorized(credential, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      }),
    )
  if (credential._tag === "token" && Option.isSome(config.password)) {
    const password = config.password.value
    return Effect.gen(function* () {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          HttpServerResponse.setHeader(response, "set-cookie", sessionCookieHeader(signSession(password))),
        ),
      )
      return yield* effect
    })
  }
  return effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)

export class BrowserConnectAuthorization extends HttpApiMiddleware.Service<BrowserConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiBrowserConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export const browserConnectAuthorizationLayer = Layer.effect(
  BrowserConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return BrowserConnectAuthorization.of((effect) => effect)
    return BrowserConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasBrowserConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return PtyConnectAuthorization.of((effect) => effect)
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)
