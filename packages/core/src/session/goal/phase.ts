export * as GoalPhase from "./phase"

import type { SessionGoal } from "@opencode-ai/schema/session-goal"

// Fork ADR-0006 (rev. the QA loop): the phase machine. Everything here is pure —
// the phase names the role that is acting, and the one rule it carries is that
// only the judge may conclude a run. The persistence and the wiring that set the
// phase are effectful and live in `packages/opencode`.

export type Phase = SessionGoal.Phase
export type Verdict = SessionGoal.Verdict

/**
 * Whether a `done` verdict may conclude the run. Only the judge rules on the
 * outcome, so only the `judge` phase may. A `done` seen while `dev` or `qa` is
 * acting is not honoured — it must not end the run.
 */
export function mayConclude(phase: Phase): boolean {
  return phase === "judge"
}

/**
 * The phase after a verdict. `continue` and `wait` return the loop to `dev`;
 * `wait` parks it and resumes there. `done` and `blocked` end the run, so they
 * have no next phase.
 */
const NEXT: Record<Verdict, Phase | undefined> = {
  continue: "dev",
  wait: "dev",
  done: undefined,
  blocked: undefined,
}

export function after(verdict: Verdict): Phase | undefined {
  return NEXT[verdict]
}
