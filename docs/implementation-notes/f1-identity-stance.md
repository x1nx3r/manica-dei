# F1 — identity context and the session stance

Implements: `PLAN.md` F1 item 8; manus-dei `docs/implementation-notes/phase-2/tasks.md` task 3
Feeds: the goal loop's SCOPE phase (`docs/adr/0006-goal-loop.md`)

## The decision this note records

F1.8 reaches the model through the **V1** system prompt, not the V2
`core/system-context/` sources that `PLAN.md` names. The fork is mid-migration:
the server's session handler (`handlers/session.ts`) yields `SessionPrompt` (V1)
and runs `promptSvc.loop(...)` → `session/prompt.ts:1088`, while the V2 runner
(`core/session/runner/llm.ts`) is wired through `SessionExecution` but is not
the server's session path. A source registered in `core/system-context/` is
read by the V2 runner only, so it would not reach a live session. F1.8 lands in
V1 now and moves to `core/system-context/` when V2 takes over.

The **stance** is a shared injection point, not an edit to the 14 per-family
`session/prompt/*.txt` files. Those files are one per model family
(`default`, `anthropic`, `gemini`, `gpt`, `codex`, `kimi`, `meta`, `trinity`,
…), and the product's model resolves to one of them — so a txt-only stance
would apply to one family and drift the moment a family is added. One shared
block, every family.

## What is built

**The identity fields.** deusd injects three at summon
(`internal/app/usecase/summon/implement.go:168-170`):

| Env | Field |
|---|---|
| `MANUS_USER_NAME` | the person's name |
| `MANUS_USER_GITHUB` | their GitHub handle — whose account the work lands under |
| `MANUS_USER_ROLE` | a human-readable role |

The fourth field, time, comes from the clock, as the summon comment says.

**A pure module, `packages/core/src/identity.ts`.**

- `fromEnv(env)` → `Identity | undefined`. Undefined when no name is present,
  so a stock opencode session is untouched.
- `render(identity, time)` → the model-visible block: who the person is, the
  time, and the stance.

Pure on purpose: it is the whole feature's logic, and it is testable without a
model, a session, or a renderer.

**The V1 injection.** `SystemPrompt.identity()` (`session/system.ts`) reads
`process.env`, calls `fromEnv` + `render`, and the result joins the system
array at `session/prompt.ts:1264` — the same place `environment`, `skills`, and
`mcp` already are. Absent env → `undefined` → no block, no stance.

## The stance

> Greet the person by name. Read this repository's own standards — `AGENTS.md`,
> `opencode.json`, `.opencode/` — before acting. Ask what to work on before
> diving in, and hold that stance for the whole session.

This is the goal loop's SCOPE behavior: when the loop lands, "ask what to work
on" is what the agent does before the `goal` tool is called. F1.8 is the
prerequisite because a loop cannot scope well if the agent's default is to dive
straight in.

## Tests

`packages/core/test/identity.test.ts` — pure:

- all three env vars present → a block naming the person, their GitHub, their role
- no name → `undefined` (a stock session gets nothing)
- partial fields → only the present ones render
- the time appears
- the stance text is present
- `render` is stable for the same input (no clock read inside)

## Not built

- No V2 `core/system-context/` source; it lands with the V2 runner.
- No edit to the per-family `prompt/*.txt` files.
- No goal loop — F1.8 is its prerequisite, not part of it.
