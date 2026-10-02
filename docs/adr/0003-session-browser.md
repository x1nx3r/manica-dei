# ADR-0003: The session browser

Status: accepted · Date: 2026-10-02
Implements: PLAN.md F1 item 6
Companion: manus-dei ADR-006 (the session surface is this server's own web
UI, so the browser must work in a browser and not only in Electron)

## Context

### The goal, stated once

> The agent and the human work on the same page together. Either can hand
> the other something — a URL, a page, a decision — and the other picks it
> up.

A concrete version: the human opens a site and says "take a look at this,
can we implement that?" The agent sees the page the human is looking at.
Later the agent opens a tab and says "I opened it, look." The human sees
the agent's work live, and if they agree, the agent executes.

Every proposal in this ADR is measured against that sentence. A mechanism
that does not serve it is not a simplification of this feature, it is a
different feature.

### The constraint that decides the architecture

**The human's browser is outside the container.** deusd publishes exactly
one port, the agent's, on the container's loopback. The agent's Chromium
runs inside the container and the human's browser runs on the human's
machine, so the two cannot be the same process.

That leaves one way to satisfy the goal: **the instance is shared by
streaming its output**, and both parties send input to it. Everything else
in this ADR follows from that sentence, including the parts that are
compromises.

### Prior art, including what does not work

These were checked against source. The checkouts live in a gitignored
`ref/` folder, so the findings are recorded here rather than left behind.

**VS Code Remote does not stream.** It synchronizes _data_ — file trees,
text deltas, terminal bytes — and renders locally, which is why it feels
native. Its own browser feature, the Simple Browser extension
(`extensions/simple-browser/`, MIT), is a toolbar plus one sandboxed
iframe with no CDP anywhere. Both facts are true, and neither answers this
ADR, because VS Code has no requirement for an agent to drive the page. It
is the right answer to a different question, and taking it would have left
the goal undelivered.

**Streaming is nevertheless shipping, and not as JPEG.** cptr
(`open-webui/computer`) runs a real Chrome in the container and streams
**H.264 over a WebSocket** to the browser, with quality presets at
3/6/12 Mbps and 15/24/30 fps. Its viewer is about 1700 lines. That is the
reference for the transport here.

**There is no client-side engine to embed.** The idea of shipping a browser
inside our own bundle was checked and there is nothing shippable:
StackBlitz's WebContainer SDK is MIT but the engine is proprietary and
served from their CDN, which also means calling a third-party service.
BrowserBox, which compiled Firefox to WebAssembly, is dead and both
repositories 404. There is no viable Chromium-to-WebAssembly build. Even if
one existed it would be a _second_ browser instance, so it would not have
answered the constraint above.

**Moon has no browser surface at all.** Its open-source tree contains no
screencast, no `--remote-debugging`, and no devtools integration anywhere.
The browser tool is a commercial feature. Do not spend time on it again.

**cptr's proxy rewriter is excellent and is not this feature.** Its
`proxy.py` streams HTML through a parser and rewrites a fixed allowlist of
URL attributes, plus `srcset`, CSS `url()`, `@import`, and loopback-only ES
module imports, and it strips `integrity` attributes because rewriting
bytes invalidates subresource integrity. That work will be needed by the
deferred mode in item 4 below. It is not needed here, because there is no
proxy on this path: the shared browser navigates to the app's real origin.

### A rejected proposal, recorded so it is not re-derived

An earlier draft specified a _different_ surface: an iframe proxying
container-localhost ports, with the human browsing in their own renderer and
the agent using a separate headless browser. Two renderers, coordinated by a
shared URL grammar.

That is a coherent product and it is cheaper. It is not this goal. It was
picked because the first transport tried, CDP's `Page.startScreencast`,
produces coarse JPEG frames, and then a working mechanism was allowed to
argue for a different goal. That was the error this rewrite exists to
correct.

## Decision

### One Chromium per session, owned by the server

The server launches one headful Chromium inside the container on first use
and owns its lifecycle: launch, resize, restart, teardown, and disposal with
the instance.

**Headful, on a virtual display, not headless.** Chromium has no native
H.264 screencast, so a real encoded stream requires capturing a real
window. The container therefore gains `Xvfb` and `ffmpeg`. That is a
deliberate cost and the reason it is stated here rather than discovered
during implementation.

Launch uses `--remote-debugging-pipe` rather than a port. A pipe has no port
race, no loopback listener, and no token file to protect.

### The human's surface is a video, and their input is dispatched

The human sees the shared browser as a decoded video stream, in a panel
beside the terminal. They are not looking at a document, and the honest
consequences are these:

- Scrolling and hovering carry input latency. The stream is not the DOM.
- The human's own DevTools cannot inspect the page, because there is no
  document on their side.
- Text selection, if we build it, is ours to render over the video.

In exchange, the human is looking at the **agent's** page, which is the
whole point.

Input is dispatched as CDP input events. **Text entry uses
`Input.insertText`, not `Input.dispatchKeyEvent` alone.** The reference
implementations synthesize characters from `String.fromCharCode`, which is
ASCII-only and breaks on IME input and dead keys. Composition support is a
requirement of this ADR, not a follow-up.

### Both parties drive the same instance

The agent's tools are a curated named surface over CDP — `browser_open`,
`browser_navigate`, `browser_click`, `browser_type`, `browser_read`,
`browser_screenshot` — never raw CDP methods, so the protocol stays out of
the model's reach.

The human drives it through the panel. Whoever acts last wins, and the other
party sees the result in the stream. **There is no state synchronization,
and none is planned.** That is the reason this feature is affordable: a
shared screen does not synchronize, and neither do we.

### The handoff is the instance

This is what separates this from the rejected proposal. When the human says
"take a look at this," the agent is already looking at the human's page
because it is one page. When the agent opens something, the human is already
watching. Nothing is copied, mapped, or kept in step.

Every navigation is reported onto the session, so the trail shows where the
browser has been and who moved it.

### The panel states the current URL at all times

One new risk comes with this design and it needs naming: the human's browser
now displays **whatever the agent's browser displays**, as video inside our
own UI. An agent that navigates to a convincing login page renders it in the
middle of our interface, where it looks like ours.

The session owner already has a shell, so this is not an escalation. It is
a deception risk aimed at the person watching, and the mitigation is that
the URL of the shared browser is **continuously visible** in the panel, with
an indicator that the agent is driving. Cheap, and it removes the surprise.

No other restriction is imposed, and that is deliberate. The agent has full
shell and the owner owns the container, so neither of them gains anything
from a navigation allowlist. Adding one would constrain the owner without
reducing any real capability.

## Sequencing: prove the transport before building on it

The risky part is the encoder path, and it is the part we know least about.
So it goes first, as an isolated experiment with no product surface attached:

1. **The transport spike.** Headful Chromium on `Xvfb`, `ffmpeg` encoding to
   H.264, a WebSocket, and a minimal client using the WebCodecs
   `VideoDecoder` to display frames and to round-trip input. It measures
   end-to-end latency, frame rate under typing and scrolling, CPU cost in
   the container, and whether input feels responsive.
2. **The product.** Lifecycle, both drivers, input mapping, the trail, and
   the panel, on top of the transport the spike validated.
3. **The mode choice.** Deferred, and described in Consequences.

The spike is the cheapest possible answer to "is this encoder path robust
enough," which is the question that decides everything after it.

## Consequences

- **Chromium, `Xvfb`, and `ffmpeg` become container dependencies.** The
  manus template image changes, which is a change on the manus-dei side.
- **The human's browser experience is video.** This is a real downgrade
  against any iframe design, and it is the price of the goal.
- **The agent gains a browser and the human gains visibility into it.** Both
  halves of the goal, which nothing we had before delivered.
- **Composition and IME are required**, not deferred, and the
  `Input.insertText` path is the reason they are tractable.
- **An earlier idea is deferred, not rejected.** cptr lets a session choose
  between an iframe proxy and a Chrome-backed stream per tab. That is the
  right shape, and the iframe mode needs the proxy route plus the URL
  rewriter described in Context. It is deliberately **not** built in this
  phase, because the instruction was to put all effort behind the shared
  instance first and to judge the encoder path before committing to a second
  surface. The proxy route and its tests are preserved on the
  `scratch/preview-proxy` branch for that follow-up.
- **Tests.** Input mapping is a pure function from a DOM event to CDP
  parameters, so it is unit-tested exhaustively, including composition
  events. Lifecycle and restart are tested against a real Chromium in a
  guarded integration run. The transport spike is validated by measurement,
  not by assertion.

## Out of scope

No iframe proxy and no URL rewriting in this phase. No mode choice between
surfaces. No tab-per-page or multiple browser windows. No recording. No
navigation allowlist. No new server dependency that wraps a browser driver:
CDP is JSON over a pipe, and nothing in this runtime has a driver today. No
telemetry.

cptr is a **reference only**. It is ELv2 and is never a source we ship.
