import { describe, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "../../src/question"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect, Layer } from "effect"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/session/goal"
import { GoalGate } from "@/session/goal-gate"
import { GoalJudge } from "@/session/goal-judge"
import { GoalLoop } from "@/session/goal-loop"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

// Fork ADR-0006, M6: one real run of the loop, end to end, against the test
// LLM server. Deterministic and self-contained — no Xvnc, no credentials, no
// network — so it runs in CI rather than behind a guard. The live model run is
// a separate, guarded exercise.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in goal-loop tests"),
    authenticate: () => Effect.die("unexpected MCP auth in goal-loop tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in goal-loop tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  GoalLoop.node,
  Goal.node,
  GoalGate.node,
  GoalJudge.node,
])

const it = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
  ]),
)

// A custom "test" provider whose baseURL is the test LLM server.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const useServerConfig = Effect.fn("test.useServerConfig")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const config = {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: llm.url } },
    },
  } satisfies Partial<ConfigV1.Info>
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
  return { llm }
})

/** The judge's call is the one whose body carries the judge system prompt. */
const isJudge = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("strict judge")

const contract = {
  outcome: "the widget renders",
  verification: "true",
  constraints: "nothing else changes",
  boundaries: "packages/widget",
  stop_when: "the spec is ambiguous",
}

const gate = {
  command: "true",
  timeout_seconds: 30,
  max_retries: 3,
  attempts: 0,
  last_exit_code: null,
  last_output_tail: "",
}

describe("goal-loop end to end (mock model)", () => {
  it.instance("a goal runs to done", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goal = yield* Goal.Service
      const session = yield* sessions.create({
        title: "Goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* goal.set({ sessionID: session.id, goal: "add the widget", contract, gates: [gate] })
      yield* goal.authorize(session.id)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "add the widget" }],
      })

      // The agent's work turn, then the judge's verdict.
      yield* llm.text("I added the widget and ran the tests.")
      yield* llm.textMatch(isJudge, '{"verdict":"done","reason":"the tests pass"}')

      yield* prompt.loop({ sessionID: session.id })

      const stored = yield* goal.get(session.id)
      expect(stored?.status).toBe("done")
      expect(stored?.last_verdict).toBe("done")
      // The judge ran once, after the agent's turn.
      expect(yield* llm.hits).toHaveLength(2)
    }),
  )

  it.instance("a continue verdict runs another turn, then done stops", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goal = yield* Goal.Service
      const session = yield* sessions.create({
        title: "Goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* goal.set({ sessionID: session.id, goal: "add the widget", contract, gates: [gate], turnBudget: 10 })
      yield* goal.authorize(session.id)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "add the widget" }],
      })

      yield* llm.text("first attempt")
      yield* llm.textMatch(isJudge, '{"verdict":"continue","reason":"the tests are not written"}')
      yield* llm.text("second attempt, with tests")
      yield* llm.textMatch(isJudge, '{"verdict":"done","reason":"the tests pass"}')

      yield* prompt.loop({ sessionID: session.id })

      const stored = yield* goal.get(session.id)
      expect(stored?.status).toBe("done")
      expect(stored?.turns_used).toBe(2)
    }),
  )

  it.instance("a blocked verdict stops the loop as blocked, not done", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goal = yield* Goal.Service
      const session = yield* sessions.create({
        title: "Goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* goal.set({ sessionID: session.id, goal: "add the widget", contract, gates: [gate] })
      yield* goal.authorize(session.id)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "add the widget" }],
      })

      yield* llm.text("I cannot: the API key is missing.")
      yield* llm.textMatch(isJudge, '{"verdict":"blocked","reason":"needs an API key"}')

      yield* prompt.loop({ sessionID: session.id })

      const stored = yield* goal.get(session.id)
      expect(stored?.status).toBe("blocked")
      expect(stored?.last_verdict).toBe("blocked")
    }),
  )
})
