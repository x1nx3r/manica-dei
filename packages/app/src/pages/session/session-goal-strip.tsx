import type { SessionGoalContract, SessionGoalGate, SessionGoalInfo } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Show, createMemo, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { goalConclusion, type GoalVerdict, type SessionGoalRuling } from "@/pages/session/session-goal"

/** The loop's numbers cross the wire as plain numbers; a stray non-number reads as none. */
const num = (value: unknown, fallback = 0) => (Number.isFinite(value) ? Number(value) : fallback)

/**
 * Fork ADR-0008: the goal loop's surface in the session view, in one strip.
 *
 * Collapsed it is the phase chip — which role is acting, the round, the turn
 * against the budget. Expanded it is the goal panel: the contract, the gate, and
 * the run read from the end — the judgement and the judge's three-part handoff,
 * with the judge's own session to open.
 *
 * It sits between the timeline and the composer, outside the timeline's scroller,
 * so showing it cannot move a row. It renders only for a session with a goal.
 */
export function SessionGoalStrip(props: {
  goal: SessionGoalInfo
  ruling: SessionGoalRuling | undefined
  collapsed: boolean
  onToggle: () => void
  centered: boolean
  onOpenRoleSession: (sessionID: string) => void
}) {
  const language = useLanguage()
  const settings = useSettings()
  const v2 = () => settings.general.newLayoutDesigns()

  const turns = createMemo(() => num(props.goal.turns_used))
  const budget = createMemo(() => num(props.goal.turn_budget))
  const round = createMemo(() => turns() + 1)

  const phaseLabel = createMemo(() => {
    switch (props.goal.phase) {
      case "qa":
        return language.t("session.goal.phase.qa")
      case "judge":
        return language.t("session.goal.phase.judge")
      default:
        return language.t("session.goal.phase.dev")
    }
  })

  const statusLabel = createMemo(() => {
    switch (props.goal.status) {
      case "done":
        return language.t("session.goal.status.done")
      case "blocked":
        return language.t("session.goal.status.blocked")
      default:
        return language.t("session.goal.status.active")
    }
  })

  const verdictLabel = (verdict: GoalVerdict) => {
    switch (verdict) {
      case "done":
        return language.t("ui.messagePart.goal.verdict.done")
      case "blocked":
        return language.t("ui.messagePart.goal.verdict.blocked")
      case "wait":
        return language.t("ui.messagePart.goal.verdict.wait")
      default:
        return language.t("ui.messagePart.goal.verdict.continue")
    }
  }

  /**
   * How the run ended, from either source: the ruling the trail delivered, or —
   * for a client that arrived after the fact — the verdict the projection holds.
   * The second carries no handoff and no judge session, because the projection
   * has neither.
   */
  const conclusion = createMemo(() => goalConclusion(props.goal, props.ruling))
  const gate = createMemo<SessionGoalGate | undefined>(() => props.goal.gates[0])
  const exit = createMemo(() => {
    const value = gate()?.last_exit_code
    return Number.isFinite(value) ? Number(value) : undefined
  })

  /**
   * Copy is read inside the JSX through accessors, never assembled here: a label
   * resolved in a plain function would not re-read when the locale changes.
   */
  const field = (label: Accessor<string>, value: Accessor<string>) => ({ label, value })

  const Fields = (fields: { label: Accessor<string>; value: Accessor<string> }) => (
    <div data-slot="session-goal-field" class="flex flex-col gap-0.5">
      <span class={labelClass()} data-slot="session-goal-field-label">
        {fields.label()}
      </span>
      <span class={`${valueClass()} whitespace-pre-wrap break-words`}>{fields.value()}</span>
    </div>
  )

  const contractFields = (contract: Accessor<SessionGoalContract>) => [
    field(
      () => language.t("session.goal.contract.outcome"),
      () => contract().outcome,
    ),
    field(
      () => language.t("session.goal.contract.verification"),
      () => contract().verification,
    ),
    field(
      () => language.t("session.goal.contract.constraints"),
      () => contract().constraints,
    ),
    field(
      () => language.t("session.goal.contract.boundaries"),
      () => contract().boundaries,
    ),
    field(
      () => language.t("session.goal.contract.stopWhen"),
      () => contract().stop_when,
    ),
  ]

  const handoffFields = (handoff: Accessor<NonNullable<SessionGoalRuling["handoff"]>>) => [
    field(
      () => language.t("ui.messagePart.goal.verdict.handoff.tested"),
      () => handoff().tested,
    ),
    field(
      () => language.t("ui.messagePart.goal.verdict.handoff.implementation"),
      () => handoff().implementation,
    ),
    field(
      () => language.t("ui.messagePart.goal.verdict.handoff.cause"),
      () => handoff().cause,
    ),
  ]

  const sectionClass = () =>
    v2()
      ? "text-[11px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-faint uppercase"
      : "text-12-medium text-text-weak uppercase"
  const labelClass = () => (v2() ? "text-v2-text-text-faint" : "text-text-weak")
  const valueClass = () => (v2() ? "text-v2-text-text-base" : "text-text-strong")
  const metaClass = () =>
    v2()
      ? "text-[11px] font-[440] leading-4 tracking-[-0.04px] text-v2-text-text-faint"
      : "text-12-regular text-text-weak"

  return (
    <div
      data-component="session-goal-strip"
      role="group"
      aria-label={language.t("session.goal.label")}
      class="w-full shrink-0 px-3 pb-2 pointer-events-none"
    >
      <div
        classList={{
          "w-full pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <div
          data-slot="session-goal-card"
          classList={{
            "overflow-hidden": true,
            "rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-01": v2(),
            "rounded-md border border-border-weak-base bg-background-base": !v2(),
          }}
        >
          <div
            data-action="session-goal-toggle"
            data-collapsed={props.collapsed ? "true" : "false"}
            role="button"
            tabIndex={0}
            classList={{
              "flex items-center gap-2 px-3 cursor-default": true,
              "h-[34px]": v2(),
              "h-[32px]": !v2(),
            }}
            onClick={props.onToggle}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              props.onToggle()
            }}
          >
            <span
              data-slot="session-goal-phase"
              data-phase={props.goal.phase}
              data-status={props.goal.status}
              classList={{
                "shrink-0 rounded-md px-1.5": true,
                "bg-v2-background-bg-layer-02 text-[11px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-muted":
                  v2(),
                "border border-border-weak-base text-12-medium text-text-weak": !v2(),
              }}
            >
              {phaseLabel()}
            </span>
            <span
              data-slot="session-goal-text"
              classList={{
                "min-w-0 flex-1 truncate": true,
                "text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base": v2(),
                "text-12-regular text-text-strong": !v2(),
              }}
            >
              {props.goal.goal}
            </span>
            <Show when={props.goal.status !== "active"}>
              <span data-slot="session-goal-status" data-status={props.goal.status} class={`shrink-0 ${metaClass()}`}>
                {statusLabel()}
              </span>
            </Show>
            <span data-slot="session-goal-round" class={`shrink-0 ${metaClass()}`}>
              {language.t("session.goal.round", { round: round() })}
            </span>
            <span data-slot="session-goal-turns" class={`shrink-0 ${metaClass()}`}>
              {language.t("session.goal.turns", { used: turns(), budget: budget() })}
            </span>
            <IconButton
              data-action="session-goal-toggle-button"
              icon="chevron-down"
              size="normal"
              variant="ghost"
              style={{ transform: `rotate(${props.collapsed ? 0 : 180}deg)` }}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                props.onToggle()
              }}
              aria-label={props.collapsed ? language.t("session.goal.expand") : language.t("session.goal.collapse")}
            />
          </div>

          <Show when={!props.collapsed}>
            <div
              data-slot="session-goal-body"
              class={
                v2() ? "px-3 pb-3 flex flex-col gap-3 text-[12px]" : "px-3 pb-3 flex flex-col gap-3 text-12-regular"
              }
            >
              <Show when={!props.goal.authorized}>
                <div data-slot="session-goal-unauthorized" class={labelClass()}>
                  {language.t("session.goal.unauthorized")}
                </div>
              </Show>

              <Show when={props.goal.contract}>
                {(contract) => (
                  <section data-slot="session-goal-contract" class="flex flex-col gap-2">
                    <h3 class={sectionClass()}>{language.t("session.goal.contract")}</h3>
                    {contractFields(contract).map((item) => Fields(item))}
                  </section>
                )}
              </Show>

              <Show when={gate()}>
                {(value) => (
                  <section data-slot="session-goal-gate" class="flex flex-col gap-1">
                    <h3 class={sectionClass()}>{language.t("session.goal.gate")}</h3>
                    <code data-slot="session-goal-gate-command" class={`${valueClass()} break-all`}>
                      {value().command}
                    </code>
                    <div class="flex items-center gap-3">
                      <span class={labelClass()} data-slot="session-goal-gate-attempts">
                        {language.t("session.goal.gate.attempts")}{" "}
                        <span class={valueClass()}>{num(value().attempts)}</span>
                      </span>
                      <span class={labelClass()} data-slot="session-goal-gate-exit">
                        {language.t("session.goal.gate.exit")}{" "}
                        <span class={valueClass()}>
                          {exit() !== undefined ? exit() : language.t("session.goal.gate.unrun")}
                        </span>
                      </span>
                    </div>
                    <Show when={value().last_output_tail}>
                      <pre
                        data-slot="session-goal-gate-output"
                        classList={{
                          "max-h-32 overflow-auto whitespace-pre-wrap break-words": true,
                          "rounded-md bg-v2-background-bg-layer-02 p-2 text-v2-text-text-muted": v2(),
                          "rounded-md bg-surface-raised-base p-2 text-text-weak": !v2(),
                        }}
                      >
                        {value().last_output_tail}
                      </pre>
                    </Show>
                  </section>
                )}
              </Show>

              <Show when={conclusion()}>
                {(end) => (
                  <section data-slot="session-goal-handoff" class="flex flex-col gap-1">
                    <h3 class={sectionClass()}>{language.t("ui.messagePart.goal.verdict.handoff")}</h3>
                    <div data-slot="session-goal-verdict" data-verdict={end().verdict} class="flex items-center gap-2">
                      <Show when={end().round !== undefined}>
                        <span class={labelClass()}>
                          {language.t("session.goal.round", { round: num(end().round) })}
                        </span>
                      </Show>
                      <span
                        classList={{
                          "shrink-0 rounded-md px-1.5": true,
                          "border-[0.5px] border-v2-border-border-base text-v2-text-text-muted": v2(),
                          "border border-border-weak-base text-text-weak": !v2(),
                        }}
                      >
                        {verdictLabel(end().verdict)}
                      </span>
                      <span class={valueClass()}>{end().reason}</span>
                    </div>
                    <Show when={end().handoff}>
                      {(handoff) => (
                        <div class="flex flex-col gap-2">{handoffFields(handoff).map((item) => Fields(item))}</div>
                      )}
                    </Show>
                    <Show when={end().roleSessionID}>
                      {(id) => (
                        <button
                          type="button"
                          data-slot="session-goal-role-session"
                          classList={{
                            "mt-1 w-fit rounded-md px-2 py-1 text-left": true,
                            "bg-v2-background-bg-layer-02 text-v2-text-text-muted hover:text-v2-text-text-base": v2(),
                            "border border-border-weak-base text-text-weak hover:text-text-strong": !v2(),
                          }}
                          onClick={() => props.onOpenRoleSession(id())}
                        >
                          <Icon name="speech-bubble" size="small" class="mr-1 inline-block align-[-2px]" />
                          {language.t("session.goal.openRoleSession")}
                        </button>
                      )}
                    </Show>
                  </section>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
