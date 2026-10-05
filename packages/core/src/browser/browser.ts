export * as Browser from "./browser"

import { spawn, type ChildProcess } from "child_process"
import { Context, Effect, Layer, Schema, Semaphore, Types } from "effect"
import net from "node:net"
import { makeGlobalNode } from "../effect/app-node"
import * as Cdp from "./cdp"
import { readEndpoint, type Endpoint } from "./endpoint"
import { warningPageUrl } from "./start-page"
import { watchWindow } from "./window-follow"

// ADR-0003: one Chromium per session, headful on Xvnc. The agent drives it
// over CDP and the human watches it over RFB. Xvnc is the display server and
// the RFB server in one process, so the container needs one package and no
// encoder.
const GEOMETRY = { width: 1280, height: 720 }
const DEPTH = 24

// Displays above :99 never collide with a real console session. Xvnc honors
// ":N" as an abstract Unix socket, so there are no /tmp/.X11-unix files with
// mode bits to protect.
const DISPLAY_BASE = 1000
const RFB_PORT_BASE = 6100

const START_TIMEOUT_MS = 5_000
const PROBE_INTERVAL_MS = 100

export const Info = Schema.Struct({
  display: Schema.Number,
  rfbPort: Schema.Number,
  pid: Schema.Number,
  // The loopback port Chromium chose for CDP. Container-local, never published.
  cdpPort: Schema.Number,
})
export type Info = Types.DeepMutable<typeof Info.Type>

export class LaunchError extends Schema.TaggedErrorClass<LaunchError>()("Browser.LaunchError", {
  message: Schema.String,
}) {}

export interface Interface {
  // The running browser, or undefined while it is not up.
  readonly get: Effect.Effect<Info | undefined>
  // Idempotent start. Verifies the RFB port answers before resolving.
  readonly ensure: Effect.Effect<Info, LaunchError>
  // The browser-scope CDP client, or undefined while it is not up. Browser
  // domains only: page work connects to a page target through the endpoint.
  readonly cdp: Effect.Effect<Cdp.Interface | undefined>
  // The debugging endpoint, so a caller can open a page connection of its own.
  readonly endpoint: Effect.Effect<Endpoint | undefined>
  // Stop the browser and the display server. Safe when already down.
  readonly stop: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Browser") {}

type Active = {
  info: Info
  chrome: ChildProcess
  xvnc: ChildProcess
  cdp: Cdp.Interface
  endpoint: Endpoint
  profile: string
  // Stops the watcher that keeps Chromium's window the size of the screen.
  stopWatching: () => void
}

function probeRfb(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.setTimeout(PROBE_INTERVAL_MS)
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }
    socket.on("connect", () => done(true))
    socket.on("error", () => done(false))
    socket.on("timeout", () => done(false))
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // One browser per process. The closure is per-process, like Database's.
    let active: Active | undefined
    // `ensure` is check-then-launch, and `active` is only assigned when the
    // launch finishes. Two callers arriving before that both saw `undefined`
    // and both launched — two Xvnc, two Chromium, two profiles, and neither
    // aware of the other. The permit serialises the check with the launch, so
    // the second caller waits and then finds the first's browser.
    const launchLock = Semaphore.makeUnsafe(1)

    const kill = (proc: ChildProcess | undefined) => {
      if (!proc) return
      if (proc.exitCode !== null || proc.signalCode !== null) return
      try {
        proc.kill("SIGTERM")
        setTimeout(() => {
          try {
            proc.kill("SIGKILL")
          } catch {}
        }, 500)
      } catch {}
    }

    // Chromium first, so it never survives its display server.
    const teardown = () => {
      const current = active
      if (!current) return
      active = undefined
      current.stopWatching()
      kill(current.chrome)
      kill(current.xvnc)
    }

    yield* Effect.addFinalizer(() => Effect.sync(teardown))

    // Chromium died: take the display server with it and clear state, so the
    // next ensure() relaunches cleanly.
    function watch(chrome: ChildProcess, xvnc: ChildProcess) {
      chrome.once("close", () => {
        if (active?.chrome === chrome) {
          kill(xvnc)
          active = undefined
        }
      })
    }

    const launch = Effect.gen(function* () {
      const n = DISPLAY_BASE + Math.floor(Math.random() * 900)
      const rfbPort = RFB_PORT_BASE + (n - DISPLAY_BASE)
      const xvnc = spawn(
        "Xvnc",
        [
          `:${n}`,
          "-geometry",
          `${GEOMETRY.width}x${GEOMETRY.height}`,
          "-depth",
          String(DEPTH),
          "-SecurityTypes",
          "None",
          "-rfbport",
          String(rfbPort),
          "-nolisten",
          "tcp",
        ],
        { stdio: "ignore" },
      )
      const up = yield* Effect.promise(async () => {
        const deadline = Date.now() + START_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (await probeRfb(rfbPort)) return true
          if (xvnc.exitCode !== null) return false
          await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
        }
        return false
      })
      if (!up) {
        teardown()
        return yield* new LaunchError({ message: `RFB port ${rfbPort} never answered` })
      }
      const profile = `/tmp/opencode-browser-${n}`
      const chrome = spawn(
        "chromium",
        [
          "--ozone-platform=x11",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-features=Translate",
          "--window-position=0,0",
          `--window-size=${GEOMETRY.width},${GEOMETRY.height}`,
          // Chromium picks the port and publishes it, with the browser path, in
          // DevToolsActivePort inside the profile we own. The listener is
          // container loopback and deusd never publishes it. See endpoint.ts
          // for why this replaced --remote-debugging-pipe.
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          // The browser opens on the container warning rather than a blank tab.
          // It is the first thing the human sees, which is when the warning is
          // worth anything, and the agent navigates away as soon as it acts.
          warningPageUrl(),
        ],
        { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, DISPLAY: `:${n}` } },
      )
      if (!chrome.pid) {
        teardown()
        return yield* new LaunchError({ message: "chromium did not spawn" })
      }

      // Wait for the endpoint, then open one connection at browser scope. All
      // page work attaches to a target from there.
      const endpoint = yield* Effect.tryPromise({
        try: () => readEndpoint(profile),
        catch: (error) => new LaunchError({ message: `chromium never published an endpoint: ${String(error)}` }),
      }).pipe(
        Effect.catchTag("Browser.LaunchError", (error) => {
          teardown()
          return Effect.fail(error)
        }),
      )
      const cdp = yield* Effect.tryPromise({
        try: () =>
          Cdp.connect(endpoint.browserUrl, {
            // A closed socket means the browser is gone, so drop state and let
            // the next ensure() relaunch rather than leaving a dead client.
            onClose: () => {
              if (active?.chrome === chrome) {
                kill(xvnc)
                active = undefined
              }
            },
          }),
        catch: (error) =>
          new LaunchError({ message: `unable to reach chromium at ${endpoint.browserUrl}: ${String(error)}` }),
      }).pipe(
        Effect.catchTag("Browser.LaunchError", (error) => {
          teardown()
          return Effect.fail(error)
        }),
      )

      active = {
        info: { display: n, rfbPort, pid: chrome.pid, cdpPort: endpoint.port },
        chrome,
        xvnc,
        cdp,
        endpoint,
        profile,
        // Nothing resizes Chromium's window when the screen changes and there is
        // no window manager, so it is done here. The relay never parses RFB, so
        // the backend cannot react to a resize on the wire; reading the screen
        // and setting the window makes it true for any cause.
        stopWatching: watchWindow(
          {
            display: `:${n}`,
            cdp: () => {
              const current = active
              if (!current || current.cdp.closed()) return undefined
              return current.cdp
            },
          },
          { onError: (error) => console.error("[browser] window-follow failed", error) },
        ),
      }
      watch(chrome, xvnc)
      return active.info
    })

    const ensure: Effect.Effect<Info, LaunchError> = launchLock.withPermits(1)(
      Effect.gen(function* () {
        if (active && active.chrome.exitCode === null && active.xvnc.exitCode === null) return active.info
        teardown()
        return yield* launch
      }),
    )

    // Reads live state on each run, so a browser that died is reported.
    const get: Effect.Effect<Info | undefined> = Effect.gen(function* () {
      return active && active.chrome.exitCode === null ? active.info : undefined
    })

    const cdp: Effect.Effect<Cdp.Interface | undefined> = Effect.gen(function* () {
      if (!active || active.chrome.exitCode !== null || active.cdp.closed()) return undefined
      return active.cdp
    })

    const endpoint: Effect.Effect<Endpoint | undefined> = Effect.gen(function* () {
      if (!active || active.chrome.exitCode !== null) return undefined
      return active.endpoint
    })

    const stop: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.sync(teardown)
    })

    return Service.of({ get, ensure, cdp, endpoint, stop })
  }),
)

// One browser per process, not per location. The browser is a container-level
// resource: one Xvnc and one Chromium serve the whole container, and there is
// no sense in which a subdirectory gets its own. Keying it by Location let the
// pane and the tool resolve different directories and start two stacks, each
// blind to the other. Global is the same model Pty.ticket, Database and
// Credential use, and it is what makes "one browser per session" true.
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
