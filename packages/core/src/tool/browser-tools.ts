export * as BrowserTools from "./browser-tools"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { Browser } from "../browser/browser"
import { connectPage, currentUrl as readUrl, type Interface as Page } from "../browser/cdp-session"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// ADR-0003: the agent's side of the session browser is a curated named surface,
// never raw CDP. These names are the whole vocabulary, and CDP method names
// stay on this side of the boundary, out of the model's reach.
//
// Each tool attaches to the page first, because a browser-scope call cannot
// touch a document. Attaching per call keeps the tools independent of each
// other's ordering.

const SETTLE_MS = 250

export const NAMES = {
  navigate: "browser_navigate",
  read: "browser_read",
  click: "browser_click",
  type: "browser_type",
  screenshot: "browser_screenshot",
  back: "browser_back",
  forward: "browser_forward",
} as const

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, SETTLE_MS)))

/** Every tool returns one of these, so the model never sees a raw CDP error. */
const fail = (message: string) => new ToolFailure({ message })

const evaluate = (session: Page, expression: string) =>
  Effect.tryPromise({
    try: () => session.send("Runtime.evaluate", { expression, returnByValue: true }),
    catch: (error) => fail(`The page did not respond: ${String(error)}`),
  }).pipe(
    Effect.map((result) => (result as { result?: { value?: unknown } }).result?.value),
    Effect.flatMap((value) =>
      value === undefined ? Effect.fail(fail("The page returned no value")) : Effect.succeed(value),
    ),
  )

/** Read the page's own location, so a report is what the browser actually has. */
const currentUrl = (session: Page): Effect.Effect<string, ToolFailure> =>
  evaluate(session, "location.href").pipe(
    Effect.flatMap((value) => (typeof value === "string" ? Effect.succeed(value) : Effect.succeed(""))),
  )

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const browser = yield* Browser.Service

    const assertPermission = (
      action: string,
      resources: string[],
      context: Tool.Context,
    ): Effect.Effect<void, ToolFailure> =>
      permission
        .assert({
          action,
          resources,
          save: ["*"],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(Effect.mapError((error) => fail(`Not permitted to use ${action}: ${String(error)}`)))

    // Tool contract: expected failures become ToolFailure here, so nothing else
    // reaches the model-visible error shape.
    //
    // Page commands live on the page's own socket, so this connects one rather
    // than attaching through the browser socket. See cdp-session.ts.
    const openPage: Effect.Effect<Page, ToolFailure> = Effect.gen(function* () {
      yield* browser.ensure.pipe(
        Effect.mapError((error) => fail(`Unable to start the session browser: ${error.message}`)),
      )
      const endpoint = yield* browser.endpoint.pipe(Effect.mapError(() => fail("Unable to reach the session browser")))
      if (!endpoint) return yield* Effect.fail(fail("The session browser is not running"))
      return yield* Effect.tryPromise({
        try: () => connectPage(endpoint),
        catch: (error) => fail(`Unable to open a browser page: ${String(error)}`),
      })
    })

    /** Permission first, then the page. One boundary, one error type. */
    const interact = <A>(
      action: string,
      resources: string[],
      context: Tool.Context,
      body: (session: Page) => Effect.Effect<A, ToolFailure>,
    ): Effect.Effect<A, ToolFailure> =>
      Effect.gen(function* () {
        yield* assertPermission(action, resources, context)
        return yield* body(yield* openPage)
      })

    const register = (entries: Record<string, Tool.AnyTool>) => tools.register(entries).pipe(Effect.orDie)

    yield* register({
      [NAMES.navigate]: Tool.make({
        description:
          "Open a URL in the shared session browser. The human sees the same page, so this is how the agent shows them something. Accepts absolute http and https URLs.",
        input: Schema.Struct({
          url: Schema.String.annotate({ description: "Absolute http or https URL to open" }),
        }),
        output: Schema.Struct({ url: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text" as const, text: `Opened ${output.url}` }],
        execute: (input, context) =>
          interact(NAMES.navigate, [input.url], context, (session) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => session.send("Page.navigate", { url: input.url }),
                catch: (error) => fail(`Unable to open ${input.url}: ${String(error)}`),
              })
              yield* settle
              return { url: yield* currentUrl(session) }
            }),
          ),
      }),
    })

    yield* register({
      [NAMES.read]: Tool.make({
        description:
          "Read the current page as text. Returns the URL, the title, and the visible text, so the agent can see what the human is looking at.",
        input: Schema.Struct({}),
        output: Schema.Struct({ url: Schema.String, title: Schema.String, text: Schema.String }),
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: `URL: ${output.url}\nTitle: ${output.title}\n\n${output.text}` },
        ],
        execute: (_input, context) =>
          interact(NAMES.read, ["*"], context, (session) =>
            Effect.gen(function* () {
              const raw = yield* evaluate(
                session,
                "JSON.stringify({ url: location.href, title: document.title, text: document.body?.innerText ?? '' })",
              )
              if (typeof raw !== "string") return yield* Effect.fail(fail("The page returned nothing to read"))
              const parsed = JSON.parse(raw) as { url: string; title: string; text: string }
              return { url: parsed.url, title: parsed.title, text: parsed.text.slice(0, 20_000) }
            }),
          ),
      }),
    })

    yield* register({
      [NAMES.click]: Tool.make({
        description: "Click an element on the current page, addressed by CSS selector.",
        input: Schema.Struct({
          selector: Schema.String.annotate({ description: "CSS selector for the element to click" }),
        }),
        output: Schema.Struct({ url: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text" as const, text: `Clicked, now at ${output.url}` }],
        execute: (input, context) =>
          interact(NAMES.click, [input.selector], context, (session) =>
            Effect.gen(function* () {
              const clicked = yield* evaluate(
                session,
                `(() => { const el = document.querySelector(${JSON.stringify(input.selector)}); if (!el) return false; el.click(); return true })()`,
              )
              if (clicked !== true) return yield* Effect.fail(fail(`No element matched ${input.selector}`))
              yield* settle
              return { url: yield* currentUrl(session) }
            }),
          ),
      }),
    })

    yield* register({
      [NAMES.type]: Tool.make({
        description:
          "Type text into a field on the current page, addressed by CSS selector. Focuses the field and inserts the text.",
        input: Schema.Struct({
          selector: Schema.String.annotate({ description: "CSS selector for the input or textarea" }),
          text: Schema.String.annotate({ description: "Text to insert" }),
        }),
        output: Schema.Struct({ typed: Schema.Boolean }),
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: output.typed ? "Typed into the field" : "Nothing typed" },
        ],
        execute: (input, context) =>
          interact(NAMES.type, [input.selector], context, (session) =>
            Effect.gen(function* () {
              const typed = yield* evaluate(
                session,
                `(() => { const el = document.querySelector(${JSON.stringify(input.selector)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(input.text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
              )
              if (typed !== true) return yield* Effect.fail(fail(`No field matched ${input.selector}`))
              return { typed: true }
            }),
          ),
      }),
    })

    yield* register({
      [NAMES.screenshot]: Tool.make({
        description: "Capture the current page as a PNG, so the agent can see it as the human does.",
        input: Schema.Struct({}),
        output: Schema.Struct({ base64: Schema.String }),
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: `Screenshot captured, ${output.base64.length} characters of base64` },
        ],
        execute: (_input, context) =>
          interact(NAMES.screenshot, ["*"], context, (session) =>
            Effect.gen(function* () {
              const result = yield* Effect.tryPromise({
                try: () => session.send("Page.captureScreenshot", { format: "png" }),
                catch: (error) => fail(`Unable to capture the page: ${String(error)}`),
              })
              const data = (result as { data?: unknown }).data
              if (typeof data !== "string") return yield* Effect.fail(fail("The page returned no image"))
              return { base64: data }
            }),
          ),
      }),
    })

    const history = (direction: "back" | "forward") => () =>
      Effect.gen(function* () {
        const session = yield* openPage
        yield* Effect.tryPromise({
          try: () => session.send("Runtime.evaluate", { expression: `history.${direction}()`, returnByValue: true }),
          catch: (error) => fail(`Unable to go ${direction}: ${String(error)}`),
        })
        yield* settle
        return { url: yield* currentUrl(session) }
      })

    yield* register({
      [NAMES.back]: Tool.make({
        description: "Go back one page in the shared browser.",
        input: Schema.Struct({}),
        output: Schema.Struct({ url: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text" as const, text: `Went back to ${output.url}` }],
        execute: (_input, context) => interact(NAMES.back, ["*"], context, history("back")),
      }),
    })

    yield* register({
      [NAMES.forward]: Tool.make({
        description: "Go forward one page in the shared browser.",
        input: Schema.Struct({}),
        output: Schema.Struct({ url: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text" as const, text: `Went forward to ${output.url}` }],
        execute: (_input, context) => interact(NAMES.forward, ["*"], context, history("forward")),
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "tool/browser",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Browser.node],
})
