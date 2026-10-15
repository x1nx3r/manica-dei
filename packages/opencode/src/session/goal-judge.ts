import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { GoalJudge as Judge } from "@opencode-ai/core/session/goal/judge"
import type { SessionGoal } from "@opencode-ai/schema/session-goal"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"
import { LLM } from "./llm"
import { Session } from "./session"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID, PartID } from "./schema"

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
  /** The round being weighed: `turns_used + 1`, the same round the verdict binds to. */
  readonly round: number
  readonly contract?: SessionGoal.Contract
  readonly assumptions?: string
  /** QA's record, the pass the judge weighs (ADR-0006, "the record"). */
  readonly record?: SessionGoal.Record
  /** What the gates produced, captured by the loop — not the agent's summary. */
  readonly evidence?: ReadonlyArray<Judge.GateEvidence>
}

export interface JudgeResult {
  readonly judgement: Judge.Judgement
  /**
   * The judge's own session, when one was created. The loop publishes it on the
   * verdict event so a client can link the ruling to its transcript (ADR-0008,
   * "the seam"). Absent only when the call never reached a session.
   */
  readonly roleSessionID?: SessionID
  /**
   * Why the judgement is a fail-open fallback rather than a verdict the model
   * returned: the reply could not be parsed (`parse`) or the call did not
   * answer (`transport`). The loop counts these to trip its circuit breaker.
   */
  readonly failure?: "parse" | "transport"
}

export interface Interface {
  readonly judge: (input: JudgeInput) => Effect.Effect<JudgeResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalJudge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const sessions = yield* Session.Service

    const judge = Effect.fn("GoalJudge.judge")(function* (input: JudgeInput) {
      // Fail-open: a judge that errors or cannot be read must not end a run
      // that was still working. The loop counts consecutive failures (M4).
      return yield* Effect.gen(function* () {
        const agent = yield* agents.get("goal-judge")
        const model = agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : ((yield* provider.getSmallModel(input.providerID)) ??
            (yield* provider.getModel(input.providerID, input.modelID)))

        // Fork ADR-0008: the judge runs as a session — parented to the session
        // under test, running the hidden `goal-judge` agent. Its prompt is its
        // user message, its reply is its assistant message, and the usage the
        // call reports is written back to its own row, so the role's spend is
        // attributable (ADR-0008, "role-attributed spend").
        const ctx = yield* InstanceState.context
        const bench = yield* sessions.create({
          parentID: input.sessionID,
          title: "Judge the goal",
          agent: agent.name,
          // The run's roles are labeled on their own sessions (ADR-0008, "the
          // round"), so a client that arrives late reads this off
          // `/session/:id/children`, from an event it never saw.
          metadata: { goal_role: "judge", goal_round: input.round },
        })
        const prompt = Judge.buildJudgePrompt(input)
        const user: SessionV1.User = {
          id: MessageID.ascending(),
          sessionID: bench.id,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
        }
        yield* sessions.updateMessage(user)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: bench.id,
          type: "text",
          text: prompt,
        })

        const events = Array.from(
          yield* llm
            .stream({
              agent,
              user: input.user,
              system: [],
              small: true,
              tools: {},
              model,
              sessionID: bench.id,
              retries: 2,
              messages: [{ role: "user", content: prompt }],
            })
            .pipe(Stream.runCollect, Effect.orDie),
        )
        const text = events
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join("")
        const judgement = Judge.parseVerdict(text)

        // The reply is a real message on the judge's session: the text it
        // returned, the usage the call reported, and the typed verdict a
        // surface renders in place of parsing the reply.
        const finished = events.findLast(LLMEvent.is.stepFinish) ?? events.findLast(LLMEvent.is.finish)
        const usage = finished?.usage
          ? Session.getUsage({ model, usage: finished.usage, metadata: finished.providerMetadata })
          : undefined
        const assistant: SessionV1.Assistant = {
          id: MessageID.ascending(),
          sessionID: bench.id,
          role: "assistant",
          parentID: user.id,
          modelID: model.id,
          providerID: model.providerID,
          mode: agent.mode,
          agent: agent.name,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: usage?.cost ?? 0,
          tokens: usage?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() },
          ...(finished ? { finish: finished.reason } : {}),
        }
        yield* sessions.updateMessage(assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: bench.id,
          type: "text",
          text,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: bench.id,
          type: "goal.verdict",
          round: input.round,
          verdict: judgement.verdict,
          reason: judgement.reason,
          ...(judgement.handoff ? { handoff: judgement.handoff } : {}),
        } satisfies SessionV1.GoalVerdictPart)
        // The step-finish part is what the projector reads to place the spend on
        // the session's own row; without it the call would be billed to nothing.
        if (usage) {
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: bench.id,
            type: "step-finish",
            reason: finished?.reason ?? "stop",
            cost: usage.cost,
            tokens: usage.tokens,
          } satisfies SessionV1.StepFinishPart)
        }

        return { judgement, roleSessionID: bench.id }
      }).pipe(
        Effect.map(({ judgement, roleSessionID }): JudgeResult => ({
          judgement,
          roleSessionID,
          ...(judgement === Judge.FAIL_OPEN ? { failure: "parse" as const } : {}),
        })),
        // A call that did not answer is a transport failure; the loop counts
        // consecutive ones so a misconfigured judge cannot burn the budget.
        Effect.catchCause(() => Effect.succeed({ judgement: Judge.FAIL_OPEN, failure: "transport" as const })),
      )
    })

    return Service.of({ judge })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Provider.node, LLM.node, Session.node],
})

export * as GoalJudge from "./goal-judge"
