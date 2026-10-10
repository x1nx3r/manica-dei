import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GoalJudge as Judge } from "@opencode-ai/core/session/goal/judge"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { LLM } from "@/session/llm"
import { GoalJudge } from "@/session/goal-judge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// Fork ADR-0006, M3: the judge's effectful half. The prompt and parser are
// tested purely in `packages/core`; what this file proves is the one promise
// the service itself makes — a judge that errors fails open to `continue`, so a
// broken judge cannot end a run that was still working. The happy path is a
// real model call and belongs to the guarded integration (M6).

const agentInfo: Agent.Info = {
  name: "goal-judge",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "deny" }),
  options: {},
}

const model = {
  id: "judge",
  providerID: "test",
  name: "Judge",
  limit: { context: 1_000, output: 1_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: false,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/anthropic" },
  options: {},
} as Provider.Model

const it = testEffect(
  LayerNode.compile(GoalJudge.node, [
    [Agent.node, Layer.mock(Agent.Service, { get: () => Effect.succeed(agentInfo) })],
    [
      Provider.node,
      Layer.mock(Provider.Service, {
        getModel: () => Effect.succeed(model),
        getSmallModel: () => Effect.succeed(model),
      }),
    ],
    [LLM.node, Layer.mock(LLM.Service, { stream: () => Stream.die(new Error("the judge is unreachable")) })],
  ]),
)

describe("session.goal-judge", () => {
  it.effect("a judge that errors fails open to continue", () =>
    Effect.gen(function* () {
      const judge = yield* GoalJudge.Service

      const result = yield* judge.judge({
        sessionID: SessionID.make("ses_" + "a".repeat(64)),
        user: {} as never,
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("judge"),
        goal: "add the widget",
        lastResponse: "I added it.",
      })

      expect(result).toEqual(Judge.FAIL_OPEN)
      expect(result.verdict).toBe("continue")
    }),
  )
})
