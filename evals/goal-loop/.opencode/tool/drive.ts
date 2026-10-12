import { tool } from "@opencode-ai/plugin"

/**
 * The meta-agent's hands. It drives the *inner* opencode session — the one
 * running the goal loop against the fixture — over the documented HTTP API.
 *
 * The runner sets the environment before the server starts:
 *
 *   EVAL_SERVER_URL       the opencode server hosting both sessions
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
  return { providerID, modelID: rest.join("/") }
}

type Part = { type: string; text?: string; tool?: string; state?: { status?: string } }
type Message = { info?: { role?: string }; parts?: Part[] }

let inner: string | null = null

/** Render the tail of a session as plain text for the meta-agent to read. */
function render(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages.slice(-10)) {
    const role = message.info?.role ?? "?"
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) lines.push(`[${role}] ${part.text}`)
      else if (part.type === "tool") lines.push(`[${role} → ${part.tool}] ${part.state?.status ?? ""}`)
    }
  }
  return lines.join("\n")
}

/** Wait until the inner session stops producing messages. */
async function settle(): Promise<Message[]> {
  if (!inner) throw new Error("no inner session — call start first")
  let last = -1
  let stable = 0
  for (let i = 0; i < 600; i++) {
    const messages = await api<Message[]>("GET", `/session/${inner}/message`)
    if (messages.length === last) stable++
    else stable = 0
    last = messages.length
    if (stable >= 3) return messages
    await Bun.sleep(1000)
  }
  throw new Error("inner session did not settle")
}

export default tool({
  description: `Drive the inner coding session. One action per call:
- start: open the inner session in the workspace
- prompt: send a message as the user (needs \`text\`)
- read: wait for the agent to stop, then read the new messages and any pending question
- answer: reply to a pending question (needs \`requestID\` and \`answers\`)
- stop: end the inner session`,
  args: {
    action: tool.schema.enum(["start", "prompt", "read", "answer", "stop"]).describe("what to do"),
    text: tool.schema.string().optional().describe("the user's message (action: prompt)"),
    requestID: tool.schema.string().optional().describe("the question to answer (action: answer)"),
    answers: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("selected labels, one entry per question (action: answer)"),
  },
  async execute(args) {
    if (args.action === "start") {
      const id = process.env.EVAL_INNER_MODEL
      const session = await api<{ id: string }>("POST", "/session", id ? { model: model(id) } : {})
      inner = session.id
      return `inner session ${inner} started in ${innerDir()}`
    }

    if (args.action === "prompt") {
      if (!inner) throw new Error("no inner session — call start first")
      if (!args.text) throw new Error("prompt needs text")
      await api("POST", `/session/${inner}/prompt_async`, { parts: [{ type: "text", text: args.text }] })
      return "sent"
    }

    if (args.action === "read") {
      const messages = await settle()
      const questions = await api<Array<{ sessionID?: string }>>("GET", "/question")
      const pending = questions.filter((question) => question.sessionID === inner)
      return [
        render(messages),
        pending.length ? `\nPENDING QUESTIONS\n${JSON.stringify(pending, null, 2)}` : "\nNo pending questions.",
      ].join("\n")
    }

    if (args.action === "answer") {
      if (!args.requestID) throw new Error("answer needs requestID")
      await api("POST", `/question/${args.requestID}/reply`, { answers: (args.answers ?? []).map((a) => [a]) })
      return "answered"
    }

    inner = null
    return "stopped"
  },
})
