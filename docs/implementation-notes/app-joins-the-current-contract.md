# The app joins the current contract

A plan, not a decision. **An avenue, not a prerequisite.** Nothing in the goal
loop or its UI waits on this; ADR-0008's step 4 can finish without it, at the cost
of one cast per new surface.

## What the app is, which this plan first got wrong

The app is **mid-migration and speaks both surfaces** — V1 and v2 — which is what a
clone taken mid-version-change looks like. Its forty-odd `/promise` imports are
not legacy debt to be migrated off; they are one half of a client that
deliberately has two. The current client is the other half, and they are meant to
coexist.

So the work is not "migrate the app off V1". It is "give the app the current client
**beside** the vendored one, and let the v2 half grow" — which is smaller, safer,
and needs no reducer rewrite to begin.

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

Two sizes, and the distinction is the point: the **avenue** adds a second client
beside the first, and the **full migration** retires V1. Only the first is needed
for anything to work.

**The avenue — add the current client, use it for what is new.** A dependency, one
client instance, and a typed wrapper for the endpoints that are new. Nothing
existing moves. This is what the goal loop's UI needs, and it is small.

**The full migration — retire V1.** This is where the reconnaissance' numbers
belong, and they are the reason the two sizes must not be confused:

- **Imports and type names**: 46 statements across 42 files, each needing a
  specifier change *and* a name remap, because the workspace `.` is neither
  `/promise` nor those names. Roughly 120–200 lines, and the types ripple into the
  values used at those sites.
- **The event layer**: `server-session-v2-reducer.ts` (509 lines, ~30 switch
  cases), `server-session.ts` (`applyV2`, `:946-983`), `server-sdk.tsx`
  (`CurrentDelta`), `server-compat.ts`. Several hundred lines across roughly six
  files. This is the cost of *retiring* `session.*`, not of adding a v2 path — the
  app can keep the V1 names and grow the other half beside them.
- **The missing surfaces**: `mcp`, `catalog`, `command`, `shell`, `rename`,
  `remove`, `fork`. Either the protocol regains them or the app falls back to the
  V1 SDK for them.

**The coverage question is determinable, and an earlier version of this note said
it was not.** The server's route groups are in this repository
(`packages/opencode/src/server/routes/instance/httpapi/groups/`, including `mcp`),
the protocol is in `packages/protocol/src/api.ts`, and the app's calls are counted.
Reading those three against each other is the first step, and it is an audit
rather than an unknown.

It also has a **product face** the audit must answer: if the server no longer
serves some of what the app presents, then the app is offering affordances that do
nothing — and the question becomes "prune the app" or "restore the server",
which changes what gets migrated at all.

## The two decisions

**1. Protocol coverage.** Does the protocol regain the groups and endpoints the
app needs — `mcp`, `catalog`, `command`, `shell`, `rename`, `remove`, `fork` — or
does the app keep a fallback to the V1 SDK for the parts the protocol does not
cover?

My lean: extend the protocol, because the client is *generated* from it, so
coverage is the protocol's business. Before that is possible: confirm which of
those the server actually serves today. The MCP group exists; the rest is unknown.

**2. The event surface — a decision only for the full migration.** The avenue keeps
the V1 names and grows a v2 path beside them; the reducer rewrite is the price of
*retiring* V1, not of adding v2. If and when V1 is retired, the question is
whether the app's reducer moves to `session.next.*` first, or the server keeps
emitting both names until the app is on v2 everywhere.

My lean for that phase: keep both until then, and drop V1 last. One contract is
the destination, not the first step.

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
