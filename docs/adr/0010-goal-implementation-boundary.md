# ADR-0010: The authorized goal is the implementation boundary

Status: accepted · Date: 2026-10-25
Builds on: ADR-0006 (the goal loop), ADR-0015 (the session is the loop; manus-dei)
Fixes: issue #28 — an agent finished scoping, received approval, and started
implementation (`todowrite`, reads) before setting a goal; the human had to ask
"Uh didn't you setup a goal?"

## Context

The goal is the authorization and the audit boundary. Work done before it is
outside the contract, the gate, the QA pass, and the judge. The goal loop does
not retroactively certify prior work, so starting implementation first makes the
first round ambiguous.

Both the goal tool description and the identity prompt already say to set the
goal when the work is agreed, before implementation. The `carbon-go-stack` run
showed that instruction alone is not enforcement. Nothing in the harness
prevented `todowrite` and the first reads-and-write pass; the model narrated
"starting implementation" and only set the goal after the human interrupted.

Scoping must remain possible without a goal: reading the repository, searching,
asking questions, researching, and writing the ADR that records the decision are
all pre-goal work. The boundary is between **scoping** and **implementation**,
and it has to be deterministic.

## Decision

### Scoping is the state of a session, not an instruction

When `goal.required` is enabled, a session is **scoping** until its goal row
exists and is authorized. The harness enforces that state at the tool execution
point, not in the prompt:

- `SessionTools.resolve` builds the executor for every production tool,
  including MCP servers and the model-swapped patch tool. The check runs
  immediately before `item.execute`, before the tool's own side effects and
  before the `tool.execute.before` plugin hook.
- The goal is read from the **root session** (walk `parentID`), because a
  `task` child has no goal row of its own. A subagent's work is the root's work,
  and its writes are gated by the same boundary.
- The check runs per tool call, not once per model step: the agent may authorize
  a goal and continue working in the same turn.

The gate is additive. It never grants a permission the agent would not otherwise
have; it only refuses a tool the session is not yet allowed to use. The normal
permission rules still apply after it.

### The boundary

A tool is allowed before authorization when it only reads, observes, asks, or
records the goal; conditional when it writes a scoping artifact; refused
otherwise.

| tools                                                              | before authorization                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `read`, `glob`, `grep`, `list`, `lsp`, `skill`, `question`, `goal` | allowed                                                                                                                |
| `webfetch`, `websearch`, `browser`                                 | allowed — research does not mutate the workspace                                                                       |
| `task`                                                             | allowed — the child session walks to the same root goal, so its tools are gated                                        |
| `bash`                                                             | allowed — deliberately (see below)                                                                                     |
| `plan_enter`, `plan_exit`                                          | allowed                                                                                                                |
| `edit`, `write`                                                    | allowed only when every target is under `docs/adr/`, `.opencode/scratchpads/`, or `.opencode/plans/`                   |
| `apply_patch`                                                      | the same path rule, read from the patch's hunks (the registry uses this tool instead of `edit`/`write` on some models) |
| `todowrite`                                                        | refused — a task list is a commitment to implementation                                                                |
| `mcp:*`, `execute` (code mode), unknown tools                      | refused by default                                                                                                     |

`bash` is the deliberate hole. Scoping needs `git log`, `ls`, and quick shell
inspection; the shell is also the one surface a parser cannot make sound
(redirects, `sh -c`, `$(…)`, `sed -i`). The product accepts that a change made
through the shell before authorization is outside the contract and the review.
The rest of the gate, the goal tool description, and the prompt tell the model
that implementation starts at authorization, not at the first command.

`browser` is exempt for the same reason as research: it can change a website,
not the workspace.

### The refusal is a tool error

A refused tool returns a model-facing error, not a permission question. The
human should not be asked to approve implementation work that the contract does
not cover yet. The message names the next act:

- no goal: "Refused: implementation needs an authorized goal. Scoping tools
  (`read`, `glob`, `grep`, `question`), shell commands, and ADR writes under
  `docs/adr/` are allowed. Set the goal with the `goal` tool and ask the human to
  authorize it, then continue."
- set but unauthorized: "Refused: the goal is set but not authorized. Ask the
  human to confirm the outcome and the check that proves it, then call the
  `goal` tool again with `commit: true`."
- a write outside the scoping paths: "Refused: before the goal is authorized,
  files may be written only under `docs/adr/`, `.opencode/scratchpads/`, or
  `.opencode/plans/`."
- `todowrite`: "Refused: a task list is implementation; set and authorize the
  goal first."

### The flag

`OPENCODE_GOAL_REQUIRED` (RuntimeFlags, default `false`). The manus base image
sets it to `true`, so every fleet session starts on this boundary. The default
stays off so a plain `opencode` chat, the CLI, and the test suite keep their
existing behavior; the product turns the boundary on deliberately.

### Keeping the table honest

The classification is an allow-list. A tool that is not named is refused, so a
new tool cannot slip through by being forgotten. A unit test enumerates the
registry's built-in tool ids and asserts each has a classification; MCP ids are
matched by prefix.

## Consequences

- **The boundary is deterministic.** The `todowrite` in the trace fails, the
  model reads the refusal, and it sets the goal before the first implementation
  step. No human interruption is required to enforce the process.
- **Shell is an explicit exception, not an oversight.** It is recorded here so a
  later reader does not "fix" it by blocking `git log`, and so a future
  read-only shell mode is a deliberate extension rather than a surprise.
- **MCP tools are refused until authorization**, including read-only servers.
  The MCP `annotations.readOnlyHint` is the natural later refinement; v1 keeps
  the default sound.
- **Scoping artifacts are limited to the paths the product names.** ADRs,
  scratchpads, and plans. A docs change outside `docs/adr/` waits for the goal.
- **Subagents inherit the root boundary.** A `task` child cannot launder a write
  the root is not authorized to make.
- **The flag makes the boundary a product decision.** With it off, the fork
  behaves as it did before this ADR.

## Out of scope

- The scoping chip in the goal panel ("no goal yet"). The refusal is visible in
  the transcript; the chip is a legibility improvement, not the enforcement.
- A read-only shell mode. The shell stays unblocked, as above.
- `readOnlyHint` handling for MCP servers.
- Re-authorization when an existing goal is re-set. `goal.set` currently keeps
  `authorized_at` on the conflict path, so a new goal after a finished run is
  implicitly authorized. The boundary is only as strong as the authorization;
  this is a follow-up to decide with the goal tool's own lifecycle.
- Revoking authorization when a run reaches `done` or `blocked`.
