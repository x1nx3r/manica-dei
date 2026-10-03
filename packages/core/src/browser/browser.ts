export * as Browser from "./browser"

import { spawn, type ChildProcess } from "child_process"
import { Context, Effect, Layer, Schema, Types } from "effect"
import net from "node:net"
import { makeLocationNode } from "../effect/app-node"

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
  // Stop the browser and the display server. Safe when already down.
  readonly stop: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Browser") {}

type Active = {
  info: Info
  chrome: ChildProcess
  xvnc: ChildProcess
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
    // One browser per location. The closure is per-directory, like Pty's.
    let active: Active | undefined

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
          // fd 3 and 4 are the CDP control pipe: we write 3, read 4.
          "--remote-debugging-pipe",
          `--user-data-dir=/tmp/opencode-browser-${n}`,
          "about:blank",
        ],
        {
          stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
          env: { ...process.env, DISPLAY: `:${n}` },
        },
      )
      if (!chrome.pid) {
        teardown()
        return yield* new LaunchError({ message: "chromium did not spawn" })
      }
      active = { info: { display: n, rfbPort, pid: chrome.pid }, chrome, xvnc }
      watch(chrome, xvnc)
      return active.info
    })

    const ensure: Effect.Effect<Info, LaunchError> = Effect.gen(function* () {
      if (active && active.chrome.exitCode === null && active.xvnc.exitCode === null) return active.info
      teardown()
      return yield* launch
    })

    // Reads live state on each run, so a browser that died is reported.
    const get: Effect.Effect<Info | undefined> = Effect.gen(function* () {
      return active && active.chrome.exitCode === null ? active.info : undefined
    })

    const stop: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.sync(teardown)
    })

    return Service.of({ get, ensure, stop })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })