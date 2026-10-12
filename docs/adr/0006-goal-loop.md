# ADR-0006: The session's goal loop

Status: proposed · rev. 2026-10-12 (the judging strategy) · Date: 2026-10-05
Relates to: manus-dei ADR-008 (task-anchored sessions) and ADR-009 (the
autonomy loop and its gates), both in the parent repo
Depends on: the per-turn run loop in `session/prompt.ts`, the `question`
tool, and the synthetic-part reminder path in `session/reminders.ts`

## Context

### What the loop does today

The fork runs one turn and stops. `SessionPrompt.runLoop` is a
`while (true)` (`session/prompt.ts:1088`) that exits the moment the model
finishes a message that is not a tool call and has nothing pending
(`:1111-1130`). Within a turn it iterates tool calls; across turns it does
nothing. When the model says "done", the session goes idle and stays idle
until a human types again.

That is a prompt-responder, not an agent. The product wants the other thing:
give the session a goal and let it work until the goal is met, with the
human available but not required at every step.

### Two loops, not one

manus-dei's ADR-009 puts "the loop state machine" in the daemon. Read
against ADR-008, that conflates two different loops:

- **The inner loop** — one session pursuing one goal: scope, commit, work,
  judge, continue. Its state is the conversation. It ends when the session
  ends.
- **The outer loop** — one *task* surviving many sessions. ADR-008 owns
  this, and its own words say why it must live above: *"iteration must not
  hinge on a session that was banished."*

The outer loop belongs in manus-dei. The inner loop cannot. Putting it there
makes it a distributed state machine: the loop's state (goal, contract, turn
count, verdict) in the daemon, the thing it controls (the conversation) in
the session, every decision a round trip, and crash-consistency between the
two a new failure class — inside the one component ADR-009 itself says "must
not fail silently." It also widens the seam: to drive the loop the daemon
would have to re-prompt the session and read its state, becoming a stateful
client rather than a supervisor.

The judge settles it. It must read the conversation. Shipping the context
out to the daemon is expensive and puts the transcript in the wrong process;
summarizing it makes the judge guess. **The judge belongs next to the
context.**

### What the fork already has

Three primitives, all native, which is why this is small:

- **`question`** (`tool/question.ts`) — the agent's first-class "I cannot
  decide this, I must ask the human" tool. ADR-009 names it as the gate
  primitive and this ADR does not invent a second one.
- **Synthetic parts on a user message** (`session/reminders.ts:27-45`) — the
  house pattern for injecting text the human did not type, without touching
  the system prompt. This is the cache-safe continuation mechanism, already
  in the tree.
- **`SessionTodo`** (`session/todo.ts`) — a persisted per-session list, the
  sibling shape a goal record follows.

### Prior art, checked against source

`ref/hermes-agent` (MIT) is the closest implementation. Its goal loop
(`hermes_cli/goals.py`) is the model: after each turn an auxiliary-model
judge returns one of four verdicts, and on `continue` the loop appends a
**continuation as a normal user message** — never a system-prompt mutation,
so the prompt cache survives.

Its judge is two pieces, and we originally took only one. The **system**
prompt (`goals.py:113-172`) defines the four verdicts and the discipline that
`BLOCKED` is a refusal, never a completion. The **contract-aware user turn**
(`goals.py:214-236`) carries the rules that make the contract mean something:

- done only when the Verification criterion is satisfied **and** evidence is
  shown;
- a violated Constraint is not done;
- **hitting the stated Stop condition and needing input is `BLOCKED`.**

We copied the first and wrote our own user turn. The stop rule we left behind
is one of the two failures the eval later found (below).

What is not copied: the daemon-side state machine, the cron scheduler, the
profile/multiplex machinery, and the external user-modeling service (Honcho,
a production memory feature, not an evaluation tool). See `ref/README.md`.

### What the eval showed

The loop was run against real models and a real codebase, three times, with a
simulated user driving the session (`evals/goal-loop/`). The judge is not
broken — it caught an agent inventing two semantics the spec never settled and
ruled `blocked` on the contract's own stop condition. But two runs exposed two
holes:

- **The judge accepted a green gate over an unreached outcome.** The contract's
  `Verification` (`bun test && bun run typecheck`) passed while the `Outcome` —
  requests that sit unattended reach the HR manager on their own — was false:
  nothing fired the sweep. The judge asked *did the command pass?*, not *is the
  outcome true?*
- **The judge read `Stop when` as a licence.** The agent hit its own stop
  condition ("the job cannot run without a long-lived server process the repo
  lacks") and the judge let it through — "the no-scheduler boundary permitted
  by the stop conditions" — instead of stopping and asking.

Both anchors it leaned on — `Verification` and `Stop when` — were written by
the agent being judged. That is the structural finding, and it is what the
decision below repairs.

## Decision

### The inner loop is per-session, in the fork

The session owns its own loop: scope, commit, judge, continue. No process
outside the session drives it. deusd **relays and supervises; it does not
drive.**

When the session needs a human decision it *asks*, through the `question`
tool, and deusd relays the question out-of-band and waits. The session pulls
the human in; the daemon never pushes into the loop. This keeps ADR-009's
goal — "ask when stuck works even when nobody is watching" — without making
the daemon the state machine.

### The loop has four phases

**1. Scope.** The human states a goal. The agent reads it and asks about the
rough edges it sees — ambiguities, missing information, assumptions it would
otherwise silently make — through `question`. Ordinary turns; no loop.

**2. Commit.** The agent restates the goal as it now understands it, states
the completion contract (below), and asks for permission to run unattended.
The human's answer is the authorization — and the ratification of the
contract (see "The human ratifies the contract").

The kickoff is a **`goal` tool** the agent calls once scoping is done: it
writes the record — goal, size, contract — and the human's affirmative answer
to the commit question sets `authorized_at`. A tool rather than an overloaded
question, because "I am ready" is a distinct act the agent should take
explicitly, and because the record write and the human's consent stay two
visible steps. Until the tool is called there is no goal, and the session
behaves exactly as it does today.

**3. Work.** The run loop proceeds as today, except that stopping is no
longer the end.

**4. Gate and judge.** When the loop would exit, the contract's gates run
first — a failure short-circuits and its output is the continuation. Only if
the gates pass does a judge decide whether the goal is met, ending the loop or
continuing it.

Scoping and commit are deliberately separate, against ADR-009's preference
for a single gate. They answer different questions — *what* versus
*authorization to spend unattended* — and a human can reasonably want to
clarify without authorizing an autonomous run. The commit gate is the one
that carries a durable permission, which the single-gate shape did not.

### The contract names the outcome, not a command

At commit the agent writes down **how the loop will know the goal is met**.
The contract has five named fields, following Codex's "strong goal" shape,
because the agent, the judge, and the gate runner all read the same thing:

| Field | Meaning |
|---|---|
| **Outcome** | the single end state that must be true when done |
| **Verification** | the specific command that is **evidence** for it — concrete and checkable |
| **Constraints** | what must not change or regress |
| **Boundaries** | files, directories, tools, systems in scope |
| **Stop when** | the condition under which the agent stops and asks instead of pushing on |

Three of these are not criteria, and saying so is the point:

- **`Outcome` is the criterion.** The loop ends when this is true — not when a
  command exits zero.
- **`Verification` is evidence for the outcome, not a substitute for it.** It
  proves the outcome only when the command *exercises* the outcome. A green
  suite over an inert feature is a green suite.
- **`Stop when` is a run condition.** Reaching it means stop and ask — the
  `blocked` verdict — and can never mean done. It belongs to the loop's floor,
  not to the definition of done.

The judge judges against the contract, not against the original prompt. This
is the piece without which "continue until done" has no terminating condition —
the failure ADR-009 names in its own last line: *"the review rubric must be
written down … otherwise 'iterate until pass' has no terminating condition."*

### Quality gates: the contract is executable

A claim of evidence is not evidence. The contract's **Verification** field is
a command — a test, a build, a benchmark, a lint — and the loop runs it at
every turn boundary **before the judge**:

- **A passing gate short-circuits nothing on success and everything on
  failure.** A failing gate is not adjudicated; its bounded output — a tail of
  stdout and stderr — *is* the continuation, so the agent repairs against real
  output rather than a vibe check.
- **Retries are capped.** A gate that keeps failing past the cap stops the
  loop as `blocked`, never `done`. A red suite is not a disagreement to
  adjudicate; it is a fact.
- **Gates run in the session's workspace**, so a relative command checks the
  project the goal is about and cannot pass against a different one.
- **The gate's output is handed to the judge as a fact.** The gate runs in the
  same decision that calls the judge, so its result is fresh by construction —
  there is no window in which a green gate predates the work it certifies.
  What must not happen is the judge reading the *agent's* summary of the check:
  the loop captures the command, its exit code, and its output tail, and hands
  them over. The agent cannot shape it and cannot argue with it.

What a gate does **not** buy: it asks *"does the command pass?"*, not *"is the
outcome true?"* The two coincide only when the command exercises the outcome —
and the agent picks the command. So a green gate is **necessary and not
sufficient**, and the judge must still decide whether the outcome is shown
true, reading the gate's output as evidence rather than as the criterion. An
earlier revision of this ADR claimed "the gate asks *is it true?*, the judge
asks *is it done?*"; the eval showed that division of labour is false.

A goal whose Verification cannot be expressed as a command was not scoped
tightly enough. That is a scoping failure, not a gap in the loop.

### The judging strategy: a thin judge, and floors it cannot talk around

The judge is a reader with no tools: one call per stop, on a configured model
that is not the session's own, reading the goal, the contract, the assumption
ledger, and the last response. It stays thin **on purpose** — it runs often, so
it is cheap and conservative — and what makes it honest is not its cleverness
but the facts standing around it.

The floors, in the order they apply:

1. **The gate.** A failing gate short-circuits the judge; its output is the
   continuation. The judge never sees a false floor.
2. **Freshness.** Green evidence older than the last edit is stale, not
   passed.
3. **The user's ratification.** The contract the judge measures against is not
   the agent's alone (next section).
4. **The budget.** The real backstop. A broken judge must never wedge a run.

And one **escape hatch**, which is not a fifth floor:

5. **An independent reviewer, with tools.** For the question no transcript can
   answer — *is this actually true?* — the loop may hand the work to a separate
   session that opens the artifact, reads the diff, and runs the gate itself.
   It is expensive, so it is not per-stop; it is what a `done` verdict can be
   escalated to. Hermes reaches the same shape (`/review`,
   `agent/review_engine.py`) and states the doctrine: **no agent verifies its
   own work.**

**Prefer a fact over a rule.** Every rule in a prompt is another thing to get
wrong, and the judge is deliberately thin. So hand it something true — a
freshness verdict, a user-ratified verification — before writing more prose.
Prose is for what no fact can express: that done means the outcome is true, and
that a stop condition is a stop.

### The human ratifies the contract at commit

The commit gate means "run unattended". It must also mean **"I agree what done
means"**: the agent shows the `Outcome` and the `Verification`, and the human
confirms them in their own words.

This is the repair for the structural finding. The judge measures the agent
against the contract; the agent writes the contract; so with no human in the
loop the agent supplies its own yardstick — and the run that exposed this had
the agent write a stop condition that later excused the very gap it was
hiding.

Putting the contract in front of the human is cheap: it is one turn, at commit,
where the human is already present, and it is possible **only here** — the loop
has a live user, which upstream's judge-driven loop does not. The `goal` tool's
commit question gains the contract as its content, and the answer records that
the human saw it.

### Task size and the ask rubric

Task size is not lines or minutes. It is **the number and blast radius of
decisions the work requires that the task itself does not determine** — and
those undetermined decisions are exactly what the agent would otherwise ask
about. Size and "when to ask" are one question seen from two sides.

- **Small** — the task determines the work. Zero or one decision.
- **Medium** — a few decisions, all reversible.
- **Large** — many decisions, some irreversible.
- **Huge** — underspecified past enumeration; the agent cannot list the
  decisions.

The size is **self-assessed by the agent at scope**, recorded with a one-line
reason. Self-assessment is deliberate: deciding the size is itself a thinking
step, and writing it down is what makes the rest of the rubric usable. The
human can override.

The largest size has a specific answer: **"this is more than one task."** The
agent recognizes that at scope and proposes a split; it does not discover it
at turn forty. That is where ADR-008's task model earns its place.

#### When to ask

Two axes, not one:

|  | **Reversible** | **Irreversible** |
|---|---|---|
| **Inferable** | Proceed; record the assumption. | Ask, even when certain. |
| **Not inferable** | Proceed with the most likely reading; flag it. | Ask. Always. |

The top-right cell is the one that gets missed. Inferability is not
authority: a decision the agent is sure about still needs a human when the
blast radius is unbounded — a deleted branch, a force-push, a sent message,
money spent.

#### Front-load, do not suppress

Mid-work questions stay rare not by suppression but by moving them earlier:

> **Scope is where you ask. Work is where you don't.**

Every question the agent can resolve at scope, it must. The working phase is
then quiet by construction. This yields a diagnostic: **the frequency of
mid-work questions measures the quality of scope.** An agent that keeps
asking while working scoped badly.

#### Infer from everything, not the task alone

"Infer from the task given alone" is a trap: a genuinely underspecified task
cannot be inferred from its own text, and pretending otherwise produces
confidently wrong work. The rule is to exhaust the sources first, in order:

1. the task text
2. the repo — conventions, `AGENTS.md`, existing patterns
3. the trail — prior sessions
4. the environment — the shared browser: look at the page
5. reasonable defaults

Ask only after all five are exhausted.

#### Size determines what commit produces

| Size | Commit produces |
|---|---|
| Small | a one-line completion criterion |
| Medium | a short checklist |
| Large | subgoals and a verification gate |
| Huge | a proposed decomposition — approve the split, not the details |

The agent can proceed at any size; what changes with size is what it asks for
at commit.

### The scratchpad

The agent keeps a **per-session scratchpad**: a markdown file, the mechanism
`Session.plan` already uses (`session/session.ts:331`), generalized from the
plan to the working state.

It is a file rather than a message because that buys three things:

- **It survives compaction.** `compaction.ts` prunes the message history; a
  file is untouched. A long run keeps its bearings instead of losing them
  when the context overflows.
- **It is cheap to re-read.** The agent reads its own distillation instead of
  forty turns of transcript, which is what lets it stay oriented without
  re-deriving — and that is how mid-work questions stay rare.
- **It is the review surface.** The judge reads the scratchpad rather than
  the whole conversation; the human reads it at `done` or `blocked`.

And a fourth that is easy to underrate: **writing it is thinking.** Naming
the size and the assumptions forces explicitness the model would otherwise
skip. The scratchpad is not a record of the reasoning; it is the reasoning,
made visible.

Sections, so all three readers can scan it:

- **Goal** as understood, not as originally typed
- **Size**, with the one-line reason
- **Completion contract**
- **Assumption ledger** — every inference acted on
- **Subgoals and progress**
- **Open questions** — asked, awaiting an answer
- **Decisions and rationale**

It is **generously sized on purpose.** A tight field forces compression and
loses the nuance that makes it worth keeping.

**The assumption ledger is what makes minimal questions safe.** Every
inference the agent acts on is recorded; the ledger is surfaced at `done` and
on any `blocked`. The human reviews the bets, not every step.

#### Injection

The scratchpad is referenced by path and read on demand, which keeps it out
of the prompt — and out of the cached prefix — unless it is needed. It is
injected in exactly two places: **after compaction**, to restore bearings,
and **at judge time**, as the contract and assumptions the judge decides
against.

#### The plan file folds in

The scratchpad subsumes plan mode's plan file: "the plan" becomes the
subgoals section. This touches plan mode and is named here rather than folded
in silently.

### The judge returns one of four verdicts

Following `goals.py`:

- **`done`** — the **outcome** is shown true, with the gate's evidence. Not
  "the command passed": a green gate whose command does not exercise the
  outcome does not establish done. Requires the deliverable to exist; an
  explanation of why the goal cannot be reached is `blocked`, not `done`.
- **`blocked`** — genuinely unachievable, the next step needs a human, **or the
  agent reached the contract's stop condition**. The loop routes it to the
  `question` tool, so the human is asked rather than the run simply ending. The
  mechanism is the synthetic continuation: the loop appends the judge's reason
  and instructs the agent to ask, so the question still comes from the agent's
  own tool rather than the loop calling it. See the next section for how this
  differs from the agent asking on its own.
- **`continue`** — not done, and there is a concrete next step. The default
  when in doubt.
- **`wait`** — not done, but progress is gated on async work (a subagent, a
  build, the shared browser mid-navigation). Parks the loop without burning
  a turn; it resumes on the event or the timer. This verdict matters more
  here than upstream because the session browser and subagents both run
  asynchronously. The park is a **barrier** — a pid, a session, or a deadline
  — and the loop re-enters when the barrier releases. While parked, the loop
  consumes neither a turn nor a judge call.

The judge reads the contract, the last response, and the assumption ledger —
never the whole transcript. It decides against the **outcome**, with the gate's
output as the evidence it must see *shown*: a response that claims done without
showing evidence is `continue`, never `done`.

### How we see the judge work

The judge's behaviour cannot be unit-tested. A parser test proves the code
reads `blocked`; it cannot prove the judge *recognises* one. So the loop is
watched by an eval: a simulated user driving a real session against a real
codebase (`evals/goal-loop/`).

It is an **observatory, not a score**. The artifact is the transcript; the
grader's rubric is its attention list, not a number to optimise; and the
coverage is a handful of runs. What it produces is a corpus of user-versus-
agent stories and the patterns across them. Both failures above were found
that way, and neither could have been found any other way.

### The agent may ask at any point, and asking is not a failure

Scope is not the only time the agent may pull the human in. While working it
may call `question` whenever it is **unsure**, or has reached a **state it
cannot judge alone** — an ambiguous requirement, a decision bigger than the
task, a choice between two reasonable paths, a missing credential, a page it
cannot interpret, a destructive action it should not take unilaterally.

This is deliberately distinct from the judge's `blocked` verdict, and both
are kept, following ADR-009's own split:

- The `question` tool is **agent-initiated**: the agent recognises that a
  decision is too big and asks, live.
- The judge's `blocked` is **loop-initiated**: the transcript shows the goal
  cannot proceed, whether or not the agent thought to ask.

The second exists because of the first's blind spot. An agent that does not
know it should ask — silently hung, or confidently wrong — will never call
the tool. The judge reads the same transcript from outside and can catch what
the agent missed. Neither replaces the other.

When the agent asks, the loop **parks**, as `wait` does, and resumes on the
answer. It does not burn the turn budget while waiting, and it does not guess
to keep moving. The answer is appended as the next user message, so the
cache-safe continuation rule holds for answers as it does for continuations.

Under an unattended run the question is relayed out-of-band by deusd and the
loop waits for it. A human answering can also take the wheel in the shared
browser — it is the same session, and that is the point of the shared
surface.

### The continuation is a synthetic user message

On `continue`, the loop appends a new user message carrying the continuation
and marks it synthetic, the `reminders.ts` convention. It never mutates the
system prompt and never rewrites past context, so the prompt cache survives —
the invariant that makes a long autonomous run affordable rather than
ruinous.

### The loop has a floor

A turn budget, configured per goal, is the backstop. When it is spent the
loop stops and hands back to the human with the contract's remaining gaps
stated.

A single judge failure is **fail-open** (continue), because a broken judge
must not silently end a run that was still working. Fail-open alone, though,
lets a permanently broken judge burn the whole budget, so there is a
**circuit breaker**: consecutive parse failures (the model will not return
the JSON verdict) or consecutive transport failures (an unreachable API)
stop the loop and hand back with the judge configuration named. Tolerate a
blip; do not tolerate a misconfiguration forever.

### The goal is persisted on the session

The goal, the contract, the authorization, the turn count, and the last
verdict are recorded against the session, so a reconnect or a restart does
not lose an authorized run. This is session-local state, not a task — the
task is manus-dei's, per ADR-008.

### The judge model is configurable, and not the session's own

The judge is a model call, and an extra one per stop. It uses a configured
judge model, **not the session's own by default**: the failure this loop
exists to catch is the agent that is confidently wrong about its own work, and
a model grading itself is the weakest possible check on exactly that.
`goals.py` reaches the same conclusion — its judge runs on an `auxiliary`
model, never the agent's. The judge is configurable and is **off unless a goal
exists**; a session with no goal behaves exactly as it does today.

## Consequences

- **The fork diverges further from upstream.** This is real and is the
  cost of the decision. It is the right divergence: autonomy is what makes
  the session an agent, and the fork is the agent runtime.
- **A new model call per stop** while a goal is active — not per turn. The
  judge runs where `runLoop` would exit, when the model stops with no pending
  tool calls, so a productive run with many tool calls invokes it once.
  Bounded by the budget; absent when no goal is set.
- **The contract's `Verification` becomes an executable gate, and the gate is
  necessary and not sufficient.** It runs at every turn boundary before the
  judge, and a failure short-circuits with the command's output. But a green
  gate proves the command, not the outcome, and the judge must still decide
  whether the outcome is shown true. This is what keeps the judge a text-only
  reader — and the eval showed the limit of that.
- **The judge is handed the gate's own output.** No new persisted state and no
  migration: the gate runs in the same decision as the judge, so freshness
  needs no record. The contract is that the judge reads the captured result,
  not the agent's account of it.
- **The commit gate now means two things.** "Run unattended" *and* "I agree
  what done means". One extra confirmation at a step where the human is already
  present; it is the only place the agent's self-written yardstick can be
  checked by the person who wants the outcome.
- **An independent reviewer becomes possible, and optional.** A tool-using
  session that checks the artifact rather than the transcript, for escalating a
  `done` verdict. New cost, off by default; the loop does not need it to
  function.
- **The judge's prompt changes.** `done` keys on the outcome, not the
  verification command; hitting the stop condition is `blocked`. Both are pure
  string changes in `packages/core`, so the parser tests stay green and only
  the eval can say whether they moved behaviour.
- **A new persisted record** on the session, and a migration with it.
- **A new per-session artifact**, the scratchpad, written and read on every
  authorized run. Its content is the agent's, not a schema, so it can evolve
  without a migration.
- **Plan mode's plan file folds into the scratchpad.** A change to plan mode,
  and the reason the two are not allowed to drift apart.
- **The `question` tool becomes load-bearing for unattended runs.** Its
  out-of-band relay is manus-dei's work, not the fork's.
- **The shared browser gains an obvious use**: a human can watch an
  authorized run and take the wheel mid-pursuit without stopping the loop.
- **The eval is the loop's only instrument for the judge.** It is not CI: it
  costs real calls, its numbers are not a verdict, and its value is the
  transcript. Keep it small.
- **Tests.** The verdict parser, the contract handling, the gate runner, the
  freshness check, and the budget are pure functions and are unit-tested. The
  loop's continuation path is tested against a fake judge, asserting the prompt
  cache prefix is unchanged across a continuation — the invariant, not a
  snapshot. The gate runner is tested against a command that passes and one
  that fails, asserting a failure short-circuits the judge and carries the
  output tail.

## Out of scope

No daemon-side loop, no cron, no scheduler. No per-step human approval. No
budgets *enforcement* beyond the turn cap (manus-dei ADR-009 defers spend
caps; the field is not retrofitted here). No cross-session memory or skill
self-improvement — those are separate decisions. No navigation allowlist and
no new external service. No change to the human's RFB transport.

The outer loop, the task state machine, the process-level stuck-detector,
and the notification relay are manus-dei's and are untouched by this ADR.
