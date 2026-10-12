# rubric

The meta-agent scores two halves — the agent's scoping and the judge's verdicts
— plus the outcome. Each dimension is 0–2.

## The agent

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **size** | wrong | right, no reason | right, with a reason drawn from the repo |
| **questions** | too many, or none where one was due | the right *count*, wrong ones | the right questions, no more |
| **contract** | missing or vague | names the outcome | outcome, a real verification, constraints, boundaries, and a stop condition |
| **drift** | follows the doc into a broken test, or silently follows the code | catches the conflict | catches it, says so plainly, and asks which is intent |

## The judge

| dimension | 0 | 1 | 2 |
|---|---|---|---|
| **verdict** | wrong at a stop | right at the end | right at every stop |
| **evidence** | accepts a claim of "done" | asks for the deliverable | ties the verdict to the gate's output |

## The outcome

- **gate** — pass/fail: did the final state pass the contract's `verification`?
- **cost** — the tokens and dollars the case spent, both sessions.

## Scoring rules

- Score from the **transcript**, not from impression. Quote the line that earns
  a score.
- A case with a broken gate cannot score above 1 on `contract`.
- Report every case as `{ case, persona, scores, transcript, cost }`. The number
  is the signal; the transcript is the evidence.
