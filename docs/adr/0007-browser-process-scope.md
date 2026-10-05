# ADR-0007: The session browser is a process-scoped resource

Status: proposed · Date: 2026-10-05
Amends: ADR-0003 ("One Chromium per session, owned by the server")
Fixes: the regression in `f7eeba1e4` (manica-dei issue #4)
Relates to: manus-dei ADR-006 (the session surface is this server's own UI)

## Context

### What broke

`f7eeba1e4` fixed the two-browser bug (#2) by changing the browser node from a
location node to a global node:

```ts
- export const node = makeLocationNode({ service: Service, layer, deps: [] })
+ export const node = makeGlobalNode({ service: Service, layer, deps: [] })
```

It left the node in the **location** group (`location-services.ts:61`). That
is the whole bug, and the mechanism is worth stating because it is not
obvious:

- `buildLocationServiceMap` calls `LayerNode.hoist(locationServices, global)`.
- `hoist` removes every global-tagged node from the group's **output** and
  returns it separately as `hoisted`.
- The location layer is `compile(node).provide(compile(hoisted))`. A provided
  layer satisfies a dependency; it does not add its services to the output.
- So `locations.get(ref)` stopped providing `Browser.Service`.
- The node was never added to a process-scope group either. `AppLayer`
  (`effect/app-runtime.ts`) and the server's `app` group
  (`server/routes/instance/httpapi/server.ts`) both omit it.

The `/browser/*` routes resolve at process scope. Nothing provided the service
there, so every route returned 500:

```
Service not found: @opencode/v2/Browser
```

No Xvnc, no Chromium, no pane.

### Why the tests did not catch it

`packages/core/test/browser/browser-location.test.ts` builds its own group:

```ts
AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Browser.node, LocationServiceMap.node]))
```

It puts `Browser.node` in the group by hand, so it asserts the node's keying
and cannot observe a missing registration in the real composition. The relay
test (`test/server/browser-relay.test.ts`) merges `LayerNode.compile(Browser.node)`
directly for the same reason. Neither test asks the question that matters:
**can the served route resolve the browser with no help from the test?**

### What the browser actually is

One `Xvnc` and one headful Chromium serve the whole container. ADR-0003 says
so: "One Chromium per session, owned by the server." A session is a container,
and a container is one server process. So the browser is a **process-scoped
resource**. It has no per-directory meaning, and there is nothing about it
that a workspace subdirectory owns.

## Decision

### One browser per process, registered at process scope

`Browser.node` leaves `locationServices` and joins the process-scope groups:

- the server's `app` group, so the HTTP routes can resolve it, and
- `AppLayer`, so the CLI and TUI runtimes agree with the server.

The HTTP route resolves `Browser.Service` at process scope. It does not go
through `locations.get(ref)`. The agent's tool keeps `Browser.node` as a
dependency; as a global node it now resolves from process scope too.

**Consequence to name:** process scope is session scope only because
manus-dei runs one server per container. A server that serves several
workspaces would share one browser across them — shared cookies, shared tabs.
That is correct for the product and wrong for a hypothetical multi-workspace
fork. Per-workspace isolation would key the browser at the server layer; it is
not built.

### The server owns the lifecycle and starts it eagerly

The server starts the browser in the background when it starts listening, and
tears it down when the listener stops. The start is forked, so it never blocks
a request. This deviates from ADR-0003's "on first use" deliberately:

- "On first use" makes the pane's open the trigger, which is the ambiguity
  that produced #2 and #4 in the first place.
- Eager means there is always one browser to resolve. The pane never has to
  decide whether to start one.

**Cost, accepted for now:** every session pays for `Xvnc` and Chromium
whether or not anyone browses. That is two processes and their memory per
session. The alternative, lazy start on the first browser request, is recorded
here as the intended refinement and is not built yet.

### The UI is a VNC client, and "no browser" is not a state

The pane's connect stops being a spawn-or-refuse. The server guarantees a
browser, so the pane has one job: **retry the RFB attach until it connects**.
The `alive: false` and `error: "no browser"` branches go away. What remains is
a real error, "the browser is up and the page could not be read", and a
connection that is still coming up.

The retry policy already exists (`packages/app/src/context/browser-retry.ts`,
five attempts over about seven seconds). A cold Chromium can take longer than
that, so the policy needs revisiting against the new "always starting" model.

### The agent and the human resolve the same instance

One `Browser.Service` per process means one CDP port and one
`agent-browser` attach. The agent's tool and the pane cannot end up on
different browsers, because there is only one to find.

## Consequences

- **The regression class is gone by construction.** There is no key to
  diverge and no second place to register. The atomic `ensure` from
  `f7eeba1e4` stays, for concurrent callers during a start.
- **Eager start is a real cost** and the ADR says so rather than hiding it.
- **The pane simplifies.** Fewer states, and the ones left are honest.
- **Tests change shape.** The regression test must exercise the real served
  routes, not a hand-built group. `GET /browser/status` answers before
  anything runs and does not spawn, so the test needs no `Xvnc` and no guard.
- **`browser-location.test.ts` is retired.** It tests a keying property that
  no longer has a failure mode.

## Out of scope

- Lazy start on first browser request.
- Per-workspace browser isolation.
- A persistent browser profile. It still needs owner-scoping (a shared volume
  would leak cookies across users of a project) and concurrency handling for
  Chromium's `SingletonLock`.
- Any change to the agent tool's surface (ADR-0005).

## Open question

The pane's retry budget under eager start: five attempts over seven seconds
was chosen for "a container mid-restart". A cold Chromium plus first paint may
need more. Decide during implementation, against a measurement, not a guess.
