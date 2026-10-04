import { beforeAll, describe, expect, mock, test } from "bun:test"

// The provider's reconnect behaviour, with the client and the relay replaced.
//
// The policy is pure and tested on its own; this is the orchestration around it,
// which is where the mistakes that matter live: a deliberate close that retries
// anyway, a drop that never tries again, and attempts that never stop. All three
// fail quietly, so they are asserted rather than inspected.
//
// `createSimpleContext` is replaced with a capture, so the provider's real
// `init` is exercised without a renderer.

type Init = () => Record<string, any>

let capturedInit: Init | undefined

beforeAll(async () => {
  const actual = await import("@opencode-ai/ui/context")
  mock.module("@opencode-ai/ui/context", () => ({
    ...actual,
    createSimpleContext: (input: { init: Init }) => {
      capturedInit = input.init
      return { use: () => undefined, provider: () => undefined }
    },
  }))
  mock.module("./sdk", () => ({
    useSDK: () => () => ({ url: "http://127.0.0.1:4096", directory: "/tmp" }),
  }))
  // The URL poll is a liveness signal, so the default answer is a live browser.
  // A test that wants a dead one overrides this.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ url: "about:blank" }), { status: 200 })) as unknown as typeof fetch
  // A client whose `onClose` the test can fire, and which records how many times
  // it was started.
  await import("./browser")
})

/** A fake client and relay, and the counters the test asserts on. */
function harness() {
  const opens: number[] = []
  let closeCallback: ((error?: Error) => void) | undefined

  mock.module("@opencode-ai/core/browser/relay", () => ({
    connect: async () => {
      opens.push(1)
      return {
        socket: { close: () => {} },
        queue: { push: () => {} },
        transport: { write: () => {} },
      }
    },
  }))

  mock.module("@manica-dei/vnc", () => ({
    start: async (_transport: unknown, options: { onClose?: (error?: Error) => void }) => {
      closeCallback = options.onClose
      return {
        init: { width: 1280, height: 720, name: "" },
        framebuffer: { width: 1280, height: 720, data: new Uint8Array(0) },
        request: () => {},
        resize: () => {},
        key: () => {},
        pointer: () => {},
        close: () => {},
        closed: () => false,
      }
    },
  }))

  return {
    opens,
    /** Fire the client's close, as a dropped stream does. */
    drop: (error?: Error) => closeCallback?.(error),
  }
}

describe("browser provider reconnect", () => {
  test("two reports of one failure spend one attempt", async () => {
    // The socket's close callback and the URL poll can both fire for a single
    // failure. Without a guard the second spends another attempt, so one
    // flapping event could exhaust the budget.
    const { drop } = harness()
    const ctx = capturedInit!()
    await ctx.open()
    drop(new Error("the relay closed"))
    expect(ctx.state.attempt).toBe(1)
    // A second report for the same dead stream must not advance the count.
    drop(new Error("the relay closed"))
    drop(new Error("the relay closed"))
    expect(ctx.state.attempt).toBe(1)
    expect(ctx.state.status).toBe("reconnecting")
    // Let the scheduled retry settle so it does not leak into another test.
    await Bun.sleep(500)
  })

  test("a dropped stream becomes reconnecting, then open again", async () => {
    const { opens, drop } = harness()
    const ctx = capturedInit!()
    await ctx.open()
    expect(opens.length).toBe(1)
    expect(ctx.state.status).toBe("open")

    drop(new Error("the relay closed"))
    // Not "failed": another attempt is coming, and the pane says so.
    expect(ctx.state.status).toBe("reconnecting")
    expect(ctx.state.attempt).toBe(1)

    // The first delay is 500 ms.
    await Bun.sleep(700)
    expect(opens.length).toBe(2)
    expect(ctx.state.status).toBe("open")
  })

  test("a deliberate close does not reconnect", async () => {
    const { opens, drop } = harness()
    const ctx = capturedInit!()
    await ctx.open()
    ctx.close()
    expect(ctx.state.status).toBe("closed")
    // Even a stray close callback after a deliberate close must not reopen.
    drop()
    await Bun.sleep(700)
    expect(opens.length).toBe(1)
    expect(ctx.state.status).toBe("closed")
  })

  test("the attempts are capped and the failure is terminal", async () => {
    const { opens } = harness()
    const ctx = capturedInit!()
    await ctx.open()
    // Make every reconnect fail, so the budget is spent within one drop.
    mock.module("@opencode-ai/core/browser/relay", () => ({
      connect: async () => {
        throw new Error("relay unreachable")
      },
    }))
    ctx.retry()
    // The delays sum to about nine seconds, then the next attempt has no delay
    // left, so the terminal state arrives shortly after.
    await Bun.sleep(11_000)
    expect(ctx.state.status).toBe("failed")
    expect(ctx.state.error).toContain("relay unreachable")
  }, 15_000)

  test("retry opens again after a terminal failure", async () => {
    const { opens } = harness()
    const ctx = capturedInit!()
    await ctx.open()
    ctx.retry()
    await Bun.sleep(50)
    expect(opens.length).toBeGreaterThanOrEqual(1)
  })

  test("the URL poll detects a browser that died without closing the socket", async () => {
    // A killed server process does not close its accepted connections — a
    // direct TCP connection to a killed Xvnc stays open past five seconds — so
    // the RFB socket is not a liveness signal. The poll is. When it reports no
    // browser, the stream is dead whatever the socket says.
    const { opens } = harness()
    const ctx = capturedInit!()
    await ctx.open()
    expect(ctx.state.status).toBe("open")

    // The server now says there is no browser.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ url: "", error: "no browser" }), { status: 200 })) as unknown as typeof fetch

    // The poll runs every second while open.
    await Bun.sleep(1_400)
    expect(ctx.state.status).toBe("reconnecting")

    // And a reconnect follows, which relaunches the browser on demand.
    await Bun.sleep(700)
    expect(opens.length).toBeGreaterThanOrEqual(2)
  }, 15_000)
})
