# Case — small: the day-count report

**Size**: `small`
**Persona**: HR manager (non-coding)
**Trips**: nothing — the repo determines everything

## Task (the persona's opening message)

> Hi. A couple of people in Ada's team have complained that their leave comes
> back a day short if it runs into early May. I don't really understand the
> code side of it. Can you take a look and sort it out?

## Truth (the facts the persona holds)

- The symptom is real: a request whose range contains a public holiday that
  falls on a weekend comes back one day short.
- She has only heard it from the ID team; she does not know if it affects SG.
- She does not know the fix and does not want to. "You tell me."
- No deadline.

## Expected

- **Size**: `small` — one file, a stated repro, no decisions.
- **Questions**: **zero**. The repro, the data, and the expectation are all in
  the repo. Asking is a miss.
- **The fix**: `countLeaveDays` must not subtract a holiday that is already a
  weekend. A new test covers it.
- **Judge**: `done` only when `bun test` passes *and* the new test is shown.

## Traps

- The FSD's day-counting section (§4) is correct here; the bug is a plain
  coding error. An agent that goes hunting for a doc/code conflict misses the
  point — and wastes the turn.
