# 0008 — the loop's roles are sessions

Status: proposed. Read with 0006.

## Context

The loop has three roles — the dev, the reviewer, the judge — and a user at the
two ends. Where each of them can be seen today:

- **The dev** is visible because it *is* the session. Its transcript is the
  surface, and the loop appears in it as its shadows: the synthetic notes —
  *"[Continuing toward your standing goal — QA tested this, and it failed]"* —
  written in the dev's voice, unstructured, and only when the loop acts.
- **The reviewer** runs as a child session through the task tool
  (`packages/opencode/src/session/prompt.ts`, `runQa`), so it has a transcript
  and an id. But what it *produces* — the record, one JSON blob in its last
  message — is parsed out and never stored as data, and the loop **deletes** it
  from the goal the moment the judge weighs it.
- **The judge** is invisible everywhere. `session/goal-judge.ts` streams from
  `LLM` directly, so the call is attributed to the session for cost and nothing
  else exists: no session, no message, no event.
- **The phase** (`dev | qa | judge`) and the whole goal row are reachable from
  nothing: there is no goal route, and nothing in `goal.ts`, `goal-loop.ts`, or
  `goal-gate.ts` publishes an event.

One of those is worse than a gap. 0006 says the record is **what the human reads
at handoff** — *"it is the thing that makes 'no contradiction found' mean
something"*. The loop clears it, and nothing keeps a copy. The handoff currently
has nothing to read.

## Decision

**A role that produces something is a session.** Both the reviewer and the judge
become sessions of the same store: created through the session model, parented to
the session under test, running the hidden agent for their role, with their own
id, their own transcript, and their own lifecycle. The judge stops being a bare
model call and becomes a session whose single reply is a real message. Nothing
about the roles' *duties* changes; what changes is that each has a body.

**What a role produces is data, not prose.** A pass's record and a judgement's
verdict become typed parts on the message that carries them, reusing the schemas
that already exist — `SessionGoal.Record`, and the judgement's verdict and
handoff from `core/session/goal/judge.ts`. The part kind belongs in the **current**
message contract, not `packages/schema/src/v1/session.ts`; V1 is on its way out
and new code must not depend on it. A UI renders a table of probes because the
probes are fields, not because it parsed a sentence.

**The transcript is the history, inside the run.** Records and verdicts are not
consumed. The goal row keeps the *live* state — the phase, the turns, the budget,
the working record — and the durable evidence *in the container* is the sessions.
This repairs the handoff inside opencode: the reviewer's passes and the judge's
judgements are still there at the end, in order, with their inputs. What carries
them *across* the seam is the next item, and it is not the same thing.

**The phase is on the wire.** Two things, and both are needed:
A fetchable projection (`GET /session/:id/goal`: phase, contract, budget, turns,
last verdict) for a client that arrives late; and events (`goal.phase` on every
transition, `goal.verdict` on every judgement) on the existing bus, because
deusd's harvest reads `/event` and the trail is where manus-dei shows this.

**The events carry the substance, not a pointer.** A pass or a judgement is
announced with its payload: the record, the verdict, the reason, the round, the
role. The consumer of the trail is not necessarily able to call back — the
container is temporary and the registry is not — so an event that says *"a review
happened, ask for it later"* is not a handoff. Session references ride along, for
a client that can still reach them.

**The user stays at the ends.** This adds no mid-run control. The role sessions
are read-only views of work already done, and the hidden agents stay hidden from
the agent picker: they are sessions, not agents a person summons.

---

## The seam, and who owns what

Two products read this, and they have different lifetimes. The sessions live in
the container's SQLite and die with the container. manus-dei's `session_events`
live in deusd's registry and are append-only. So:

- **the sessions are the working surface** — live, navigable, drillable, for a
  client that is present;
- **the trail is the handoff** — durable, in the registry, for the record.

The seam is the documented API and nothing else. From the one session id a caller
already holds:

| call | gives |
|---|---|
| `GET /session/:id/goal` *(new)* | the contract, the phase, the budget, the turns |
| `GET /session/:id/children` | the reviewer and the judge sessions |
| `GET /session/:child/message` | their transcripts and typed outputs |
| `GET /event` | the live trail |

Four things make the handoff easy, in order of importance:

1. **Self-sufficient events.** `goal.review` carries the record; `goal.verdict`
   carries the verdict, the reason and the handoff. A consumer that stores the
   trail needs no second call and no live container.
2. **A stable role key**, reusing the three words 0006 already defines —
   `dev | qa | judge`. Not the agent name: `goal-qa` is an implementation detail
   no client should have to know.
3. **The round**, on both the event and the role session, so a run reads in
   order: which pass, which contradiction, which verdict closed it.
4. **Role-attributed spend.** Making the judge a session gives every role its own
   tokens and dollars on its own row — the same rows the eval reads for cost.

One boundary: **nothing manus-dei-shaped in the core.** The surface stays
sessions, parts and events, so a second consumer needs no change and a change to
manus-dei's UI reaches nothing here.

## Consequences

**The UI (the second side).** Once the state is on the wire, the run's shape is
navigable: the dev session with its reviewers and judgements beneath it, a phase
chip that says which role is acting, a review card at each pass, a verdict card
at each judgement, a goal panel with the contract and the budget, and a handoff
view that is simply the run read from the end. In the fork's own surfaces that is
the session view; in manus-dei it is the trail and the handoff, and neither needs
a special case, because both read the same documented surface.

**The eval gets simpler and stronger.** The harness stops parsing the last
message of a child session to find a record; it reads the typed part. The `review`
action we built for the grader becomes a projection of stored data.

**Cost.** One session per judgement, in addition to one per pass. The judge has
no tools and takes no snapshot, so it is one prompt and one reply, bounded by the
turn budget.

**Risks.** Session proliferation — bounded by the budget, and visible if it is
not. A schema addition that must land in the current contract without dragging V1
along. Events that must be declared in the protocol manifest, or the SDK and the
UI cannot subscribe.

## Open

- The name and shape of the part kind that carries a record or a verdict.
- Whether the phase lives on the goal or the session. My lean is both: the goal
  owns it, the session exposes it.
- Whether a judgement needs its own transcript at all, or a one-message session
  is enough ceremony. My lean is that one message is enough, and the point is
  that it exists.
