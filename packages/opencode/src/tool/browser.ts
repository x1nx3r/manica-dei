import { Browser } from "@opencode-ai/core/browser"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"

// ADR-0005: the agent's half of the shared browser.
//
// The tool is a named surface over `agent-browser`, not a CDP client. It always
// attaches to the Chromium the session already runs -- the one the human is
// watching over RFB -- and never launches or owns a browser of its own. That is
// what keeps the two parties on one page, and it is also why there is no `close`
// action: closing must never reach the browser, only a connection we do not
// even hold here.
//
// One action enum rather than several tools, following `lsp`. agent-browser
// answers every command as JSON, so the result is parsed and the useful part is
// handed back rather than the whole envelope.

const BINARY = "agent-browser"
const DEFAULT_TIMEOUT_MS = 60_000

const ACTIONS = ["navigate", "snapshot", "click", "fill", "press", "scroll", "back", "screenshot", "evaluate"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "The action to perform. See the tool description for what each one does.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "For `navigate`, the URL to open.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description: "For `click` and `fill`, the element: an `@ref` from the last snapshot, or a CSS selector.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "For `fill`, the text to type. For `press`, the key to press. For `scroll`, the direction.",
  }),
  full: Schema.optional(Schema.Boolean).annotate({
    description: "For `snapshot`, return every node rather than only the interactive ones.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "For `snapshot`, scope the tree to this CSS selector.",
  }),
  script: Schema.optional(Schema.String).annotate({
    description: "For `evaluate`, the JavaScript expression to run in the page.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

// The command agent-browser runs, given our action. Each action maps to one
// command; the arguments are appended in `buildArgs`. Kept separate from the
// subprocess so the mapping is a pure function and testable without a browser.
export function commandFor(action: (typeof ACTIONS)[number]): string {
  switch (action) {
    case "navigate":
      return "open"
    case "back":
      return "back"
    case "scroll":
      return "scroll"
    case "screenshot":
      return "screenshot"
    case "evaluate":
      return "eval"
    default:
      return action
  }
}

/**
 * The arguments for one action, before the transport flags.
 *
 * Exported so the mapping from model intent to command line is unit-tested
 * directly, which is the part we own; agent-browser owns everything after it.
 */
export function buildArgs(params: Params): string[] {
  const args = [commandFor(params.action)]
  switch (params.action) {
    case "navigate":
      if (!params.url) throw new Error("`navigate` needs a url")
      args.push(params.url)
      break
    case "click":
      if (!params.target) throw new Error("`click` needs a target")
      args.push(params.target)
      break
    case "fill":
      if (!params.target) throw new Error("`fill` needs a target")
      if (params.text === undefined) throw new Error("`fill` needs text")
      args.push(params.target, params.text)
      break
    case "press":
      if (!params.text) throw new Error("`press` needs a key in text")
      args.push(params.text)
      break
    case "scroll":
      args.push(params.text ?? "down")
      break
    case "evaluate":
      if (!params.script) throw new Error("`evaluate` needs a script")
      args.push(params.script)
      break
    case "snapshot":
      if (!params.full) args.push("-i")
      if (params.selector) args.push("--selector", params.selector)
      break
    case "screenshot":
    case "back":
      break
  }
  return args
}

/**
 * The full argument vector: the attach flags, then the action's own arguments.
 *
 * Exported and pure so the transport is tested without a browser. The port is
 * passed as a bare number because agent-browser accepts a port or a full URL and
 * rejects `host:port`; a bare port resolves against loopback, which is where
 * Chromium binds, and passing it explicitly is what keeps this a pure attach.
 */
export function buildCommand(port: number, params: Params): string[] {
  return ["--cdp", String(port), "--json", ...buildArgs(params)]
}

/**
 * The part of agent-browser's JSON envelope worth showing the model.
 *
 * The command answers `{ success, data: {...}, error? }`. Returning the whole
 * envelope wastes context on a wrapper, so the `data` is unwrapped and the
 * shapes that matter are rendered as text: the snapshot as its tree, everything
 * else as compact JSON.
 */
export function renderResult(command: string, envelope: unknown): string {
  if (typeof envelope !== "object" || envelope === null) return String(envelope)
  const record = envelope as Record<string, unknown>
  if (record.success === false) {
    const error = typeof record.error === "string" ? record.error : JSON.stringify(record.error ?? record)
    throw new Error(error)
  }
  const data = record.data ?? record

  if (command === "snapshot") {
    if (typeof data === "string") return data
    const tree = (data as Record<string, unknown>)?.snapshot
    if (typeof tree === "string") return tree
  }
  if (typeof data === "string") return data
  return JSON.stringify(data, null, 2)
}

export const BrowserTool = Tool.define(
  "browser",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.action],
            always: [params.action],
            metadata: { action: params.action },
          })

          // The browser must be up before there is a port to attach to. `ensure`
          // is idempotent and verifies the display is answering, so this is also
          // the readiness check.
          const endpoint = yield* browser.ensure.pipe(
            Effect.flatMap(() => browser.endpoint),
            Effect.orDie,
          )
          if (!endpoint) throw new Error("the session browser is not running")

          const full = buildCommand(endpoint.port, params)
          const command = commandFor(params.action)

          const proc = ChildProcess.make(BINARY, full)
          const lines = yield* spawner.lines(proc).pipe(
            Effect.timeoutOrElse({
              duration: DEFAULT_TIMEOUT_MS,
              orElse: () => Effect.die(new Error(`${BINARY} ${command} timed out after ${DEFAULT_TIMEOUT_MS}ms`)),
            }),
            Effect.orDie,
          )

          const raw = lines.join("\n").trim()
          if (!raw) throw new Error(`${BINARY} ${command} produced no output`)

          // `--json` prints one object. A non-JSON line means the binary failed
          // before it could answer, so surface it rather than parse it as an
          // empty result.
          let envelope: unknown
          try {
            envelope = JSON.parse(raw)
          } catch {
            throw new Error(`${BINARY} ${command} did not answer with JSON: ${raw.slice(0, 500)}`)
          }

          const output = renderResult(command, envelope)
          return {
            title: `browser ${params.action}${params.target ? ` ${params.target}` : ""}`,
            output,
            metadata: { action: params.action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
