# F1 · The strip and the file pane heal their own cold state

Fixes: the two live defects from the `udinus` run (2026-10-21)
Shipped: v0.4.4 — `d080382f3` (projection), `b3e5ff2cf` (file view), `0794c6c4e` (release)
Read with: `packages/app/src/pages/session/session-goal.ts`,
`packages/app/src/pages/session/file-tabs.tsx`,
`packages/app/src/context/file.tsx`, and `f1-live-run-udinus.md`.

Both defects are the same shape: **a one-shot fetch whose failure has no
fallback and no retry**. A page that lost the fetch kept a hole in the UI until
something unrelated moved, and a reload was the only cure.

## The two symptoms

| symptom | where it appeared |
| --- | --- |
| the goal strip (phase, status, turns) missing | a page loaded while the agent was booting or restarting |
| the file pane blank for a tab opened from the tree | a tab restored from the persisted layout, or whose path was loaded under a different key |

Neither was an API failure. `GET /session/<id>/goal?directory=…` returned a
valid projection with `gates`, and `GET /file/content?path=…` returned 200 for
both `app/README.md` and `app/.prettierignore` while the pane was blank. The
`udinus` iframe also ran on the **live agent origin**
(`http://localhost:<port>/<workspace-slug>/session?auth_token=…`, built by
`directAgentURL`, `internal/handler/webui/pages.go:234-245` on the manus side),
so neither symptom was a proxy or origin problem.

## A — the projection was fetch-once-and-forget

`createSessionGoal` created the resource over `sessionID()` and fetched once on
mount. `loadGoal` collapsed every outcome into `undefined`:

```ts
try {
  const result = await request()
  if (result.error) return undefined
  return goalProjection(result.data)
} catch {
  return undefined
}
```

`undefined` is the strip's "no goal" value, so a 404 (final), a refused
connection (transient), a 5xx, and a 200 that was not a projection all looked
identical. The only refetch triggers were event handlers — `session.goal.phase`,
`session.goal.verdict`, `session.created`, `session.updated` — and those move on
**turns**. A client that lost its first fetch therefore stayed empty until a
turn fired an event, which reads exactly as "the strip is only populated after
a turn". A client whose SSE died with a restarted container never healed at all.

**Ruled out:** the front-door path proxy. We measured `/file/content` and
`/session/.../goal` through deusd's `/sessions/<id>/` URL and got 404/401, but
the fleet page does not use those paths: the iframe is the agent's own origin.
The correction matters — the proxy gap claim was wrong.

**Fix (`session-goal.ts`).** `loadGoalOutcome` keeps the decision the strip did
not need but the client did:

- a 404, `NotFoundError`, or a 404 nested in `data`/`cause` is final
  (`retry: false`);
- everything else is a hole worth another attempt (`retry: true`), including a
  200 that fails `goalProjection`.

The resource then backs off 1 s, 2, 4, 8, 16, capped at 30 s; a success or a
session change resets the schedule. `visibilitychange → visible`, `focus`, and
`online` refetch the projection and the role children — the page's own evidence
that the server may answer now. `loadGoal` keeps its old contract and delegates,
so the strip and the saved tests are unchanged. The duplicated
`onCleanup(offs.forEach(...))` line in the same effect was removed.

## B — the file view had no state of its own

The view renders three branches and nothing else — V2 at
`file-tabs.tsx:789-793` before the fix, V1 at `:498-502`:

```tsx
<Switch>
  <Match when={state()?.loaded}>{renderFile(contents())}</Match>
  <Match when={state()?.loading}>Loading…</Match>
  <Match when={state()?.error}>{err()}</Match>
</Switch>
```

Consequences, in order:

1. A failed request prints the error and raises a toast — it is **not** blank.
2. An in-flight request prints `Loading…` — it is **not** blank.
3. Blank means **none of the flags is set**: the view has a path, but no store
   entry was loaded.

And the view never loaded anything. `file.load` was called only by the openers —
`previewTab`/`activateTab` in `session-side-panel.tsx:222-239` and
`createOpenSessionFileTab` in `helpers.ts:192-210` — while tabs are **persisted**
per session (`sessionTabs`; the persisted store starts at `layout.tsx:271`). A
tab restored after a reload became visible with `path` set and no state, and
nothing ever asked again.

That explains the browser split without blaming either browser: the most
economical reading is that Chromium's profile had the README tab persisted from
an earlier visit, while Zen's tab was fresh, so its click went through an
opener. Both apps ran the same bundle on the same origin.

**The candidates we ranked, and what is proven:**

| candidate | status |
| --- | --- |
| restored tab, never loaded | leading; explains the browser split via per-profile persistence |
| key mismatch: `file.load` writes a key normalized under one scope, `pathFromTab` reads another | unproven; would also give a 200 and a blank pane (`path.ts:104-141`, `context/file.tsx:167-204`) |
| `loaded` with `undefined` content | real hole, fixed; `setLoaded` accepted a body with nothing to render |
| zero-height render in the Chromium iframe | unlikely; the DOM would still contain the text |

No request was captured from Chromium on the failing click, so the leading
hypothesis is not instrumented. The fix is deliberately below all four.

**Fix (`file-tabs.tsx`, `context/file.tsx`).**

- `createFileTabLoader(path)` runs in both V1 and V2: when a tab has a path and
  its state is neither loaded, loading, nor errored, the view calls
  `file.load(path)` itself. The opener stays a head start, not a requirement.
- The switch falls back to `Loading…` for a path with no state, so the pane can
  no longer be silently empty.
- `context/file.tsx` no longer marks a body without a string `content` as
  loaded; it goes through `setLoadError` like a failed request.

## Verification

- `bun run typecheck` (tsgo -b): clean.
- `oxlint` on the four files: 0 errors; only the pre-existing unsafe-assertion
  warnings.
- `translate:app all --dry-run`: 0 missing, 0 extra, 0 placeholder mismatches
  across app, ui, desktop. No new keys; the two reused keys already existed.
- `bun run test:unit`: **506 pass, 23 fail, 17 errors**, the documented
  baseline. `session-goal.test.ts` is one of the pre-existing broken files in
  this local bun (`jsxDEV` not exported by `solid-js/dist/solid.js`); the same
  failure reproduces with the change stashed. The new `loadGoalOutcome` tests
  run in CI, where the suite is green.
- `bun run build` in `packages/app`: `✓ built in 40.66s`.
- Release v0.4.4, run `39606820493`: green.

## What remains unproven

- No live repro of the exact failing click. The fix makes the blank state
  impossible in three independent ways, but the mechanism that produced this
  particular Chromium tab is not instrumented.
- The key-mismatch case still deserves a reproduction: call `file.load` with an
  absolute path while `sdk().directory` is still empty, then check that
  `pathFromTab` reads the same key. The network log in the `udinus` session
  showed an absolute `path=…` in a request, which is consistent with it.
- If a pane is still blank **and shows no `Loading…`**, then `pathFromTab`
  returned nothing — a fifth hole, not this one. The fallback makes that
  visible instead of silent.
