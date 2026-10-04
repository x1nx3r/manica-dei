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
// what keeps the two parties on one page.
//
// What is deliberately absent matters as much as what is here. There is no
// `close` and no `tab close`, so nothing the agent can reach removes the browser
// or the human's tab. There is no `connect`, so the agent cannot point the tool
// at a different browser. There is no `cookies`, `storage`, `auth`, or
// `clipboard`, so it cannot read or write the human's session state. There is no
// `set` (viewport, geo, credentials) and no `network route`, so it cannot
// reconfigure or intercept the browser under the human. Those are refused by
// construction: they are not in the table below, so they cannot be named.
//
// One action enum rather than several tools, following `lsp`. agent-browser
// answers every command as JSON, so the result is parsed and the useful part is
// handed back rather than the whole envelope.

const BINARY = "agent-browser"
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Every action the agent may take.
 *
 * The strings are ours; `command` is agent-browser's. A nested command such as
 * `get text` or `keyboard type` is a two-word command, which is why `command` is
 * an array.
 *
 * `args` is typed against `RawParams`, the structural shape, rather than the
 * decoded `Params`. That breaks a cycle: the action list builds the schema, and
 * the schema would otherwise build the action list.
 */
type RawParams = {
  action: string
  url?: string
  target?: string
  text?: string
  what?: string
  selector?: string
  locator?: string
  into?: string
  full?: boolean
  script?: string
}

type Spec = {
  command: string[]
  args: (params: RawParams) => string[]
}

const need = (value: string | undefined, what: string): string => {
  if (!value) throw new Error(`this action needs ${what}`)
  return value
}

const SPECS = {
  // Navigating.
  navigate: { command: ["open"], args: (p) => [need(p.url, "a url")] },
  back: { command: ["back"], args: () => [] },
  forward: { command: ["forward"], args: () => [] },
  reload: { command: ["reload"], args: () => [] },
  pushstate: { command: ["pushstate"], args: (p) => [need(p.url, "a url")] },

  // Reading the page.
  snapshot: {
    command: ["snapshot"],
    args: (p) => [...(p.full ? [] : ["-i"]), ...(p.selector ? ["--selector", p.selector] : [])],
  },
  read: { command: ["read"], args: (p) => (p.url ? [p.url] : []) },
  get: { command: ["get"], args: (p) => [need(p.what, "what to get"), ...(p.target ? [p.target] : [])] },
  is: { command: ["is"], args: (p) => [need(p.what, "what to check"), need(p.target, "a target")] },
  find: {
    command: ["find"],
    args: (p) => [need(p.locator, "a locator"), need(p.text, "a value"), need(p.what, "an action")],
  },
  console: { command: ["console"], args: () => [] },
  errors: { command: ["errors"], args: () => [] },
  network: { command: ["network", "requests"], args: () => [] },
  vitals: { command: ["vitals"], args: (p) => (p.url ? [p.url] : []) },
  diff: { command: ["diff", "snapshot"], args: () => [] },

  // Acting on the page.
  click: { command: ["click"], args: (p) => [need(p.target, "a target")] },
  dblclick: { command: ["dblclick"], args: (p) => [need(p.target, "a target")] },
  hover: { command: ["hover"], args: (p) => [need(p.target, "a target")] },
  focus: { command: ["focus"], args: (p) => [need(p.target, "a target")] },
  check: { command: ["check"], args: (p) => [need(p.target, "a target")] },
  uncheck: { command: ["uncheck"], args: (p) => [need(p.target, "a target")] },
  select: { command: ["select"], args: (p) => [need(p.target, "a target"), need(p.text, "a value")] },
  fill: { command: ["fill"], args: (p) => [need(p.target, "a target"), need(p.text, "text")] },
  type: { command: ["type"], args: (p) => [need(p.target, "a target"), need(p.text, "text")] },
  press: { command: ["press"], args: (p) => [need(p.text, "a key")] },
  keyboard: { command: ["keyboard", "type"], args: (p) => [need(p.text, "text")] },
  scroll: { command: ["scroll"], args: (p) => [p.text ?? "down"] },
  scrollintoview: { command: ["scrollintoview"], args: (p) => [need(p.target, "a target")] },
  drag: { command: ["drag"], args: (p) => [need(p.target, "a source"), need(p.into, "a destination")] },
  upload: { command: ["upload"], args: (p) => [need(p.target, "a target"), ...need(p.text, "a file path").split(",")] },
  download: { command: ["download"], args: (p) => [need(p.target, "a target"), need(p.text, "a path")] },

  // Waiting. The command takes a positional argument and auto-detects: a number
  // is a timeout in milliseconds, anything else is a selector.
  wait: { command: ["wait"], args: (p) => [need(p.target, "a selector")] },
  waitms: { command: ["wait"], args: (p) => [need(p.text, "a number of milliseconds")] },

  // Tabs. No `close`: the human's tab is not ours to remove.
  tabnew: { command: ["tab", "new"], args: (p) => (p.url ? [p.url] : []) },
  tablist: { command: ["tab", "list"], args: () => [] },
  tabselect: { command: ["tab", "select"], args: (p) => [need(p.target, "a tab id or index")] },

  // Capturing.
  screenshot: { command: ["screenshot"], args: (p) => (p.full ? ["--full"] : []) },
  pdf: { command: ["pdf"], args: (p) => [need(p.text, "an output path")] },
  highlight: { command: ["highlight"], args: (p) => [need(p.target, "a target")] },
  inspect: { command: ["inspect"], args: () => [] },

  // JavaScript.
  evaluate: { command: ["eval"], args: (p) => [need(p.script, "a script")] },
} satisfies Record<string, Spec>

export const ACTIONS = Object.keys(SPECS) as [keyof typeof SPECS, ...(keyof typeof SPECS)[]]

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "The action to perform. See the tool description for what each one does.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "For `navigate`, `read`, `tabnew`, `pushstate`, or `vitals`, the URL.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description:
      "For actions on an element, the element: an `@ref` from the last snapshot, or a CSS selector. For `drag`, the source. For `tabselect`, a tab id or index.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description:
      "For `fill` and `type`, the text. For `press`, the key. For `scroll`, the direction. For `select`, the option. For `upload`, a file path. For `download`, a path. For `waitms`, milliseconds.",
  }),
  what: Schema.optional(Schema.String).annotate({
    description:
      "For `get`, what to read: text, html, value, title, url, count, box, or attr <name>. For `is`, what to test: visible, enabled, or checked.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "For `snapshot`, scope the tree to this CSS selector.",
  }),
  locator: Schema.optional(Schema.String).annotate({
    description: "For `find`, how to locate: role, text, label, placeholder, alt, title, testid, first, last, or nth.",
  }),
  into: Schema.optional(Schema.String).annotate({
    description: "For `drag`, the destination element.",
  }),
  full: Schema.optional(Schema.Boolean).annotate({
    description: "For `snapshot`, every node rather than only interactive ones. For `screenshot`, the whole page.",
  }),
  script: Schema.optional(Schema.String).annotate({
    description: "For `evaluate`, the JavaScript expression to run in the page.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

export function commandFor(action: keyof typeof SPECS): string[] {
  return SPECS[action].command
}

/**
 * The arguments for one action, before the transport flags.
 *
 * The mapping from model intent to command line is the part we own, so it is
 * pure and tested directly; agent-browser owns everything after it.
 */
export function buildArgs(params: Params): string[] {
  return [...SPECS[params.action].command, ...SPECS[params.action].args(params)]
}

/**
 * The full argument vector: the attach flags, then the action's own arguments.
 *
 * The port is passed as a bare number because agent-browser accepts a port or a
 * full URL and rejects `host:port`; a bare port resolves against loopback, which
 * is where Chromium binds. Passing it explicitly is what keeps this a pure
 * attach.
 */
export function buildCommand(port: number, params: Params): string[] {
  return ["--cdp", String(port), "--json", ...buildArgs(params)]
}

/**
 * The part of agent-browser's JSON envelope worth showing the model.
 *
 * The command answers `{ success, data: {...}, error? }`. The `data` is unwrapped
 * so no context is spent on the wrapper, and the shapes that read as text --
 * a snapshot's tree, a console's lines -- are returned as text rather than JSON.
 */
export function renderResult(command: string[], envelope: unknown): string {
  if (typeof envelope !== "object" || envelope === null) return String(envelope)
  const record = envelope as Record<string, unknown>
  if (record.success === false) {
    const error = typeof record.error === "string" ? record.error : JSON.stringify(record.error ?? record)
    throw new Error(error)
  }
  const data = record.data ?? record

  if (command[0] === "snapshot") {
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
          const proc = ChildProcess.make(BINARY, full)
          const lines = yield* spawner.lines(proc).pipe(
            Effect.timeoutOrElse({
              duration: DEFAULT_TIMEOUT_MS,
              orElse: () => Effect.die(new Error(`${BINARY} ${params.action} timed out after ${DEFAULT_TIMEOUT_MS}ms`)),
            }),
            Effect.orDie,
          )

          const raw = lines.join("\n").trim()
          if (!raw) throw new Error(`${BINARY} ${params.action} produced no output`)

          // `--json` prints one object. A non-JSON line means the binary failed
          // before it could answer, so surface it rather than parse it as an
          // empty result.
          let envelope: unknown
          try {
            envelope = JSON.parse(raw)
          } catch {
            throw new Error(`${BINARY} ${params.action} did not answer with JSON: ${raw.slice(0, 500)}`)
          }

          return {
            title: `browser ${params.action}${params.target ? ` ${params.target}` : ""}`,
            output: renderResult(commandFor(params.action), envelope),
            metadata: { action: params.action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
