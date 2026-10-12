/**
 * M7 runner — the meta-agent eval.
 *
 *   MANUS_INTEGRATION=1 bun evals/goal-loop/run.ts --case medium --persona senior
 *
 * It copies the fixture to a scratch directory, starts one opencode server
 * (workspace = this directory, so the `meta` agent and the `drive` tool load),
 * opens the meta session with the case brief, waits for the scorecard, and
 * prints it. It never gates CI: the number is a signal, the transcript is the
 * evidence.
 */
import { spawn } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const HERE = import.meta.dir
const FIXTURE = join(HERE, "fixtures", "hris")
const SERVER = resolve(HERE, "..", "..", "packages", "opencode", "src", "index.ts")

const PORT = Number(process.env.EVAL_PORT ?? 4097)
const PASSWORD = process.env.EVAL_SERVER_PASSWORD ?? "eval"
const META_MODEL = process.env.EVAL_META_MODEL ?? "opencode-go/glm-5.3-flash"
const INNER_MODEL = process.env.EVAL_INNER_MODEL ?? "opencode-go/deepseek-v4.1-flash"

const BASE = `http://127.0.0.1:${PORT}`
const AUTH = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1]! : fallback
}

function model(id: string) {
  const [providerID, ...rest] = id.split("/")
  return { providerID, modelID: rest.join("/") }
}

async function call<T = unknown>(method: string, path: string, body?: unknown, directory?: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...AUTH,
      ...(directory ? { "x-opencode-directory": directory } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const result = await call<{ healthy?: boolean }>("GET", "/global/health")
      if (result?.healthy) return
    } catch {
      // not up yet
    }
    await Bun.sleep(500)
  }
  throw new Error("server never became healthy")
}

type Message = { info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }

/** The meta-agent's last message, once it parses as a scorecard. */
async function scorecard(session: string): Promise<string | null> {
  const messages = await call<Message[]>("GET", `/session/${session}/message`, undefined, HERE)
  for (const message of [...messages].reverse()) {
    if (message.info?.role !== "assistant") continue
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
    const match = /\{[\s\S]*"scores"[\s\S]*\}/.exec(text)
    if (!match) continue
    try {
      JSON.parse(match[0])
      return match[0]
    } catch {
      // partial output; keep waiting
    }
  }
  return null
}

async function main(): Promise<void> {
  if (!process.env.MANUS_INTEGRATION) {
    console.log("set MANUS_INTEGRATION=1 to run the eval — it spends real model calls")
    return
  }

  const name = arg("case", "medium")
  const persona = arg("persona", "senior")

  const scratch = await mkdtemp(join(tmpdir(), "goal-loop-"))
  const workspace = join(scratch, "hris")
  await cp(FIXTURE, workspace, { recursive: true })

  const [caseFile, personas, rubric] = await Promise.all([
    readFile(join(HERE, "cases", `${name}.md`), "utf8"),
    readFile(join(HERE, "meta", "personas.md"), "utf8"),
    readFile(join(HERE, "meta", "rubric.md"), "utf8"),
  ])

  const server = spawn("bun", [SERVER, "serve", "--port", String(PORT)], {
    cwd: HERE,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_DB: join(scratch, "opencode.db"),
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      EVAL_SERVER_URL: BASE,
      EVAL_SERVER_PASSWORD: PASSWORD,
      EVAL_INNER_DIR: workspace,
      EVAL_INNER_MODEL: INNER_MODEL,
    },
  })

  try {
    await waitForHealth()

    const session = await call<{ id: string }>("POST", "/session", { agent: "meta", model: model(META_MODEL) }, HERE)

    const brief = [
      `## Persona\n\nPlay the **${persona}** persona.\n\n${personas}`,
      `## Case\n\n${caseFile}`,
      `## Rubric\n\n${rubric}`,
      `Open the inner session, send the task as your persona, and drive it to completion. Score it at the end.`,
    ].join("\n\n---\n\n")

    await call(
      "POST",
      `/session/${session.id}/message`,
      { agent: "meta", model: model(META_MODEL), parts: [{ type: "text", text: brief }] },
      HERE,
    )

    for (let i = 0; i < 1200; i++) {
      const result = await scorecard(session.id)
      if (result) {
        console.log(`\n=== scorecard (${name} × ${persona}) ===\n${result}\n`)
        return
      }
      await Bun.sleep(2000)
    }
    throw new Error("the meta-agent never returned a scorecard")
  } finally {
    server.kill()
    await rm(scratch, { recursive: true, force: true })
  }
}

await main()
