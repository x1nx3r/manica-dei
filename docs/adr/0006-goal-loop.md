# ADR-0006: The session's goal loop

Status: proposed · Date: 2026-10-05
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
so the prompt cache survives. Its judge prompt (`goals.py:113-172`) is worth
copying almost verbatim, including the discipline that `BLOCKED` is a
refusal and never a completion.

What is not copied: the daemon-side state machine, the cron scheduler, the
profile/multiplex machinery, and the external user-modeling service. See
`ref/README.md`.

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
The human's answer is the authorization.

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

### The completion contract is the terminating condition

At commit the agent writes down **how the loop will know the goal is met**.
The contract has five named fields, following Codex's "strong goal" shape,
because the agent, the judge, and the gate runner all read the same thing:

| Field | Meaning |
|---|---|
| **Outcome** | the single end state that must be true when done |
| **Verification** | the specific command that **proves** it — concrete and checkable |
| **Constraints** | what must not change or regress |
| **Boundaries** | files, directories, tools, systems in scope |
| **Stop when** | the condition under which the agent stops and asks instead of pushing on |

The judge judges against *that*, not against the original prompt. And
**Verification is not prose — it is the gate** (next section). This is the
piece without which "continue until done" has no floor — the failure ADR-009
names in its own last line: *"the review rubric must be written down …
otherwise 'iterate until pass' has no terminating condition."*

### Quality gates: the contract is executable

A claim of evidence is not evidence. The contract's **Verification** field is
a command — a test, a build, a benchmark, a lint — and the loop runs it at
every turn boundary **before the judge**:

- **A passing gate is the evidence.** The judge no longer decides whether the
  work is real; the command decided.
- **A failing gate short-circuits the judge entirely.** Its bounded output —
  a tail of stdout and stderr — *is* the continuation, so the agent repairs
  against real output rather than a vibe check.
- **Retries are capped.** A gate that keeps failing past the cap stops the
  loop as `blocked`, never `done`. A red suite is not a disagreement to
  adjudicate; it is a fact.
- **Gates run in the session's workspace**, so a relative command checks the
  project the goal is about and cannot pass against a different one.

This is what makes the judge affordable and honest. The judge is a **reader,
not a verifier**: it checks that the Verification criterion is satisfied and
that the evidence is *shown* in the response. It never needs tools and never
trusts a claim, because a false claim fails the gate before the judge is
called. The two layers answer two questions — the gate asks *"is it true?"*,
the judge asks *"is it done?"*

A goal whose Verification cannot be expressed as a command was not scoped
tightly enough. That is a scoping failure, not a gap in the loop.

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

- **`done`** — the contract is satisfied, with evidence. Requires the
  deliverable to exist; an explanation of why the goal cannot be reached is
  `blocked`, not `done`.
- **`blocked`** — genuinely unachievable, or the next step needs a human.
  The loop routes it to the `question` tool, so the human is asked rather
  than the run simply ending. The mechanism is the synthetic continuation:
  the loop appends the judge's reason and instructs the agent to ask, so the
  question still comes from the agent's own tool rather than the loop calling
  it. See the next section for how this differs from the agent asking on its
  own.
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
never the whole transcript — and decides against the **Verification**
criterion, requiring the response to *show* the evidence the gate produced.
It is a reader: a response that claims done without showing evidence is
`continue`, never `done`.

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
- **The contract's Verification becomes an executable gate.** The loop runs it
  at every turn boundary before the judge, and a failure short-circuits the
  judge with the command's output. This is what lets the judge stay a
  text-only reader, and what catches the confidently-wrong run the judge
  alone cannot.
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
- **Tests.** The verdict parser, the contract handling, the gate runner, and
  the budget are pure functions and are unit-tested. The loop's continuation
  path is tested against a fake judge, asserting the prompt cache prefix is
  unchanged across a continuation — the invariant, not a snapshot. The gate
  runner is tested against a command that passes and one that fails,
  asserting a failure short-circuits the judge and carries the output tail.

## Out of scope

No daemon-side loop, no cron, no scheduler. No per-step human approval. No
budgets *enforcement* beyond the turn cap (manus-dei ADR-009 defers spend
caps; the field is not retrofitted here). No cross-session memory or skill
self-improvement — those are separate decisions. No navigation allowlist and
no new external service. No change to the human's RFB transport.

The outer loop, the task state machine, the process-level stuck-detector,
and the notification relay are manus-dei's and are untouched by this ADR.
