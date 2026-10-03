import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { decodeAll, encodeMessage } from "@opencode-ai/core/browser/cdp-pipe"

// Talks to a real Chromium over --remote-debugging-pipe. This is the guard
// against getting the framing wrong again: the pipe is bare JSON with a NUL
// terminator, and a wrong guess makes Chromium answer a JSON parse error
// instead of the result, or go silent.
//
// Guarded like the lifecycle test: passes with Xvnc and chromium present, skips
// silently otherwise.

const guard = process.env.MANUS_INTEGRATION === "1"
const hasBin = (name: string) => Bun.spawnSync(["which", name]).exitCode === 0
const skip = !guard || !hasBin("Xvnc") || !hasBin("chromium")

describe.skipIf(skip)("cdp over the remote debugging pipe", () => {
  test("Browser.getVersion round trips through the pipe", async () => {
    const display = 1290
    const rfbPort = 7190
    const xvnc = spawn(
      "Xvnc",
      [
        `:${display}`,
        "-geometry",
        "1280x720",
        "-depth",
        "24",
        "-SecurityTypes",
        "None",
        "-rfbport",
        String(rfbPort),
        "-nolisten",
        "tcp",
      ],
      { stdio: "ignore" },
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const chrome = spawn(
      "chromium",
      [
        "--ozone-platform=x11",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--window-size=1280,720",
        "--remote-debugging-pipe",
        `--user-data-dir=/tmp/opencode-cdp-test-${display}`,
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        env: { ...process.env, DISPLAY: `:${display}` },
      },
    )

    const toChromium = chrome.stdio[3] as NodeJS.WritableStream
    const fromChromium = chrome.stdio[4] as NodeJS.ReadableStream

    try {
      let buffer: Buffer = Buffer.alloc(0)
      const pending = new Map<number, (message: unknown) => void>()

      fromChromium.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const { payloads, rest } = decodeAll(buffer)
        buffer = rest
        for (const payload of payloads) {
          const message = JSON.parse(payload) as { id?: number }
          if (message.id !== undefined) pending.get(message.id)?.(message)
          if (message.id !== undefined) pending.delete(message.id)
        }
      })

      const send = (method: string, params: Record<string, unknown> = {}) => {
        const id = 1
        toChromium.write(encodeMessage(JSON.stringify({ id, method, params })))
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 8000)
          pending.set(id, (message) => {
            clearTimeout(timer)
            resolve(message as Record<string, unknown>)
          })
        })
      }

      const reply = await send("Browser.getVersion")
      const result = reply.result as { product?: string; protocolVersion?: string }
      expect(result.product).toContain("Chrome/")
      expect(result.protocolVersion).toBe("1.3")
    } finally {
      chrome.kill("SIGKILL")
      xvnc.kill("SIGKILL")
    }
  }, 30_000)
})
