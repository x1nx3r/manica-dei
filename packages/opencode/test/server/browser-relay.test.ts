import { afterEach, describe, expect } from "bun:test"
import { Layer } from "effect"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { HttpServer } from "effect/unstable/http"
import { Browser } from "@opencode-ai/core/browser"
import { start } from "@manica-dei/vnc"
import { connect } from "@opencode-ai/core/browser/relay"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

// ADR-0003: the human's side of the transport, end to end.
//
// This is the first test where the relay and the client meet a real server.
// Both were proven separately against fakes until now, so this is the one that
// can find a seam between them.
//
// The browser services are merged with the routes on a single layer, so the
// route and this test share one LocationServiceMap. That matters: the route
// resolves the browser through the map, and a second map would hand it a
// different browser than the test started. That is exactly how the earlier
// attempt at this test failed.
//
// Guarded, because it launches Xvnc and Chromium.

const guard = process.env.MANUS_INTEGRATION === "1"
const hasBin = (name: string) => Bun.spawnSync(["which", name]).exitCode === 0
const skip = !guard || !hasBin("Xvnc") || !hasBin("chromium")

const it = testEffect(Layer.mergeAll(LayerNode.compile(Browser.node), httpApiLayer))

const serverUrl = Effect.gen(function* () {
  return yield* HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe.skipIf(skip)("browser relay integration", () => {
  it.instance(
    "the client reads a real framebuffer through the relay",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
        const url = yield* serverUrl

        // Ask for a ticket the way the pane will. A 200 here also means the
        // route started the browser on demand rather than refusing.
        const response = yield* Effect.promise(() =>
          fetch(`${url}/browser/connect-token`, {
            method: "POST",
            headers: { "x-opencode-directory": dir },
          }),
        )
        expect(response.status).toBe(200)
        const ticket = yield* Effect.promise(async () => {
          const body = (await response.json()) as { ticket: string }
          return body.ticket
        })
        expect(ticket).toMatch(/^[0-9a-f-]{36}$/)

        // Open the relay with the client's own helper, so this exercises the
        // path the pane will take rather than a hand-rolled socket.
        const opened = yield* Effect.promise(() => connect({ url, directory: dir }))

        const frames: number[] = []
        const client = yield* Effect.promise(() =>
          start(opened.transport, { queue: opened.queue, onFrame: () => frames.push(1) }),
        )

        // The handshake completed, which means a real Xvnc sent its version,
        // accepted None security, and answered ServerInit.
        expect(client.init.width).toBe(1280)
        expect(client.init.height).toBe(720)
        expect(client.framebuffer.data.length).toBe(1280 * 720 * 4)

        // Wait for a frame, which means a real Chromium painted and the relay
        // carried it through. A frame alone is not enough: Chromium's first
        // paint is a blank white screen, and the launch page commits after it.
        // Wait for the dark container warning, or the sample would be the flash.
        const isDarkWarning = () => {
          const data = client.framebuffer.data
          let dark = 0
          let light = 0
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i]!
            const g = data[i + 1]!
            const b = data[i + 2]!
            if (r < 24 && g < 24 && b < 24) dark++
            if (r > 200 && g > 200 && b > 200) light++
          }
          return { dark, light, total: data.length / 4 }
        }
        let shot = { dark: 0, light: 0, total: 0 }
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 15_000
          while (Date.now() < deadline) {
            if (frames.length > 0) {
              shot = isDarkWarning()
              // The launch page is dark-dominant; the blank first paint is not.
              if (shot.dark > shot.total / 2) break
            }
            await new Promise((r) => setTimeout(r, 100))
          }
        })
        expect(frames.length).toBeGreaterThan(0)

        // The warning page is dark with a little light text, so the framebuffer
        // must be mostly dark and hold more than one colour. This is the
        // assertion a banner check cannot make, and it is the whole point.
        const data = client.framebuffer.data
        let light = 0
        const colours = new Set<number>()
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!
          const g = data[i + 1]!
          const b = data[i + 2]!
          if (r > 200 && g > 200 && b > 200) light++
          if (colours.size < 64) colours.add((r << 16) | (g << 8) | b)
        }
        // Print the measurement, so a pass is evidence rather than a green dot.
        console.log(`[relay] frames=${frames.length} dark=${shot.dark} light=${light} colours=${colours.size}`)
        expect(shot.dark).toBeGreaterThan(shot.total * 0.5)
        expect(light).toBeGreaterThan(0)
        expect(colours.size).toBeGreaterThan(1)

        client.close()
        opened.socket.close()
      }),
    60_000,
  )
})
