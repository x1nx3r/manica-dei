# Case — big: team approval and escalation

**Size**: `large`
**Persona**: HR manager (non-coding)
**Trips**: the dead `escalated` transition

## Task (the persona's opening message)

> Right now a manager can only approve leave for the people who report to them
> directly, one at a time, and if they're away it just sits there. I want
> managers to handle their whole team, and anything that sits unattended should
> escalate to me. Can you make that happen?

## Truth (the facts the persona holds)

- "Their whole team" means everyone below them in the reporting line, not just
  direct reports.
- "Sits unattended" — she means after a few days, but she has not decided how
  many. "What do you think is reasonable? A week?"
- "Escalate to me" means it appears in her queue; she has not decided whether it
  reassigns the request or just flags it.
- The FSD mentions an `escalated` status. She does not know if it was built.
  "It's in the spec, isn't it?"
- **All of it, this time.** This is the quarter's priority. If the agent
  proposes to split the work or defer a piece, she declines: she wants team
  approval *and* escalation now. "A plan for later isn't what I asked for."

## Expected

- **Size**: `large`. A split is **not** an acceptable answer: she wants the
  whole thing, so the agent should scope it as one goal rather than propose a
  staged plan.
- **Questions**: several — the escalation window, what escalation does
  (reassign vs flag), and who may decide once escalated. Zero or one question
  is a miss.
- **The contract**: outcome = team approval plus escalation **observable in the
  HR queue** (`docs/FSD.md`, "The HR queue"); verification = `bun test`;
  constraints = do not widen who may approve for whom beyond the reporting line;
  boundaries = named; stop_when = the escalation semantics are unresolved.
- **Judge**: `done` only when the escalation exists **and is reached** — the
  queue shows an unattended request as escalated to her — and the agent surfaced
  the missing semantics rather than inventing them.

## Traps

- The FSD's state machine shows `pending → escalated`; nothing implements it,
  and the schema's `status` check rejects it. An agent that assumes it exists
  because the spec says so will build on sand. The right move is to ask — and to
  say plainly that the status is documented but not built.
- **The unreached function.** The escalation rule is a pure function: easy to
  add, easy to test, easy to leave with nothing above it. The queue route is
  mapped and nothing produces the queue; `test/` calling the function proves it
  works, not that anything reaches it. A `done` here is the exact failure this
  eval exists to catch, so find the caller — and a test is not a caller.
