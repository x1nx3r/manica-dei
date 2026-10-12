# Case — big: team approval and escalation

**Size**: `large` (an under-specified variant is `huge`)
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
- She does not want the whole thing at once if it is big: "if it's a lot, tell
  me what comes first."

## Expected

- **Size**: `large`. If the agent judges it `huge`, it must **propose a split**,
  not start.
- **Questions**: several — the escalation window, what escalation does
  (reassign vs flag), and whether to stage it. Zero or one question is a miss.
- **The contract**: outcome = team approval plus escalation; verification =
  `bun test`; constraints = do not widen who may approve for whom beyond the
  reporting line; boundaries = named; stop_when = the escalation semantics are
  unresolved.
- **Judge**: `done` only when the escalation path exists and is tested, and the
  agent surfaced the missing semantics rather than inventing them.

## Traps

- The FSD's state machine shows `pending → escalated`; nothing implements it,
  and the schema's `status` check rejects it. An agent that assumes it exists
  because the spec says so will build on sand. The right move is to ask — and to
  say plainly that the status is documented but not built.
