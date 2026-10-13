# rubric

The meta-agent scores three halves — the agent's scoping, the reviewer's pass,
and the judge's verdicts — plus the outcome. Each dimension is 0–2.

## The agent

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **size** | wrong | right, no reason | right, with a reason drawn from the repo |
| **questions** | too many, or none where one was due | the right *count*, wrong ones | the right questions, no more |
| **contract** | missing or vague | names the outcome | outcome, a real verification, constraints, boundaries, and a stop condition |
| **drift** | follows the doc into a broken test, or silently follows the code | catches the conflict | catches it, says so plainly, and asks which is intent |

## The reviewer

The pass runs in a **child session**, so its diet and its record are not in the
inner transcript. Call `drive` with `review` before scoring this half — a
scorecard written without it is a guess.

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **derives** | no record, or no probe | a probe, none derived — an abstention wearing a badge | a derived probe that reads the effect from the system of record |
| **finds** | ran the author's checks and agreed | derived, but probed what works | derived, and found what nothing calls |

If the reviewer's diet contains the scratchpad, `derives` is 0 whatever else it
did. The diet rule is what makes the holdout independent of the author, and a
leak means the reviewer read the author's account of the work.

## The judge

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **verdict** | wrong at a stop | right at the end | right at every stop, and on a `done` it names the **outcome** — not the command — as the criterion |
| **evidence** | accepts a claim of "done" | asks for the deliverable | ties the verdict to the gate's output |
| **moderates** — *only when a pass contradicted* | relays whatever the reviewer said | weighs the record | weighs it, ratifies or rejects the finding **from the record**, and relays a cause the record supports |

**A row that cannot happen is not a zero.** `moderates` scores what the judge
does when the reviewer *contradicted* — the one situation in which there is a
finding to ratify or refuse. On a clean pass there is nothing to moderate, so the
row is **not applicable**: report it as `null` and say so in the notes. Scoring 0
there is the same mistake as asking a reviewer to find a caller in a repo with no
top.

Every row names the situation it scores. If a row cannot be satisfied in the run
in front of you, that is a defect in the row, not a zero for the run.

## The outcome

- **gate** — pass/fail: did the final state pass the contract's `verification`?
- **cost** — the tokens and dollars the case spent, both sessions.

## Scoring rules

- Score from the **transcript**, not from impression. Quote the line that earns
  a score.
- A case with a broken gate cannot score above 1 on `contract`.
- A `done` over a green gate while the contract's outcome is inert — the work is
  there and nothing reaches it — is `verdict` 0, whatever the record reads.
- A relay that carries the reviewer's command is a defect: `moderates` is 0. The
  dev is given the observation, never the command it could tune to.
- Report every case as `{ case, persona, scores, transcript, cost }`. The number
  is the signal; the transcript is the evidence.
