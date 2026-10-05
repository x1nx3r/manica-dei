# F1 · The browser as a process-scoped resource

Implements: ADR-0007 (proposed)
Fixes: manica-dei issue #4, the regression from `f7eeba1e4`
Supersedes: `packages/core/test/browser/browser-location.test.ts`

This is the recon and the plan. No code is written yet.

## Recon

### The two process-scope groups

| Group | File | Contains `Browser.node`? |
| --- | --- | --- |
| `app` (served routes) | `packages/opencode/src/server/routes/instance/httpapi/server.ts:222` | no |
| `AppLayer` (CLI/TUI runtime) | `packages/opencode/src/effect/app-runtime.ts:58` | no |
| `locationServices` | `packages/core/src/location-services.ts:43` | **yes** (line 61) |

`AppNodeBuilderV1.build` (`effect/app-node-builder-v1.ts`) is a thin wrapper
over the core `AppNodeBuilder.build`, which adds the `InstanceStore.bootstrapNode`
replacement. Both groups are compiled with the same builder, so a node is
registered by being a member of the group.

### How the route resolves the browser today

`handlers/browser.ts:36-42` wraps every browser call:

```ts
const browser = Effect.fnUntraced(function* <A, E, R>(effect) {
  return yield* effect.pipe(
    Effect.provide(locations.get(Location.Ref.make({ directory: ... }))),
  )
})
```

Before `f7eeba1e4` this worked because the browser was a location node and so
was part of the location layer's output. After it, `hoist` moved the browser
into the location layer's *dependency* set, so `locations.get(ref)` no longer
provides it. The handler still compiles, and fails only at runtime.

### Why eager start must not live in the layer graph

`createRoutes` provides `app` internally and returns
`Layer<never, ConfigError, RouteRequirements>` — the `app` services are
consumed, not exposed. `startListener` therefore cannot `Context.get` the
browser from the built context.

Worse, the test fixture `test/server/httpapi-layer.ts` serves the **real**
`HttpApiApp.routes` (`createRoutes()`). If eager start were unconditional in
`createRoutes` or in the browser layer, then importing `HttpApiApp` would
spawn `Xvnc` and Chromium for every server test, guarded or not. Eager start
has to be a production-only branch.

### Where eager start can hook

`Server.listen` → `startWithPortFallback` → `startListener` builds
`listenerLayer`, which serves `HttpApiApp.createRoutes(opts)` inside one scope
(`server.ts:124-138`). That scope is closed on `stop`, and the browser layer's
own finalizer already tears the processes down when its scope closes.

The plan: give `createRoutes` an opt-in flag and set it only from
`listenerLayer`.

```ts
export function createRoutes(
  corsOptions?: CorsOptions,
  options?: { eagerBrowser?: boolean },
) { ... }
```

The eager layer is merged into the routes and provided `app`, so it can yield
`Browser.Service`:

```ts
const eagerBrowser = options?.eagerBrowser
  ? Layer.effectDiscard(
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        yield* browser.ensure.pipe(
          Effect.catch((error) =>
            Effect.logError("the session browser did not start", { message: error.message }),
          ),
          Effect.forkScoped,
        )
      }),
    )
  : Layer.empty
```

`Layer.effectDiscard` has no output, so the layer type is unchanged.
`listenerLayer` calls `createRoutes(opts, { eagerBrowser: true })`. The
module-level `routes = createRoutes()` and `webHandler` keep the old
behaviour, so tests and the in-process CLI handler do not spawn anything.

`Effect.forkScoped` (not `Effect.forkIn`) is the v4 idiom for forking into the
layer's scope.

### The client loop

`packages/app/src/context/browser-retry.ts` holds the policy: five delays
`[300, 600, 1200, 2400, 4800]` ms, a deliberate close that never retries, and
a cap that turns an unrecoverable stream into a terminal failure with a
reason. `browser.tsx` drives it against `/browser/status` and the RFB socket.

Under eager start the "no browser" outcome is no longer reachable, so the
policy's reason for existing narrows to "the browser is still coming up". The
seven-second budget may be short for a cold Chromium; measure before changing.

### The regression test that would have caught #4

`GET /browser/status` in a temp directory:

- resolves `Browser.Service` at process scope, so it 500s if registration is
  wrong, and
- calls `get`, which returns `undefined` when nothing has started, so it does
  **not** spawn.

That makes it an unguarded test through the real served routes. It uses the
existing `httpApiLayer` fixture and `requestInDirectory`.

## Plan

### M1 — registration

1. Remove `Browser.node` from `location-services.ts`.
2. Add it to the `app` group (`server.ts`) and `AppLayer`
   (`app-runtime.ts`).
3. Resolve `Browser.Service` directly in `handlers/browser.ts`; drop the
   `locations.get(ref)` wrapper for browser calls.
4. Confirm the agent tool still resolves it: `browser-tools.ts:263` keeps
   `Browser.node` as a dep and now gets it from process scope.

### M2 — eager start

5. Add the `eagerBrowser` option to `createRoutes` and the forked `ensure`.
6. Pass `{ eagerBrowser: true }` from `listenerLayer`.
7. Verify the server starts one browser at listen and tears it down at stop,
   with a guarded test or a manual run.

**Corrected during implementation.** `listenerLayer` is not production-only:
`httpapi-listen.test.ts` and `httpapi-mdns.test.ts` stand a real server up with
`Server.listen`, and an eager browser there leaked fourteen `Xvnc` per run.
The flag therefore moves up to `ListenOptions.eagerBrowser`, and the `serve`
command sets it from `Flag.OPENCODE_EAGER_BROWSER`.

That is still not enough on its own: `test/cli/serve/serve-process.test.ts`
spawns the real `opencode serve` binary, so putting the flag on `serve`
unconditionally leaked three more per full run. The gate is the environment
variable `OPENCODE_EAGER_BROWSER`, off by default, and the container's
`entrypoint.sh` sets it alongside `exec opencode serve`. Tests never set it,
so `Server.listen` and the spawned CLI both start nothing.

**This is a template change on the manus-dei side** (one env on the existing
`exec opencode serve` line), and it lands with the `v0.3.3` pin bump.

### M3 — the pane

**Not needed, and not done.** The plan assumed `connect` had to stop calling
`ensure` and the pane had to be rewritten around a retry loop. Neither holds
once the browser is process-scoped and eagerly started:

- `connect`'s `ensure` is idempotent and, with eager start, joins the launch
  already in flight. It waits for the RFB port and then attaches, which is
  strictly better than a client retry against a cold start.
- The pane already retries. `browser-retry.ts` and `browser.tsx` handle a
  dropped stream, and `checkAlive` turns `alive: false` into a drop that
  retries. `alive: false` is now transient — the server is bringing one up —
  not a dead end.

The "no browser" branches that remain (`url`'s `error: "no browser"`,
`checkAlive`'s drop reason) fire only while the browser is restarting, and the
retry loop clears them. Rewriting the pane would add risk to a release whose
only job is to unbreak the fleet. Left as a follow-up if the copy proves
confusing, not as a defect.

### M4 — tests

10. Add the unguarded `/browser/status` route test through `httpApiLayer`.
11. Retire `packages/core/test/browser/browser-location.test.ts`.
12. Keep the guarded relay and lifecycle tests; adjust for the new
    registration.

### M5 — release

13. `v0.3.3`, since the fleet is rolling back off `v0.3.2` and the pane is dead
    on it.

## Results

- `browser-status.test.ts` passes on the fix and fails with `Service not found:
  @opencode/v2/Browser` when `Browser.node` is removed from the `app` group —
  the exact v0.3.2 failure.
- `packages/core`: 1133 pass, 6 skip, 0 fail.
- `packages/opencode/test/server`: 306 pass, 3 skip, 0 fail, and zero `Xvnc`
  spawned (the suite leaked fourteen before the `ListenOptions` correction).
- `packages/opencode` full suite: the same six `cf-ai-gateway` /
  `cloudflare-ai-gateway` provider failures that reproduce on the pre-change
  tree — pre-existing, not this work. No `Xvnc` spawned.
- A live `opencode serve` with `OPENCODE_EAGER_BROWSER=1` starts exactly one
  `Xvnc` at listen and `GET /browser/status` answers `{"alive":true}`.

## Verification

- `bun test` in `packages/core` and `packages/opencode` (the new job from #3).
- `bun run test:unit` in `packages/app`.
- A live `opencode serve` with `GET /browser/status`, `GET /browser/connect`
  after a ticket, and `pgrep -c -f Xvnc` == 1.
- `MANUS_INTEGRATION=1` for the guarded relay and lifecycle runs.

## Risks

- **Eager start in the wrong place.** If the flag leaks into the default
  `routes`, every server test spawns a browser. The test in M4 is the guard:
  it runs unguarded and would hang or fail if a browser spawned.
- **Double start on port fallback.** `startWithPortFallback` builds a second
  listener when the first port fails. Each build has its own scope, and the
  first scope closes on error, so the first browser is torn down. Confirm with
  a test on the fallback path.
- **Process scope vs session scope.** Correct for one server per container.
  Recorded, not solved.
