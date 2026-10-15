# Finding: the QA round's record exists on the child — the parent window shows it only as prose, and the strip's live-arrival leg is unverified

|             |                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**  | The first real end-to-end goal-loop run (2026-10-15): repo `/home/x1nx3r/mgodonf/gitdash`, goal "configurable wallpaper", session `ses_ec246b7d3ffePC5pOJuo67W1Zx`, two `goal-qa` children and one `goal-judge` child. |
| **Found**   | 2026-10-15, by watching the client while the loop ran; the wire was read during and after the run.                                                                                                                     |
| **Verdict** | The run **worked end to end**. The original "the record was nowhere" suspicion was my own pagination artifact, retracted below. What remains is two _view_ problems, not a data problem.                               |

## What the trail actually held (verified, not narrated)

- **Round 1** (`ses_ec23d7e6bffejy2xZscYUVuNm7`): the human's interrupt aborted the
  QA pass mid-probe. The loop did exactly ADR-0006's fail-open: it cleared the
  record, **burned the turn** (`turns_used` 0→1 — a killed QA is still a round
  spent), returned the phase to `dev`, and handed the dev the
  `[Continuing toward your standing goal — the QA pass could not run]`
  continuation (`core/session/goal/qa.ts`). No `goal.review` part exists on that
  child — correct: the pass never completed, so there was nothing to type.
- **Round 2** (`ses_ec238469dfferLku6No4o9NAZA`, clean cert, 9 probes): the
  **record is a typed part on the QA child's assistant message** — `goal.review`,
  `verdict: clean`, 9 probes (the author's own check plus 8 derived), 0 findings,
  exactly as ADR-0008 step 2 placed it. A 20-message scan had missed it; the
  part is far down a long transcript. Retracting "narrated, not typed".
- **The judge** (`ses_ec2314989ffeAbvMiMxRCTp2Zo`): ruled `done`, its
  `goal.verdict` part and its own session row intact, and `last_verdict_session`
  lands on the goal row — the late-arrival pointer we shipped (`d383334e5`)
  carries a real judge session now. The judge's _reason cites QA's probes verbatim_
  ("QA derived and ran probes covering the wallpaper settings section, S3 blob
  CRUD with cookie"), which confirms the row's `qa_record` was present at judge
  time — and empty after, because `Goal.record`'s handoff **clears the record the
  moment the judge weighs it**, by design (ADR-0006, "the loop clears it"). That
  was the third misread: the empty row was the design working, not the record
  vanishing.
- **Phase banner through the run**: `dev → qa → (interrupt) → dev → qa → judge →
done`, `turns_used 2` — the budget counted both certified rounds.

## What remains to fix — two view problems, now precisely scoped

1. **The parent window shows the pass only as the loop's prose.** By step 2's
   design the review card lives in the QA child's transcript; the parent shows
   the chip, the strip's contract/gate, "The Run" rows, and narration. The human
   watched a certification with nothing to click on. Two honest routes:
   render a _link row_ in the parent pointing at the child's
   `goal.review` part (the parent already has the pointer: the loop's
   `roleSessionID` on the review event — round-2's is the QA child), or surface
   the record under the strip's "The Run" section. The ADR's own fix list
   ("the events carry a role session's id and the parts do not") is a
   prerequisite.

   **Fixed since this note was written, in two pieces.** The chips landed first:
   the review and verdict events announce their `roleSessionID`, the client keeps
   them, and "The Run" renders each role's own word beside its row (the judge's
   also synthesizes from the projection, so a finished run shows `done` without
   the events). The _in-flight_ row is the second piece, from the wallpaper run's
   round 3: the QA child exists on disk with a 38-message transcript while
   `session_goal`'s children route reports it unlabeled, because `runQa` stamped
   `goal_role` only at the handoff — "The Run" filters to labeled children, so a
   live pass was invisible exactly while it was running. The label is stamped at
   the task tool's child creation now (`extra.metadata`, `tool/task.ts`), with the
   handoff stamp kept and merging, so the round number attaches before the first
   probe and the row deep-links to the transcript the moment the pass starts.

2. **The strip's live-arrival leg is unverified.** A client that was open when
   the goal was set showed no strip; a client that reloaded showed it, which
   localizes the suspect to the event→refetch path (`session.goal.phase` →
   `sdk.event.on` → refetch). It needs a first-principles check on the SSE wire:
   what the goal events actually look like on `/api/event`
   (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` maps
   `event.data` → `properties`), and what `detectServerProtocol` decides for
   this server so `server-session.ts`'s listener is on the _right_ bus. The
   mount-fetch path is sound and the data is sound; only the live trigger is in
   question.
