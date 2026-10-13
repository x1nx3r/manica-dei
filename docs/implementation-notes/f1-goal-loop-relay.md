# F1 — step 3: the judge relays a contradiction

Reviewed. Step 2 shipped the QA pass (`ba6690cb4`); this is the edge it left
unsigned. Read with `docs/adr/0006-goal-loop.md` §"The loop is a chain of
signatures" and the QA draft's §5–§6 (`f1-goal-loop-qa.md`).

---

## 1. What step 2 left open

**The QA→dev edge has no signer, and it is the one edge where QA produces
something.** In `packages/opencode/src/session/goal-loop.ts` a `contradicted`
record is relayed to the dev and the loop returns **before the judge is called**.
So:

- a **fabricated finding** costs the dev a round and is never moderated — and
  manufacturing findings is exactly how a pleaser pleases (ADR, "Sycophancy is
  the engine": *a role may please by inventing work*);
- the rule the whole ADR rests on — *nobody signs what they made* — holds for the
  artifact (QA signs) and for the record (the judge signs) **except here**, where
  QA's record goes straight to the dev;
- the dev is handed QA's fields as a raw paste, which is the shape §5 and §6
  already replaced.

Step 2's judge weighs a **clean** record. Step 3 has it weigh a **contradicted**
one as well, and frame what the dev is told.

## 2. The design

**The judge's reply grows one field.** `Judgement` (in
`packages/core/src/session/goal/judge.ts`) becomes `{ verdict, reason, wait?,
handoff? }`, where `handoff` is **three fields**, not prose:

```ts
{ tested, implementation, cause }   // all three non-empty, or the field is absent
```

**The loop calls the judge on a contradiction too.** The contradicted branch
becomes a judge call, sharing the failure accounting the clean path already has,
and the record is read by the judge before it is cleared.

**The loop renders the three parts, not the judge.** Verbatim from §5, corrected
by §6:

```
[Continuing toward your standing goal — QA tested this, and it failed]

QA tested:
  <handoff.tested>

Your implementation:
  <handoff.implementation>

The likely cause:
  <handoff.cause>

Check it. If the cause is right, fix it. If it is wrong, say why, with the
evidence — the record will be weighed again.
```

### The rules, and where they bite

**The judge frames; it does not compose.** Each part is a *label around a record
field*, not a paraphrase:

| part | source |
|---|---|
| `QA tested` | the probe's criterion and its observation |
| `Your implementation` | the finding's evidence — what the artifact does |
| `The likely cause` | the finding's detail — the contradiction QA asserts |

A part with no source in the record is a defect, not a judgement. This is what
makes "a judge that relays a cause it does not believe is a judge that lied"
checkable rather than merely discouraged. The one place the judge writes its own
words is a **rejection**, below.

**The judge may reject QA's finding.** A false positive is QA pleasing by
inventing work, and the judge is the only role positioned to moderate it. A
rejected finding is still a `continue`, and the third part carries the judge's
reason, grounded in the record or the gate's output. **Settled: `continue`,
`blocked` and `wait` are the judge's to give off a contradiction; `done` is
refused by the loop**, because no clean pass was admitted and the derived-probe
rule is what stops QA's contradiction being waved through.

**The probe's `command` is not relayed — structurally.** The judge is rendered
the record **without** `probe.command`, so it cannot leak what it never saw. The
gate's output, already in its diet, is the record of *what was run*. This is the
only version that guarantees §6; instructing a prompt and stripping afterwards is
defeated by a paraphrase.

**The QA brief stops inviting the command.** Its finding `evidence` currently
reads *"file:line, or the command and its output"*, which is exactly the leak
route: QA puts the command in the finding and the relay carries it. Evidence
becomes **`file:line`, or the observation** — never the command.

**A judge failure keeps the findings.** The clean path fails open to `continue`
with `FAIL_OPEN`. On a contradiction that would *lose QA's work*, so the fallback
is the record's own relay (`Qa.relayContinuation`), which already withholds
commands. The failure counters are unchanged.

**The round still spends a turn**, charged by the judge's own `record` write.

## 3. What changes

| file | change |
|---|---|
| `packages/core/src/session/goal/judge.ts` | `Judgement.handoff` (three fields); `renderRecord` drops `probe.command`; the prompt's three-part instruction and the traceability rule; `parseJudgement` accepts the field only when all three parts are non-empty |
| `packages/core/src/session/goal/qa.ts` | the brief's finding `evidence` (command forbidden); the relay renderer for the three parts |
| `packages/opencode/src/session/goal-loop.ts` | the contradicted branch falls through to the judge; `done` refused on a contradicted record; the handoff becomes the continuation, with `Qa.relayContinuation` as the failure fallback |
| `packages/core/test/session/goal/judge.test.ts` | the field, the instruction, the parse, the withheld command |
| `packages/opencode/test/session/goal-loop.test.ts` | contradicted → judge; a handoff rendered; a rejected finding; a refused `done` |
| `packages/opencode/test/session/goal-loop.integration.test.ts` | the contradicted round now reaches the judge — the mock answers one more call |

## 4. Settled

The five questions, answered by the user:

1. **Verdicts on a contradiction** — `continue`, `blocked` and `wait` are
   admissible; `done` is refused by the loop.
2. **The withholding** — structural: the judge never sees `probe.command`.
3. **The finding's `evidence`** — `file:line` or the observation, never the
   command.
4. **The handoff** — three fields, rendered by the loop.
5. **A rejected finding** — returns to `dev` and spends a turn, never `done`.

## 5. Acceptance

- A contradicted record reaches the judge; the judge's handoff is what the dev
  receives; a fabricated finding can be rejected with a reason, and the dev is
  told so rather than being sent to fix it.
- The probe's `command` never appears in any continuation or in the judge's diet,
  proven by a test that fails if it does.
- The judge's failure path preserves the findings.
- `bun test` in `packages/core` and `packages/opencode`, `bun turbo typecheck`,
  and the e2e with one more scripted judge turn.
