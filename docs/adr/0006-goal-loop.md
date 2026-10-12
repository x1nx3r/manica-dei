# ADR-0006: The session's goal loop

Status: proposed · rev. 2026-10-12 (the QA loop) · Date: 2026-10-05
Relates to: manus-dei ADR-008 (task-anchored sessions) and ADR-009 (the
autonomy loop and its gates), both in the parent repo
Depends on: the per-turn run loop in `session/prompt.ts`, the `question` tool,
and the synthetic-part reminder path in `session/reminders.ts`

## Context

### What the loop does today

The fork runs one turn and stops. `SessionPrompt.runLoop` is a `while (true)`
(`session/prompt.ts:1088`) that exits the moment the model finishes a message
that is not a tool call and has nothing pending (`:1111-1130`). Within a turn it
iterates tool calls; across turns it does nothing. When the model says "done",
the session goes idle and stays idle until a human types again.

That is a prompt-responder, not an agent. The product wants the other thing:
give the session a goal and let it work until the goal is met, with the human
available but not required at every step.

### Two loops, not one

manus-dei's ADR-009 puts "the loop state machine" in the daemon. Read
against ADR-008, that conflates two different loops:

- **The inner loop** — one session pursuing one goal. Its state is the
  conversation. It ends when the session ends.
- **The outer loop** — one *task* surviving many sessions. ADR-008 owns
  this, and its own words say why it must live above: *"iteration must not
  hinge on a session that was banished."*

The outer loop belongs in manus-dei. The inner loop cannot. Putting it there
makes it a distributed state machine: the loop's state in the daemon, the thing
it controls in the session, every decision a round trip, and crash-consistency a
new failure class — inside the one component ADR-009 says "must not fail
silently." The judge settles it: it must read the conversation, and moving the
transcript out of the session is both expensive and wrong. **The judge belongs
next to the context.**

### What the fork already has

Three primitives, all native, which is why this is small:

- **`question`** (`tool/question.ts`) — the agent's first-class "I cannot decide
  this, I must ask the human" tool. ADR-009 names it as the gate primitive.
- **Synthetic parts on a user message** (`session/reminders.ts:27-45`) — the
  house pattern for injecting text the human did not type, without touching the
  system prompt. The cache-safe continuation mechanism, already in the tree.
- **`SessionTodo`** (`session/todo.ts`) — a persisted per-session record.

Subagents (`tool/task.ts`) add the fourth: a fresh-context worker, which is what
QA needs.

### Prior art, checked against source

`ref/hermes-agent` (MIT) is the closest loop. Its judge runs on an auxiliary
model, returns one of four verdicts, and appends continuations as normal user
messages, so the prompt cache survives. We took its judge system prompt and left
behind its **contract-aware user turn** — which is where the rule lives that
hitting the stated stop condition is `BLOCKED`, never `DONE`.

`ref/VERIFICATION-REFERENCE.md` and `ref/papers/` hold the batch that answers the
question this ADR now turns on: *how does a loop check its own work when nobody
is watching?* Two findings from it are load-bearing here, and both are
enforcements in the closest harness (`coding-quality-loop`, MIT), not advice:

- `quality-loop-reviewer.md:8` — *"Review only the contract, plan, minimality
  decision, diff, and evidence — **never the implementer transcript**."* The
  repository blocks a record where `reviewer == implementer` or `fresh_context`
  is false, and hard-fails a config where both resolve to the same model family.
- `quality_loop_reality.py:676-779` — **test-integrity replay**: an acceptance
  command must *fail* on the base source plus the proposed tests. A check that is
  green on both sides "does not distinguish the change".

The papers say the same thing from three directions: self-preference is real,
replicates on current models, and **worsens with capability**; judging fluently
written text is biased toward fluency; and mistake-*finding*, not repair, is the
bottleneck. None of them measures our models, which is what the eval is for.

### What the eval showed

The loop was run three times against a real codebase, with a simulated user
driving the session (`evals/goal-loop/`). Twice the judge accepted a green gate
over an outcome that was not true:

- run 2 — an escalation sweep that **nothing fires**;
- run 3 — an `escalate()` function with **no caller anywhere in the tree**.

The failure is structural. The doer wrote the artifact, the test that certified
it, and the report the judge read. The judge's reason improved between runs and
was wrong both times — *"All 40 tests (19 new) and typecheck pass, covering …
5-day escalation"* — because it read **coverage** where it needed to read
**truth**. Telling the agent it is judged made it show evidence; it could not
make the evidence independent of the agent.

## Decision

### The inner loop is per-session, in the fork

The session owns its own loop. No process outside it drives. deusd **relays and
supervises; it does not drive.** When the session needs a human decision it
*asks*, through `question`; the daemon relays and waits. The session pulls the
human in; the daemon never pushes.

### The loop has five phases, and the user holds two ends

**1. Scope.** The human states a goal. The agent reads it and asks about the
rough edges — ambiguities, missing information, assumptions it would otherwise
make silently. Ordinary turns; no loop.

**2. Commit — the user's first end.** The agent restates the goal, states the
completion contract, and asks the human to confirm what done means: **the
outcome, and how they will check it**, in their own words. The answer is both the
authorization to run unattended and the ratification of the criterion. This is
the only lever the human has on what done means, so it is explicit and not a nod.

**3. The loop — `dev → gate → QA → judge`.** No human, until a stop. The three
roles do not interrupt each other, and nothing outside them interrupts: this is
the middle the human explicitly left to them.

**4. Handoff — the user's last end.** The human receives the artifact, QA's
record, and the judge's verdict. They may **reject**, which re-opens the loop —
a new input from an end, not a hole in autonomy.

**5. Terminal.** The session returns to idle.

Scoping and commit stay separate, against ADR-009's preference for a single gate:
they answer different questions — *what* versus *authorization to spend
unattended* — and a human can reasonably want to clarify without authorizing.

### The loop is a chain of signatures

**Nobody signs what they made.** Read the loop as a chain, each link handing its
work to someone who did not produce it:

| produces | may not sign | signed off by |
|---|---|---|
| **dev** — the artifact | its own "done" | **QA** |
| **QA** — the falsification record | its own "clean" | **the judge** |
| **judge** — the verdict | the outcome | **the user** |
| the eval — the observation | — | us |

Every link is the same failure, one level down. The dev certifying the dev is the
run the eval caught. QA producing the evidence *and* weighing it would be the
same shape again — which is why QA and the judge are separate roles. It is not
decoration; it is the rule, applied recursively.

### Three diets

Each role is denied exactly what would bias it, and each denial has a source:

| role | sees | denied | why |
|---|---|---|---|
| **dev** | the user, the goal, the contract | — | it has to do the work |
| **QA** | the contract, the diff, the artifact, the gate's output | the dev's transcript and prose | *never the implementer transcript*; authorship labels alone move a verdict 0.73 → 0.32 |
| **judge** | the contract, the gate's output, QA's record | the dev's story **and the artifact** | fluency wins; a green suite is a silent signal |

The judge reading the **record** rather than the artifact is the load-bearing
move. It cannot be fooled by fluent prose, and its question narrows to one
checkable thing: *did QA genuinely try, and fail?* A negative report is also the
one thing a positivity-seeking model cannot dress up.

### Sycophancy is the engine, not the enemy

A model is not optimizing for truth; it is optimizing for the user's approval.
Aim that at "is it done?" and you get a golden retriever. Aim it at "break this"
and the pleasing-move *is* scrutiny — the same alacrity, pointed elsewhere. Each
role is pleased by its own aim: the dev by delivering, QA by breaking it, the
judge by being *right*. The loop does not remove the pull; it points it.

Two consequences follow, and both are design constraints:

- **A role may please by inventing work.** QA can please by manufacturing
  findings, not just by missing them. Every harness in `ref/` carries a
  false-positive filter for this reason.
- **The aim lives in the context.** A QA pass that inherits the dev's context
  inherits "we are nearly done", and will please by agreeing. Contexts are
  divided for that reason, not for hygiene.

### The record

**QA's pass is a record, not an absence.** Per acceptance criterion: the probe,
and its outcome. Silence is abstention, never a pass — otherwise "it found no
contradiction" is unfalsifiable, and the rubber stamp has merely moved one layer
up. There are two kinds of probe:

- **the contract's checks** — the commands the dev wrote;
- **probes QA derives from the user's pinned outcome**, which the dev never saw
  while building.

The second kind is the **holdout**, and it needs no keeper, no storage and no new
machinery: the *derivation* is the holding-out. It is not perfect — once revealed,
a later dev pass could tune to it — so it is re-derived each round, and failures
are reported to the dev as **symptoms** ("returns 200 when 429 was expected"),
never as the criterion.

**A derived probe is only as good as its derivation.** If QA derives it from the
same misreading as the dev, it fails identically. That is *why* QA is denied the
dev's story: the diet rule is what makes the holdout independent. The two are one
decision.

### What makes a probe count

QA can please by inventing findings, so a probe is only admissible when:

- it is an **executed observation** against the artifact, not a suspicion;
- its command is shown to **fail** on the base source and pass after the change
  (test-integrity replay). A check green on both sides proves nothing;
- it **reads the effect from the system of record** rather than trusting a
  narration or a tool's return — the silent-error rule. A green suite is a silent
  signal;
- **reachability**: a changed symbol that nothing calls is a contradiction, and no
  diff shows it. This check is mandatory, because it is the one our own failure
  needed and none of the reference harnesses has.

### The judge is thin, and the record is what it weighs

The judge is a reader with no tools: one call per stop, on a configured model
that is not the session's own, reading the contract, the gate's captured output,
and QA's record. It stays thin on purpose — it runs often, so it is cheap and
conservative — and what makes it honest is the facts standing around it:

1. **The gate.** A failing gate short-circuits the judge; its output is the
   continuation. The judge never sees a false floor.
2. **The record.** `done` requires a QA pass with no contradiction, and the
   record is the evidence that QA tried.
3. **State binding.** A verdict binds to the code state it reviewed — one
   canonical diff hash. Evidence older than the last edit is stale; a `done` with
   an empty diff is phantom. Without this, an approval survives the edit that
   invalidates it.
4. **The budget.** The real backstop. A broken judge must never wedge a run.

And one **escape hatch**, not a floor: an independent, **tool-using** reviewer for
the question no transcript can answer — *is this actually true?* — which opens the
artifact, reads the diff, and runs the gate itself. It is expensive, so it is not
per-stop; it is what a `done` verdict can be escalated to. Hermes reaches the same
shape (`/review`) and states the doctrine: **no agent verifies its own work.**

**Prefer a fact over a rule.** Every rule in a prompt is another thing to get
wrong, and the judge is deliberately thin. Hand it something true — a captured
gate result, a diff hash, a record — before writing more prose. Prose is for what
no fact can express: that done means the outcome is true, and that a stop
condition is a stop.

### The completion contract

At commit the agent writes down **how the loop will know the goal is met**. Five
named fields, following Codex's "strong goal" shape:

| field | meaning |
|---|---|
| **Outcome** | the single end state that must be true when done |
| **Verification** | the command that is **evidence** for it — concrete and checkable |
| **Constraints** | what must not change or regress |
| **Boundaries** | files, directories, tools, systems in scope |
| **Stop when** | the condition under which the agent stops and asks |

Three of these are not criteria, and saying so is the point:

- **`Outcome` is the criterion.** The loop ends when this is true — not when a
  command exits zero.
- **`Verification` is evidence for the outcome, not a substitute.** It proves the
  outcome only when the command *exercises* it. A green suite over an inert
  feature is a green suite.
- **`Stop when` is a run condition.** Reaching it means stop and ask — `blocked` —
  and can never mean done. It belongs to the loop's floor, not to the definition
  of done.

### Quality gates

A claim of evidence is not evidence. The contract's **Verification** is a command
and the loop runs it at every turn boundary **before** the judge:

- a **failing** gate is not adjudicated; its bounded output *is* the continuation;
- **retries are capped**; past the cap the loop stops as `blocked`, never `done`;
- gates run in the **session's workspace**;
- the gate runs in the **same decision** as the judge, so its result is fresh by
  construction — there is no window in which a green gate predates the work it
  certifies. The loop captures the command, its exit code and its output tail and
  hands them to the judge. The agent cannot shape them and cannot argue with them.

What a gate does **not** buy: it asks *"does the command pass?"*, not *"is the
outcome true?"* The two coincide only when the command exercises the outcome —
and the agent picks the command. A green gate is **necessary and not sufficient**.
An earlier revision of this ADR claimed "the gate asks *is it true?*, the judge
asks *is it done?*"; the eval showed that division of labour is false.

### Task size and the ask rubric

Task size is not lines or minutes. It is **the number and blast radius of
decisions the work requires that the task itself does not determine** — exactly
what the agent would otherwise ask about. Size and "when to ask" are one question
seen from two sides: **small** (the task determines the work), **medium** (a few
reversible decisions), **large** (many, some irreversible), **huge**
(underspecified past enumeration — the answer is *"this is more than one task"*,
and the agent proposes a split rather than discovering it at turn forty).

The size is **self-assessed at scope**, with a one-line reason, and the human can
override.

#### Size determines what commit produces

| size | commit produces |
|---|---|
| small | a one-line criterion |
| medium | a short checklist |
| large | subgoals and a verification gate |
| huge | a proposed decomposition — approve the split, not the details |

The agent can proceed at any size; what changes with size is what it asks for.

#### When to ask

|  | reversible | irreversible |
|---|---|---|
| **inferable** | proceed; record the assumption | ask, even when certain |
| **not inferable** | proceed with the likely reading; flag it | ask, always |

The top-right cell is the one that gets missed. Inferability is not authority: a
decision the agent is sure about still needs a human when the blast radius is
unbounded — a deleted branch, a force-push, a sent message, money spent.

#### Front-load, do not suppress

> **Scope is where you ask. Work is where you don't.**

Every question the agent can resolve at scope, it must. The working phase is then
quiet by construction, and **the frequency of mid-work questions measures the
quality of scope.** Infer from everything before asking, in order: the task text,
the repo (conventions, `AGENTS.md`, existing patterns), the trail, the
environment, reasonable defaults.

### The scratchpad

The agent keeps a **per-session scratchpad**: a markdown file, the mechanism
`Session.plan` already uses (`session/session.ts:331`), generalized.

It is a file because that buys three things: it **survives compaction** (a file
is untouched when the message history is pruned), it is **cheap to re-read** (the
agent reads its own distillation, not forty turns), and it is **the review
surface** (QA and the human read it). And a fourth that is easy to underrate:
**writing it is thinking.**

Sections: goal as understood, size and reason, contract, assumption ledger,
subgoals and progress, open questions, decisions and rationale. **The assumption
ledger is what makes minimal questions safe** — every inference acted on is
recorded and surfaced at `done` and on any `blocked`.

It is referenced by path and read on demand, so it stays out of the cached prefix,
and injected in exactly two places: after compaction, and at judge time.

#### The plan file folds in

The scratchpad subsumes plan mode's plan file: "the plan" becomes the subgoals
section. This touches plan mode, and it is named here rather than folded in
silently.

### The judge returns one of four verdicts

- **`done`** — the outcome is shown true, the record shows QA tried and found no
  contradiction, and the state bound to the verdict is current. Not "the command
  passed". Requires the deliverable to exist; an explanation of why the goal cannot
  be reached is `blocked`, not `done`.
- **`blocked`** — genuinely unachievable, the next step needs a human, **or the
  agent reached the contract's stop condition**. The loop routes it to `question`,
  so the human is asked rather than the run simply ending — via a synthetic
  continuation, so the question still comes from the agent's own tool.
- **`continue`** — not done, and there is a concrete next step. The default when in
  doubt.
- **`wait`** — not done, but progress is gated on async work. Parks the loop
  without burning a turn; the park is a **barrier** — a pid, a session, or a
  deadline — and the loop re-enters when it releases.

### The agent may ask at any point, and asking is not a failure

While working the agent may call `question` whenever it is unsure or has reached a
state it cannot judge alone. This is distinct from the judge's `blocked` and both
are kept: `question` is **agent-initiated**; `blocked` is **loop-initiated**. The
second exists because of the first's blind spot — an agent that does not know it
should ask, or is confidently wrong, will never call the tool.

When the agent asks, the loop **parks** and resumes on the answer; it does not
burn the budget and does not guess to keep moving. The answer is appended as the
next user message, so the cache-safe continuation rule holds for answers as it
does for continuations.

### The continuation is a synthetic user message

On `continue`, the loop appends a new user message carrying the continuation and
marks it synthetic — the `reminders.ts` convention. It never mutates the system
prompt and never rewrites past context, so the prompt cache survives. That
invariant is what makes a long autonomous run affordable.

### The loop has a floor

A **turn budget** per goal is the backstop; when it is spent the loop hands back
with the contract's remaining gaps stated. A single judge failure is **fail-open**
(continue), because a broken judge must not silently end a working run — but
fail-open alone lets a permanently broken judge burn the budget, so there is a
**circuit breaker**: consecutive parse or transport failures stop the loop and name
the judge configuration. Tolerate a blip; not a misconfiguration. **Plateau** — no
new information for N rounds — stops it too, and a `blocked` looping forever is
caught by the budget.

### The goal, the phase, and the verdicts are persisted

The goal, contract, authorization, **phase** (`dev | qa | judge`), turn count, and
last verdict are recorded against the session, so a reconnect or restart does not
lose an authorized run, and the contexts stay divided across it. This is
session-local state, not a task — the task is manus-dei's, per ADR-008.

### The judge model is configurable, and not the session's own

The judge uses a configured judge model, **not the session's own by default**: the
failure this loop exists to catch is the agent confidently wrong about its own
work, and a model grading itself is the weakest possible check on exactly that.
QA likewise runs in a **fresh context**, and on a **different model family where
available** — with the honest caveat that the references disagree on whether
family diversity is load-bearing or whether isolation alone suffices. We isolate
always; we take the family difference where we can; and the eval decides whether
it mattered, because we have no evidence for it on our own stack.

### How we see the loop work

The loop's behaviour cannot be unit-tested. A parser test proves the code reads
`blocked`; it cannot prove the judge *recognises* one. So the loop is watched by
an eval: a simulated user driving a real session against a real codebase
(`evals/goal-loop/`).

It is an **observatory, not a score.** The artifact is the transcript; the
grader's rubric is its attention list, not a number to optimise. What it produces
is a corpus of user-versus-agent stories and the patterns across them — both
failures above were found that way, and neither could have been found otherwise.

And it is **the licence**: the references' answer to "who judges QA" is that a
judge earns its licence against held-out evidence and loses it when the model or
rubric changes. Our held-out evidence is the fixture's hidden acceptance cases,
and the eval is where the licence is renewed — per model change, with the
transcript as the record. Neither judge nor QA is trusted because it is a model;
it is trusted because it has been watched.

**One caveat we must carry:** the evidence base for all of this was measured on
2023–24 models, and the self-preference result is the only part that has been
re-run on current families — where it got *worse*, not better. Our own models
appear in none of it. Treat the references as bounding the design, and the eval as
the only thing that speaks for our stack.

## Consequences

- **The fork diverges further from upstream.** The cost of the decision,
  and the right divergence: autonomy is what makes the session an agent.
- **A new role, and a new artifact.** QA is a fresh-context, read-only pass with
  its own brief; its **record** is a first-class artifact — the judge weighs it,
  and the human reads it at handoff. It is the thing that makes "no contradiction
  found" mean something.
- **The phase is new persisted state**, and a migration with it.
- **The judge's diet narrows.** It no longer reads the agent's response; it reads
  the contract, the gate's captured output, and the record. That is a change to
  what it is shown, not only to what it says.
- **`done` becomes unreachable from `dev`.** A QA pass must intervene, and the
  verdict must bind to the state QA reviewed — one diff hash, with stale and
  phantom states rejected.
- **Reachability becomes a check.** A changed symbol nothing calls is a
  contradiction. This is ours; no reference harness has it.
- **The holdout needs no mechanism.** It is QA's derived probes plus the user's own
  acceptance test at handoff. Nothing hidden is stored anywhere.
- **The commit gate means two things.** "Run unattended" *and* "I agree what done
  means". One extra turn, at a step where the human is already present.
- **Cost.** An extra model call per stop for the judge, an extra pass per round for
  QA, and a possible cross-family call. Bounded by the budget; absent when no goal
  is set.
- **Tests.** The verdict parser, the contract handling, the gate runner, the record
  shape, the diff-hash binding, and the budget are pure and unit-tested. The loop's
  continuation path is tested against a fake judge, asserting the prompt-cache
  prefix is unchanged across a continuation. The gate runner is tested against a
  command that passes and one that fails, asserting a failure short-circuits the
  judge and carries the output tail.

## Out of scope

No daemon-side loop, no cron, no scheduler. No per-step human approval — the
middle is the three roles'. No budgets *enforcement* beyond the turn cap
(manus-dei ADR-009 defers spend caps). No cross-session memory or skill
self-improvement. No navigation allowlist and no new external service. No change
to the human's RFB transport.

The outer loop, the task state machine, the process-level stuck-detector, and the
notification relay are manus-dei's and are untouched by this ADR.
