/**
 * Mirror sessions to the log while a run is in flight, so the whole thing is
 * observable as it happens. Polling, not SSE: it uses only the endpoints the
 * runner already speaks, and it survives a server restart.
 *
 * Text streams as it grows; tool calls print when they appear.
 */

type Part = {
  type: string
  text?: string
  tool?: string
  state?: { status?: string }
}
type Message = { info?: { id?: string; role?: string }; parts?: Part[] }

export type Target = { label: string; base: string; directory: string }

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

export function watch(options: {
  headers: Record<string, string>
  targets: Target[]
  intervalMs?: number
}): { stop(): void } {
  const sessions = new Map<string, string | null>()
  const printed = new Map<string, Map<number, number>>()
  const lastMessage = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false

  async function get(target: Target, path: string): Promise<unknown> {
    const response = await fetch(`${target.base}${path}`, {
      headers: { ...options.headers, "x-opencode-directory": target.directory },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return null
    return response.json()
  }

  async function resolve(target: Target): Promise<string | null> {
    const known = sessions.get(target.label)
    if (known) return known
    const list = (await get(target, "/session")) as Array<{ id: string }> | null
    const id = list?.[0]?.id ?? null
    sessions.set(target.label, id)
    return id
  }

  async function drain(target: Target): Promise<void> {
    const id = await resolve(target)
    if (!id) return
    const messages = (await get(target, `/session/${id}/message`)) as Message[] | null
    if (!messages) return

    for (const message of messages) {
      const mid = message.info?.id
      if (!mid) continue
      const key = `${target.label}:${mid}`
      const parts = printed.get(key) ?? new Map<number, number>()
      const header = () => {
        if (lastMessage.get(target.label) === mid) return
        lastMessage.set(target.label, mid)
        process.stdout.write(`\n\n${BOLD}── ${target.label} · ${message.info?.role ?? "?"} ──${RESET}\n`)
      }

      message.parts?.forEach((part, index) => {
        const done = parts.get(index) ?? 0

        // Only text and tool calls make a readable transcript; skip the rest.
        if (part.type === "text") {
          const text = part.text ?? ""
          if (text.length > done) {
            header()
            process.stdout.write(text.slice(done))
            parts.set(index, text.length)
          }
          return
        }

        if (part.type !== "tool") {
          parts.set(index, -1)
          return
        }

        if (done === -1) return
        header()
        const status = part.state?.status ? ` (${part.state.status})` : ""
        process.stdout.write(`\n${DIM}  ▸ ${part.tool ?? "tool"}${status}${RESET}\n`)
        parts.set(index, -1)
      })

      printed.set(key, parts)
    }
  }

  async function tick(): Promise<void> {
    if (busy) return
    busy = true
    try {
      for (const target of options.targets) await drain(target)
    } catch {
      // the server may be shutting down; try again next tick
    } finally {
      busy = false
    }
  }

  timer = setInterval(tick, options.intervalMs ?? 800)

  return {
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
}
