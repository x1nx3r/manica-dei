import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Goal } from "@/session/goal"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

// ADR-0010: the gate is wired at SessionTools.resolve, the one place every
// production tool executor is built. This drives the real resolve with a fake
// registry, a root session, and a goal row, so a missing call site or a wrong
// classification fails here rather than in a live run.

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

const info = (parentID?: SessionID) => ({ id: sessionID, parentID, permission: [] }) as unknown as Session.Info

const instance = {
  directory: "/workspace",
  worktree: "/workspace",
  project: {} as never,
}

const fakeMcp = () =>
  MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const ran: string[] = []

const tool = (id: string) =>
  ({
    id,
    description: id,
    parameters: Schema.Struct({ filePath: Schema.optional(Schema.String) }),
    jsonSchema: { type: "object", properties: { filePath: { type: "string" } } },
    execute: (_args: { filePath?: string }, _ctx: Tool.Context) =>
      Effect.sync(() => {
        ran.push(id)
        return { title: id, metadata: {}, output: "ok" }
      }),
  }) satisfies Tool.Def

const registry = ToolRegistry.Service.of({
  ids: () => Effect.succeed(["edit", "todowrite", "browser", "bash"]),
  all: () => Effect.succeed([]),
  named: () => Effect.die("unused"),
  tools: () => Effect.succeed(["edit", "todowrite", "browser", "bash"].map(tool)),
} as Partial<ToolRegistry.Interface> as ToolRegistry.Interface)

const layer = (goal?: { authorized: boolean }) =>
  Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(MCP.Service, fakeMcp()),
    Layer.succeed(Truncate.Service, fakeTruncate),
    Layer.succeed(ToolRegistry.Service, registry),
    Layer.succeed(
      Session.Service,
      Session.Service.of({
        get: () => Effect.succeed(info()),
      } as Partial<Session.Interface> as Session.Interface),
    ),
    Layer.succeed(
      Goal.Service,
      Goal.Service.of({
        get: () => Effect.succeed(goal),
      } as Partial<Goal.Interface> as Goal.Interface),
    ),
    RuntimeFlags.layer({ goalRequired: true }),
  )

const processor = {
  message: {
    id: messageID,
    sessionID,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: 1 },
  } satisfies SessionV1.Assistant,
  updateToolCall: () => Effect.die("unused"),
  completeToolCall: () => Effect.void,
} satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

const run = (goal: { authorized: boolean } | undefined, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: info(),
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools[name]?.execute
    if (!execute) throw new Error(`${name} is missing`)
    return yield* Effect.tryPromise({
      try: () =>
        execute(args, {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  }).pipe(Effect.provideService(InstanceRef, instance))

const unauthorized = testEffect(layer(undefined))
const signed = testEffect(layer({ authorized: true }))

unauthorized.effect("a write to an implementation file is refused before authorization", () =>
  Effect.gen(function* () {
    ran.length = 0
    const error = yield* run(undefined, "edit", { filePath: "/workspace/src/widget.ts" }).pipe(Effect.flip)
    expect(String(error)).toContain("docs/adr/")
    expect(ran).toEqual([])
  }),
)

unauthorized.effect("the ADR, the task list, the browser, and the shell follow the boundary", () =>
  Effect.gen(function* () {
    ran.length = 0
    yield* run(undefined, "edit", { filePath: "/workspace/docs/adr/0010.md" })
    // The shell and the browser are the explicit exceptions (ADR-0010).
    yield* run(undefined, "bash", { command: "git log --oneline -5" })
    yield* run(undefined, "browser", { action: "open" })
    // A task list is implementation.
    const error = yield* run(undefined, "todowrite", { todos: [] }).pipe(Effect.flip)
    expect(String(error)).toContain("task list is implementation")
    expect(ran).toEqual(["edit", "bash", "browser"])
  }),
)

signed.effect("an authorized goal unlocks implementation", () =>
  Effect.gen(function* () {
    ran.length = 0
    yield* run({ authorized: true }, "edit", { filePath: "/workspace/src/widget.ts" })
    yield* run({ authorized: true }, "todowrite", { todos: [] })
    expect(ran).toEqual(["edit", "todowrite"])
  }),
)
