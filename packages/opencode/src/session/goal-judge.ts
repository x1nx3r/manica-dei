import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { GoalJudge as Judge } from "@opencode-ai/core/session/goal/judge"
import type { SessionGoal } from "@opencode-ai/schema/session-goal"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import { LLM } from "./llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionID } from "./schema"

// Fork ADR-0006, M3: the judge's effectful half. The prompt and the parser are
// pure and live in `@opencode-ai/core/session/goal/judge`; this is the one model
// call between them.
//
// The agent is hidden and tool-less, on a dedicated model — not the session's
// own — because the failure this loop exists to catch is the agent that is
// confidently wrong about its own work.

export interface JudgeInput {
  readonly sessionID: SessionID
  readonly user: SessionV1.User
  readonly providerID: ProviderV2.ID
  readonly modelID: ModelV2.ID
  readonly goal: string
  readonly contract?: SessionGoal.Contract
  readonly assumptions?: string
  readonly lastResponse: string
}

export interface Interface {
  readonly judge: (input: JudgeInput) => Effect.Effect<Judge.Judgement>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalJudge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    const judge = Effect.fn("GoalJudge.judge")(function* (input: JudgeInput) {
      // Fail-open: a judge that errors or cannot be read must not end a run
      // that was still working. The loop counts consecutive failures (M4).
      return yield* Effect.gen(function* () {
        const agent = yield* agents.get("goal-judge")
        const model = agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : ((yield* provider.getSmallModel(input.providerID)) ??
            (yield* provider.getModel(input.providerID, input.modelID)))

        const text = yield* llm
          .stream({
            agent,
            user: input.user,
            system: [],
            small: true,
            tools: {},
            model,
            sessionID: input.sessionID,
            retries: 2,
            messages: [{ role: "user", content: Judge.buildJudgePrompt(input) }],
          })
          .pipe(Stream.filter(LLMEvent.is.textDelta), Stream.map((event) => event.text), Stream.mkString, Effect.orDie)

        return Judge.parseVerdict(text)
      }).pipe(Effect.catchCause(() => Effect.succeed(Judge.FAIL_OPEN)))
    })

    return Service.of({ judge })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Agent.node, Provider.node, LLM.node] })

export * as GoalJudge from "./goal-judge"
