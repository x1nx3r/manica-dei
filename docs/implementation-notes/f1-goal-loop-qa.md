# F1 — the QA pass (ADR-0006 rev., step 2)

Draft for review. Step 1 shipped the phase machine and the state handle
(`55861620e`). This is step 2: the pass that gives them teeth.

Nothing here is built yet. The brief and the record are written as they would
appear in code, so approval is close to a copy: the brief into
`packages/core/src/session/goal/qa.ts` (beside `judge.ts`), the record into
`packages/schema/src/session-goal.ts`.

---

## 1. The brief

QA's system prompt. Plain, imperative, and it sets the aim: the reviewer is
*pleased* by demonstrating that it tried to break the work.

> You are the reviewer, and you are not the author of this work. You did not
> write it, you have not read the author's account of it, and you will not take
> its word for anything. Someone is going to run this. Find what will break for
> them.
>
> You are given the completion contract, the diff, the artifact, and the output
> of the check the author chose. You are **not** given the author's transcript,
> their scratchpad, or their summary — deliberately, because a confident account
> of work is the thing that fools reviewers.
>
> ### What you produce
>
> A **record**. Not an opinion — a record. For every acceptance criterion in the
> contract: the probe you ran, and what it produced.
>
> If you derived nothing of your own, you have not reviewed. You have abstained,
> and abstaining is not a pass. Running only the author's own checks is not a
> review — the author wrote them to pass.
>
> ### Two kinds of probe
>
> 1. **The contract's own checks** — the commands the author wrote. Run them. A
>    check the author wrote can be hollow; see below.
> 2. **Probes you derive yourself from the outcome.** This is the part that
>    matters. Take each clause of the stated outcome and build the smallest thing
>    that would demonstrate it is *false*: a command, a query, a read-back. The
>    author never saw these, so they cannot have been written to fit.
>
> ### What makes a probe count
>
> - It is **executed**. Reading the diff is not a probe. If you cannot execute
>   it, say so and say why — an unexecuted probe is a question, not evidence.
> - It can **fail**. A check that is green before *and* after the change proves
>   nothing about the change. Where a test is involved, show it failing on the
>   base and passing here, or report that you could not.
> - It **reads the effect from the system of record**. A green suite is a silent
>   signal: a run can be green while the feature is inert. Read the row, the
>   file, the output, the queue — not the narration of them.
> - It is **reachable**. A function that exists, is documented and is tested, but
>   that **nothing calls**, does not do anything. For every symbol the change adds
>   or alters, find its caller. If you cannot, that is a finding.
>
> ### Findings
>
> A finding is a **contradiction** between the contract and the artifact: a clause
> of the outcome that is not true, a constraint that is violated, a boundary that
> was crossed — or an outcome nobody can reach.
>
> Every finding carries its evidence: the file and line, or the command and its
> output. A suspicion is not a finding. Do not report style, taste, or the work
> you would have done differently. Do not invent findings to look thorough — a
> manufactured finding costs the author a round and is worse than silence.
>
> ### The one thing you must not do
>
> Do not accept the author's framing. The contract is the standard, the artifact
> is the evidence, and nothing else is admitted. Where the artifact and the
> contract disagree, the artifact is what is true.

---

## 2. The record

```ts
export const Probe = Schema.Struct({
  criterion: Schema.String,   // which clause of the contract this probes
  derived: Schema.Boolean,    // true = QA's own probe (the holdout); false = the author's check
  command: Schema.String,     // what was executed
  output: Schema.String,      // the captured tail
  result: Schema.Literals(["pass", "fail", "could-not-run"]),
})

export const Finding = Schema.Struct({
  criterion: Schema.String,   // the clause it contradicts
  detail: Schema.String,      // the contradiction, in one or two sentences
  evidence: Schema.String,    // file:line, or the command and its output
})

export const Record = Schema.Struct({
  state: Schema.String,       // the snapshot hash reviewed — the verdict's binding
  verdict: Schema.Literals(["clean", "contradicted"]),
  probes: Schema.Array(Probe),
  findings: Schema.Array(Finding),
})
```

A worked record, from the failure that started this — the escalation that nothing
fires:

```json
{
  "state": "8f3c…",
  "verdict": "contradicted",
  "probes": [
    { "criterion": "a request pending 7+ days reaches the HR manager",
      "derived": true,
      "command": "bun run src/db/escalation.ts && bun run -e 'create({days:6}); q=hr.queue()'",
      "output": "queue: (empty)",
      "result": "fail" },
    { "criterion": "the sweep is scheduled",
      "derived": true,
      "command": "grep -rn 'escalateOverdue' src/ | grep -v test",
      "output": "src/domain/leave.ts:79 (definition only)",
      "result": "fail" }
  ],
  "findings": [
    { "criterion": "a request pending 7+ days reaches the HR manager",
      "detail": "escalateOverdue is defined and tested but nothing calls it; an overdue request stays pending and never reaches the queue.",
      "evidence": "src/domain/leave.ts:79; src/db/ has no caller" }
  ]
}
```

---

## 3. What the loop does with a record

| record | the loop |
|---|---|
| `clean`, **no derived probes** | **abstention, not a pass.** The author's own checks are not a review. Back to `dev` with a continuation demanding a derived probe. The judge never sees it. |
| `clean`, a derived probe present | the phase moves to `judge`; the judge weighs the record. |
| `contradicted` | back to `dev`, with the findings reported as **symptoms** — never as the criterion. |
| `state` ≠ the round's state | **stale.** The record cannot be weighed; the work moved after it was made. Back to `dev`. |

The first two rows are read off a **corrected** record: before weighing it, the
loop attributes each probe to its author. A probe marked `derived` whose command
is one of the author's own — a gate or the contract's verification — is read as
the author's check, so a relabel does not satisfy the holdout rule
(`GoalQa.attributeProbes`).

And the two rules step 1 left unwired:

- **`mayConclude` gains teeth here.** The loop enters `judge` only *after* a QA
  pass, and `submitRecord` writes the record and that phase move together, so a
  `done` arriving while the phase is `dev` or `qa` is refused. The reachable case
  is a **torn handoff** — the record persisted, the phase move did not, as a crash
  between the two writes leaves it — and the guard is what stops that record
  concluding.
- **`state_hash` becomes an enforcement.** The record's `state` must equal the
  state the judge will bind to.

---

## 4. What I want you to judge

1. **Does QA see the scratchpad?** The ADR's scratchpad section says the judge and
   the human read it — but the scratchpad is the *author's prose*, which the diet
   rule forbids. My lean: QA does not read it, the human does, and the ADR's
   scratchpad section needs one line fixed to say so.
2. **Is the verdict a claim?** I have written it as QA's claim, so the judge can
   disagree with QA on the same probes. The alternative is to derive it from
   `findings.length`, which makes the judge's job mechanical but loses that
   disagreement.
3. **Is a `clean` pass with zero *derived* probes admissible?** My lean: no — the
   derived probes are the holdout, and a pass without one is the author's own
   checks wearing a badge.
4. **How much must the outcome be exercised?** One derived probe per clause of the
   outcome (my lean), or one end-to-end path through all of it?
5. **Do the findings go to the dev verbatim?** Signum's rule is symptoms, not
   criteria, so the dev cannot tune to the holdout. But a `detail` field is
   already a sentence, and it is hard to make it less than a criterion.

---

## 5. Settled: the judge relays QA's findings, and the dev is made to argue

All five questions are answered; the fifth differently from how I framed it.

**Findings go to the dev verbatim — carried by the judge, in three parts.** Not a
raw paste, and not a bare "fix this". When QA contradicts the work, the judge
composes the continuation:

```
[Continuing toward your standing goal — QA tested this, and it failed]

QA tested:
  <the criterion> — the probe it derived, and what it produced

Your implementation:
  <what the artifact does, per QA's read — file:line>

The likely cause:
  <QA's finding, as the judge reads it>

Check it. If the cause is right, fix it. If it is wrong, say why, with the
evidence — the record will be weighed again.
```

Three things follow, and they are the point.

**The judge becomes the moderator, not only the scorer.** It already rules on the
outcome; now it also *frames* the disagreement between the two agents. That is
another reason it cannot be a rubber stamp — a judge that relays a cause it does
not believe is a judge that lied.

**The dev is handed a hypothesis, not an instruction.** "Your implementation is X
and the likely cause is Y" is falsifiable by the agent that wrote it, and the last
line invites it to falsify. An agent that answers *"no — the cause is Z, here is
the evidence"* is doing exactly the work the loop wants. An agent that silently
patches the probe failed the intent even if the gate goes green.

**And the dev questions itself before the user ever sees it.** That is the whole
reason to relay the record rather than the verdict alone.

**The trade, accepted on your call.** Verbatim findings reveal a derived probe, so
a later dev pass could tune to it. Two things bound the damage: the holdout is
re-derived each round, so the revealed probe is a *past* one; and test-integrity
replay still catches a check made hollow to fit it. Self-questioning is worth more
than the secrecy — and the record is what the human reads at handoff anyway.

**So the judge's reply grows a field:** `{ verdict, reason, handoff? }`, where
`handoff` is the three-part message, present when the verdict is `continue` on a
QA contradiction. The pure half gains the instructions; the parser accepts it.

---

## 6. Two corrections, argued after §5

*(§4's question 5 is settled by §5 and §6.)*

**The judge frames; it does not compose.** §5 had the judge writing "the likely
cause: <as the judge reads it>". That is a paraphrase, and paraphrasing is where
this judge has already drifted — its reason was wrong twice while reading better
evidence each time. The three parts are *labels around QA's own fields*; every
clause must be traceable to the record, and a clause with no source in it is a
defect. That makes the relay checkable, and "the judge lied" impossible rather
than merely discouraged.

**Give the observation, withhold the probe's command.** The dev needs *"the queue
is empty when a request is six days old"* to find the cause. It does not need the
command that produced it — that is the thing it can tune to. This is Signum's
split exactly: the observable is reported, the hidden criterion is not. The
holdout survives past the first round at no cost to the dev.
