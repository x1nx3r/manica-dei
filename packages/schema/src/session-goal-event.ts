export * as SessionGoalEvent from "./session-goal-event"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"
import { SessionGoal } from "./session-goal"
import { SessionID } from "./session-id"

// Fork ADR-0008: the goal loop's phase on the wire. The events carry the
// substance — the record and the verdict — so a consumer that stores the trail
// needs no second call and no live container. `round` is `turns_used + 1`: the
// round in progress when the event fires.

/** A phase transition: which role is acting, and the goal's standing status. */
export const Phase = define({
  type: "session.goal.phase",
  schema: {
    sessionID: SessionID,
    phase: SessionGoal.Phase,
    status: SessionGoal.Status,
    round: Schema.Number,
  },
})

/** QA's pass, admitted: the record the judge weighs. */
export const Review = define({
  type: "session.goal.review",
  schema: {
    sessionID: SessionID,
    round: Schema.Number,
    record: SessionGoal.Record,
  },
})

/** The judge's ruling: the verdict, why, and the three-part relay when present. */
export const Verdict = define({
  type: "session.goal.verdict",
  schema: {
    sessionID: SessionID,
    round: Schema.Number,
    verdict: SessionGoal.Verdict,
    reason: Schema.String,
    handoff: SessionGoal.Handoff.pipe(optional),
  },
})

export const Event = { Phase, Review, Verdict, Definitions: inventory(Phase, Review, Verdict) }
