import { test } from "bun:test"
import { start } from "../src/client"
import { ByteQueue } from "../src/protocol"

async function openRelay() {
  const res = await fetch("http://localhost:4096/browser/connect-token", { method: "POST", headers: { "x-opencode-directory": "/home/x1nx3r/redroid" } })
  const { ticket } = await res.json() as { ticket: string }
  const ws = new WebSocket(`ws://localhost:4096/browser/connect?ticket=${ticket}&directory=%2Fhome%2Fx1nx3r%2Fredroid`)
  ws.binaryType = "arraybuffer"
  const queue = new ByteQueue()
  ws.addEventListener("message", (e: MessageEvent) => {
    const d = e.data
    if (d instanceof ArrayBuffer) queue.push(new Uint8Array(d))
    else if (d instanceof Uint8Array) queue.push(d)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("ws error")))
    setTimeout(() => reject(new Error("ws timeout")), 30000)
  })
  return { ws, queue }
}

test("how long until a killed browser surfaces as a close", async () => {
  const a = await openRelay()
  const t0 = Date.now()
  let closedAt = 0
  const client = await start({ write: (b) => a.ws.send(b) }, { queue: a.queue, onClose: () => { closedAt = Date.now() - t0 } })
  console.log("UP", client.init.width, "x", client.init.height)
  const { spawnSync } = await import("node:child_process")
  spawnSync("pkill", ["-f", "Xvnc"])
  // Watch up to 20 seconds for the close.
  for (let i = 0; i < 40 && closedAt === 0; i++) await Bun.sleep(500)
  console.log("CLOSED_AFTER_MS", closedAt === 0 ? "never (20s)" : closedAt)
  a.ws.close()
}, 40000)
