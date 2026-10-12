import { tool } from "@opencode-ai/plugin"

/**
 * The meta-agent's hands. It drives the *inner* opencode session — the one
 * running the goal loop against the fixture — over the documented HTTP API.
 *
 * The runner sets the environment before the server starts:
 *
 *   EVAL_SERVER_URL       the inner opencode server
 *   EVAL_SERVER_PASSWORD  its Basic auth password, if any
 *   EVAL_INNER_DIR        the workspace the inner session runs in
 *   EVAL_INNER_MODEL      provider/model for the inner session (optional)
 */

const base = () => process.env.EVAL_SERVER_URL ?? "http://127.0.0.1:4096"
const innerDir = () => process.env.EVAL_INNER_DIR ?? process.cwd()

function headers(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-opencode-directory": innerDir(),
  }
  const password = process.env.EVAL_SERVER_PASSWORD
  if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  return headers
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

function model(id: string) {
  const [providerID, ...rest] = id.split("/")
  return { providerID, id: rest.join("/") }
}

type Action = "start" | "prompt" | "read" | "answer" | "stop"
type Args = { action: Action; text?: string; answer?: string }

/**
 * GLM 5.3 flash sometimes folds an argument into `action`, e.g.
 * `answer<arg_key>answer</arg_key><arg_value>…</arg_value>`. Recover it rather
 * than fail the turn.
 */
function normalize(args: Args): Args {
  const match = /^(.*?)<arg_key>(.*?)<\/arg_key><arg_value>([\s\S]*)$/.exec(String(args.action))
  if (!match) return args
  const [, action, key, raw] = match
  return { ...args, action, [key!]: raw!.replace(/<\/arg_value>\s*$/, "") } as Args
}

type Part = { type: string; text?: string; tool?: string; state?: { status?: string } }
type Message = { info?: { id?: string; role?: string }; parts?: Part[] }
type Question = {
  id: string
  sessionID?: string
  questions?: Array<{ header?: string; question?: string; options?: Array<{ label?: string }> }>
}

let inner: string | null = null

/** How much of each part we have already shown the meta-agent. */
const shown = new Map<string, Map<number, number>>()

/**
 * Render only what is new since the last read. The meta-agent is long-lived
 * and reads many times, so the transcript must not grow its context without
 * bound.
 */
function renderNew(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const mid = message.info?.id
    if (!mid) continue
    const parts = shown.get(mid) ?? new Map<number, number>()
    const role = message.info?.role ?? "?"

    message.parts?.forEach((part, index) => {
      const done = parts.get(index) ?? 0

      if (part.type === "text") {
        const text = part.text ?? ""
        if (text.length > done) {
          lines.push(`[${role}] ${text.slice(done)}`)
          parts.set(index, text.length)
        }
        return
      }

      if (part.type === "tool" && done !== -1) {
        lines.push(`[${role} → ${part.tool}] ${part.state?.status ?? ""}`)
        parts.set(index, -1)
      }
    })

    shown.set(mid, parts)
  }
  return lines.join("\n")
}

/** Spell out a pending question so the meta-agent can answer it. */
function describe(questions: Question[]): string {
  const lines: string[] = []
  for (const request of questions) {
    for (const question of request.questions ?? []) {
      lines.push(`Q: ${question.question ?? question.header ?? ""}`)
      for (const option of question.options ?? []) lines.push(`   - ${option.label ?? ""}`)
    }
  }
  return lines.join("\n")
}

/** The pending question for the inner session, if any. */
async function pending(): Promise<Question | null> {
  if (!inner) throw new Error("no inner session — call start first")
  const questions = await api<Question[]>("GET", "/question")
  return questions.find((question) => question.sessionID === inner) ?? null
}

/** Wait until the agent stops working, or asks a question. */
async function settle(): Promise<Question | null> {
  if (!inner) throw new Error("no inner session — call start first")
  for (let i = 0; i < 1800; i++) {
    const question = await pending()
    if (question) return question
    const status = await api<Record<string, { type?: string }>>("GET", "/session/status")
    if (status[inner]?.type !== "busy") return null
    await Bun.sleep(1000)
  }
  throw new Error("the inner session never settled")
}

export default tool({
  description: `Drive the inner coding session. One action per call:
- start: open the inner session in the workspace
- prompt: send a message as the user (needs \`text\`)
- read: wait for the agent to stop or ask a question, then read what is new
- answer: reply to a pending question (needs \`answer\` — one option label, exactly as offered)
- stop: end the inner session`,
  args: {
    action: tool.schema.enum(["start", "prompt", "read", "answer", "stop"]).describe("what to do"),
    text: tool.schema.string().optional().describe("the user's message (action: prompt)"),
    answer: tool.schema.string().optional().describe("the option label to select, exactly as offered (action: answer)"),
  },
  async execute(raw) {
    const args = normalize(raw as Args)

    switch (args.action) {
      case "start": {
        const id = process.env.EVAL_INNER_MODEL
        const session = await api<{ id: string }>("POST", "/session", id ? { model: model(id) } : {})
        inner = session.id
        shown.clear()
        return `inner session ${inner} started in ${innerDir()}`
      }

      case "prompt": {
        if (!inner) throw new Error("no inner session — call start first")
        if (!args.text) throw new Error("prompt needs text")
        await api("POST", `/session/${inner}/prompt_async`, { parts: [{ type: "text", text: args.text }] })
        return "sent"
      }

      case "read": {
        const question = await settle()
        const messages = await api<Message[]>("GET", `/session/${inner}/message`)
        return [
          renderNew(messages) || "(nothing new)",
          question
            ? `\n\nThe agent is waiting for an answer:\n${describe([question])}`
            : "\n\nThe agent is idle. No pending question.",
        ].join("")
      }

      case "answer": {
        if (!args.answer) throw new Error("answer needs the option label")
        const question = await pending()
        if (!question) throw new Error("no pending question to answer")
        await api("POST", `/question/${question.id}/reply`, { answers: [[args.answer]] })
        return `answered: ${args.answer}`
      }

      case "stop": {
        inner = null
        shown.clear()
        return "stopped"
      }

      default:
        throw new Error(`unknown action ${JSON.stringify(args.action)} — use start, prompt, read, answer or stop`)
    }
  },
})
