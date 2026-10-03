export * as BrowserTicket from "./ticket"

import { WorkspaceV2 } from "../workspace"
import { Cache, Context, Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

// ADR-0003: the RFB relay needs its own ticket, because the PTY ticket is
// scoped to a ptyID and a browser has no such id. Same shape otherwise: a
// short-lived single-use token that lets the WebSocket upgrade past the auth
// middleware, which is how the PTY route already works.
//
// The ticket is not the authentication. It is a scoped capability created by an
// already-authenticated caller, so the upgrade carries it in the query string
// instead of credentials.

const DEFAULT_TTL = Duration.seconds(60)
const CAPACITY = 10_000

export type ConnectToken = {
  readonly ticket: string
  readonly expires_in: number
}

export type Scope = {
  readonly directory?: string
  readonly workspaceID?: WorkspaceV2.ID
}

export interface Interface {
  readonly issue: (input: Scope) => Effect.Effect<ConnectToken>
  readonly consume: (input: Scope & { readonly ticket: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserTicket") {}

function matches(record: Scope, input: Scope) {
  return record.directory === input.directory && record.workspaceID === input.workspaceID
}

// Tickets are inserted with Cache.set and removed atomically with
// invalidateWhen. Lookup is never invoked, so it dies if it ever is, which
// would signal misuse of the interface.
const noLookup = () => Effect.die("BrowserTicket cache must be used via set/invalidateWhen, never get")

export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, Scope>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))
    return Service.of({
      issue: Effect.fn("BrowserTicket.issue")(function* (input) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(cache, ticket, input)
        return { ticket, expires_in: expiresIn }
      }),
      consume: Effect.fn("BrowserTicket.consume")(function* (input) {
        return yield* Cache.invalidateWhen(cache, input.ticket, (stored) => matches(stored, input))
      }),
    })
  })

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
