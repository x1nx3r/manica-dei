import { describe, expect, test } from "bun:test"
import { BrowserTicket } from "@opencode-ai/core/browser/ticket"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Effect } from "effect"

// BrowserTicket is a single-use, scoped, expiring capability, exactly like the
// PTY ticket. A relay that accepted a reused or foreign ticket would let any
// holder of the URL attach to another session's framebuffer.

const runtime = makeRuntime(BrowserTicket.Service, LayerNode.compile(BrowserTicket.node))
const run = <A>(fn: (service: BrowserTicket.Interface) => Effect.Effect<A, never>) => runtime.runPromise(fn)

describe("browser ticket", () => {
  test("issues a ticket scoped to its directory", async () => {
    const issued = await run((tickets) => tickets.issue({ directory: "/tmp/a" }))
    expect(issued.ticket).toMatch(/^[0-9a-f-]{36}$/)
    expect(issued.expires_in).toBeGreaterThan(0)
  })

  test("consumes once and not twice", async () => {
    const result = await run((tickets) =>
      Effect.gen(function* () {
        const { ticket } = yield* tickets.issue({ directory: "/tmp/a" })
        const first = yield* tickets.consume({ ticket, directory: "/tmp/a" })
        const second = yield* tickets.consume({ ticket, directory: "/tmp/a" })
        return { first, second }
      }),
    )
    expect(result.first).toBe(true)
    expect(result.second).toBe(false)
  })

  test("refuses a ticket issued for another directory", async () => {
    const ok = await run((tickets) =>
      Effect.gen(function* () {
        const { ticket } = yield* tickets.issue({ directory: "/tmp/a" })
        return yield* tickets.consume({ ticket, directory: "/tmp/b" })
      }),
    )
    expect(ok).toBe(false)
  })

  test("refuses an unknown ticket", async () => {
    const ok = await run((tickets) => tickets.consume({ ticket: "nope", directory: "/tmp/a" }))
    expect(ok).toBe(false)
  })
})
