# The app joins the current contract

A plan, not a decision. It exists because ADR-0008's step 4 hit a wall that is not
about the goal loop, and the wall will stop the next addition too.

## Why this exists

Step 4 needed the app to render two new message parts, `goal.review` and
`goal.verdict`. It renders them — through **one documented cast** that the linter
already flags — because the app does not consume this repository's client. It
consumes a vendored tarball:

```
packages/app/package.json:57        "@opencode-ai/client": "file:vendor/opencode-ai-client-1.17.13-v2.tgz"
packages/session-ui/package.json:41 "@opencode-ai/client": "file:../app/vendor/…-1.17.13-v2.tgz"
```

So every future contract addition arrives the same way: by hand, through a cast,
or not at all.

## The two worlds

The app speaks the **V1 surface**; the workspace client speaks the current one.
They are not the same interface, and the differences are not cosmetic:

| | the app (vendored tarball) | `packages/client` (workspace) |
|---|---|---|
| entrypoints | `.`, `/promise`, `/effect` (built `dist/`) | `.`, `/effect` (TypeScript source) |
| type names | domain — `SessionApi`, `SessionInfo`, `FileDiffInfo` | endpoint — `SessionsListOutput`, `SessionsPromptInput` |
| events | `session.tool.*`, `session.agent.selected`, `session.text.*` | `session.next.tool.*`, `session.next.agent.switched`, `session.next.text.started` |
| tool state | `state.metadata`, status `"streaming"` | `state.structured`, status `"pending"` |
| groups | `mcp`, `catalog` and endpoints `command`, `shell`, `rename`, `remove`, `fork` | not present |

That last row is the one that decides the size: **the workspace client is not a
superset.** The app calls `api.mcp.list/connect/disconnect`, `api.mcp.resource.catalog`,
and the command, shell, rename, remove and fork endpoints. The current protocol API
does not declare them (`packages/protocol/src/api.ts:38-55`), even though the
server still has an MCP route group.

## What is already settled

- **No published client is needed.** `packages/client` is `"private": true`, has no
  version, and is absent from `scripts/publish.ts`. CI builds the UI bundle inside
  the workspace (`bun install --frozen-lockfile`, then `vite build` in
  `packages/app`, then embeds `dist` into the binary). Nothing pulls a published
  client, so the vendoring is an import artefact.
- **The build pattern is proven.** The app already consumes six `workspace:*`
  dependencies that export raw TypeScript source — `ui`, `session-ui`, `core`,
  `schema`, `protocol`, `sdk/v2` — under Vite, Bun's test runner and `tsgo`.
- **The tool-state divergence is small.** Four active accessors read `metadata`
  (`packages/app/src/utils/session-message.ts:376,386,411` and
  `context/server-session-v2-reducer.ts:315`), and **the `structured` replacement
  already sits in a comment on the line above each one**. Four `"streaming"` →
  `"pending"` renames, two provider-field renames. Fifteen to twenty-five lines.

## The size

- **Imports and type names**: 46 statements across 42 files (37 in `app`, 5 in
  `session-ui`). One bare import, 45 through `/promise`. Each needs a specifier
  change *and* a name remap, because the workspace `.` is neither `/promise` nor
  those names. Estimate 120–200 lines, and the types ripple into the values used
  at those sites.
- **The event layer, which is the bulk.** `server-session-v2-reducer.ts` (509
  lines, ~30 switch cases), `server-session.ts` (`applyV2`, `:946-983`),
  `server-sdk.tsx` (`CurrentDelta`), `server-compat.ts` (built end to end on the
  tarball's shapes). Several hundred lines across roughly six files.
- **The missing surfaces**: either the protocol regains them or the app keeps a
  fallback for them. Additional work, not a rename.

The riskiest part is not the code. It is that **the server's coverage of those
groups is not determinable from this repository** — the current protocol omits
them, and no server-side catalog argument was found to regenerate from.

## The two decisions

**1. Protocol coverage.** Does the protocol regain the groups and endpoints the
app needs — `mcp`, `catalog`, `command`, `shell`, `rename`, `remove`, `fork` — or
does the app keep a fallback to the V1 SDK for the parts the protocol does not
cover?

My lean: extend the protocol, because the client is *generated* from it, so
coverage is the protocol's business. Before that is possible: confirm which of
those the server actually serves today. The MCP group exists; the rest is unknown.

**2. The event surface.** Does the app's reducer migrate to `session.next.*`, or
does the server keep emitting the V1 names the app speaks today?

My lean: migrate. The goal is one contract, and the V1 subtree is explicitly
temporary. But this is the several-hundred-line piece, so it is also the decision
that sets the phase's length — and it interacts with decision 1: whichever event
surface the app lands on is the API whose coverage has to be settled.

## The phase, in order

1. **Audit the coverage** — every group and endpoint the app calls, against what
   the protocol declares, against what the server serves. This is the gate: it
   decides whether the rest is a migration or a renegotiation.
2. **The imports and the type names** — mechanical, 42 files.
3. **The tool-state shape** — the four accessors, whose replacements are already
   written in comments.
4. **The event layer** — the reducer, `applyV2`, `CurrentDelta`, `server-compat`.
5. **Delete the tarball and the cast.** Then a schema addition costs nothing.
6. **Proof**: the app's suite green, the cast gone, and ADR-0008's cards rendering
   without it.

## What it is not

Not a goal-loop task. It should not ride in the goal-loop branch, whose scope is
ADR-0008's steps. The cast is committed there and this phase removes it.

## What it unblocks

Every future contract addition reaching the app — including ADR-0008's remaining
step 4 work: the phase chip, the goal panel and the handoff view, which all need
`GET /session/:id/goal` to be reachable from the app.
