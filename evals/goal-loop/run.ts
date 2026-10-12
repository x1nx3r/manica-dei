/**
 * M7 runner — the meta-agent eval.
 *
 *   MANUS_INTEGRATION=1 bun evals/goal-loop/run.ts --case medium --persona senior
 *
 * Two servers, two sessions. The **meta** server (this directory) hosts the
 * simulator/grader with the `drive` tool; the **inner** server (a scratch copy
 * of the fixture) hosts the session under test, carrying the persona's
 * identity so the goal loop's stance reaches the agent.
 *
 * It never gates CI: the number is a signal, the transcript is the evidence.
 */
import { spawn } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { watch } from "./watch"

const HERE = import.meta.dir
const FIXTURE = join(HERE, "fixtures", "hris")
const SERVER = resolve(HERE, "..", "..", "packages", "opencode", "src", "index.ts")

const META_PORT = Number(process.env.EVAL_META_PORT ?? 4097)
const INNER_PORT = Number(process.env.EVAL_INNER_PORT ?? 4098)
const PASSWORD = process.env.EVAL_SERVER_PASSWORD ?? "eval"
const META_MODEL = process.env.EVAL_META_MODEL ?? "opencode-go/glm-5.3-flash"
const INNER_MODEL = process.env.EVAL_INNER_MODEL ?? "opencode-go/deepseek-v4.1-flash"

const META_BASE = `http://127.0.0.1:${META_PORT}`
const INNER_BASE = `http://127.0.0.1:${INNER_PORT}`
const AUTH = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }

/** The people behind the personas. The inner agent is summoned to work with one. */
const PEOPLE: Record<string, { name: string; github: string; role: string }> = {
  senior: { name: "Rina", github: "rina", role: "tech lead" },
  intern: { name: "Tomo", github: "tomo", role: "engineering intern" },
  hr: { name: "Sari", github: "sari", role: "HR manager" },
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1]! : fallback
}

function model(id: string) {
  const [providerID, ...rest] = id.split("/")
  return { providerID, modelID: rest.join("/") }
}

async function call<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  directory?: string,
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...AUTH,
      ...(directory ? { "x-opencode-directory": directory } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

async function waitForHealth(base: string, label: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const result = await call<{ healthy?: boolean }>(base, "GET", "/global/health")
      if (result?.healthy) return
    } catch {
      // not up yet
    }
    await Bun.sleep(500)
  }
  throw new Error(`${label} server never became healthy`)
}

type Message = { info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }

/** The meta-agent's final message, once it parses as a scorecard. */
async function scorecard(session: string): Promise<string | null> {
  const messages = await call<Message[]>(META_BASE, "GET", `/session/${session}/message`, undefined, HERE)
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
  const person = PEOPLE[persona] ?? PEOPLE.senior!

  const scratch = await mkdtemp(join(tmpdir(), "goal-loop-"))
  const workspace = join(scratch, "hris")
  await cp(FIXTURE, workspace, { recursive: true })

  const [caseFile, personas, rubric] = await Promise.all([
    readFile(join(HERE, "cases", `${name}.md`), "utf8"),
    readFile(join(HERE, "meta", "personas.md"), "utf8"),
    readFile(join(HERE, "meta", "rubric.md"), "utf8"),
  ])

  // The meta server: this directory, so the `meta` agent and the `drive` tool load.
  const meta = spawn("bun", [SERVER, "serve", "--port", String(META_PORT)], {
    cwd: HERE,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_DB: join(scratch, "meta.db"),
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      EVAL_SERVER_URL: INNER_BASE,
      EVAL_SERVER_PASSWORD: PASSWORD,
      EVAL_INNER_DIR: workspace,
      EVAL_INNER_MODEL: INNER_MODEL,
    },
  })

  // The inner server: the fixture copy, summoned for the persona.
  const target = spawn("bun", [SERVER, "serve", "--port", String(INNER_PORT)], {
    cwd: workspace,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_DB: join(scratch, "inner.db"),
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      MANUS_USER_NAME: person.name,
      MANUS_USER_GITHUB: person.github,
      MANUS_USER_ROLE: person.role,
    },
  })

  let watcher: { stop(): void } | null = null

  try {
    await Promise.all([waitForHealth(META_BASE, "meta"), waitForHealth(INNER_BASE, "inner")])
    console.log(`\nmeta on ${META_BASE}; inner on ${INNER_BASE} (${person.name}, ${person.role})\n`)

    watcher = watch({
      headers: { "content-type": "application/json", ...AUTH },
      targets: [
        { label: "meta", base: META_BASE, directory: HERE },
        { label: "hris", base: INNER_BASE, directory: workspace },
      ],
    })

    const session = await call<{ id: string }>(META_BASE, "POST", "/session", { agent: "meta" }, HERE)
    console.log(`meta session ${session.id}; briefed`)

    const brief = [
      `## Persona\n\nPlay the **${persona}** persona — ${person.name}, ${person.role}.\n\n${personas}`,
      `## Case\n\n${caseFile}`,
      `## Rubric\n\n${rubric}`,
      `Open the inner session, send the task as your persona, and drive it to completion. Score it at the end.`,
    ].join("\n\n---\n\n")

    await call(
      META_BASE,
      "POST",
      `/session/${session.id}/prompt_async`,
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
    watcher?.stop()
    meta.kill()
    target.kill()
    await Bun.sleep(1000)

    // Keep the evidence: the workspace the agent left behind, and both databases.
    const kept = join(HERE, "runs", `${name}-${persona}`)
    await rm(kept, { recursive: true, force: true })
    await cp(scratch, kept, { recursive: true })
    console.log(`\nrun kept in ${kept}\n`)

    await rm(scratch, { recursive: true, force: true })
  }
}

await main()
