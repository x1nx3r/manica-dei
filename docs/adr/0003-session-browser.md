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

**Headful, on a virtual display that is also the server.** The display is
`Xvnc`, which serves RFB directly from its framebuffer. The container gains
`tigervnc-standalone-server`. It does **not** gain `Xvfb` or `ffmpeg`.

**The human's surface is a framebuffer stream, not a video.** This is the
measured decision and it replaced an earlier H.264 design. See Spike
results.

Launch uses `--remote-debugging-pipe` rather than a port. A pipe has no port
race, no loopback listener, and no token file to protect. Measured: Chromium
binds its debugging port to container loopback even with
`--remote-debugging-address=0.0.0.0`, so a published port cannot reach it.

### The human's surface is a framebuffer, and their input goes through X11

The human sees the shared browser as a framebuffer the server streams, in a
panel beside the terminal. The client negotiates **ZRLE**, plus `CopyRect`
as a fallback. It is not a document, and the honest consequences are these:

- The human's own DevTools cannot inspect the page, because there is no
  document on their side.
- Text selection, if we build it, is ours to render over the pixels.
- Nothing else is lost. This is a real renderer on the far side, not a
  recording.

**The human's input travels as RFB input and is injected by `Xvnc` through
X11.** It never passes through CDP. That is the important part, and it was
the original reason for considering this path: input arrives at Chromium as
real OS-level events, so IME, dead keys, and key repeat come from the input
stack rather than from anything we synthesize. The composition risk that an
earlier draft carried is therefore removed rather than mitigated.

The agent's input goes the other way, through CDP.

### Both parties drive the same instance

The agent's tools are a curated named surface over CDP — `browser_open`,
`browser_navigate`, `browser_click`, `browser_type`, `browser_read`,
`browser_screenshot` — never raw CDP methods, so the protocol stays out of
the model's reach.

The human drives it through the panel. Whoever acts last wins, and the other
party sees the result. **There is no state synchronization, and none is
planned.** That is the reason this feature is affordable: a shared screen
does not synchronize, and neither do we.

### The two eyes are asymmetric, and hover is the gap

Agent to human is a push: the agent acts and the human sees it.

Human to agent is a pull. The agent reads page state over CDP — the DOM,
form values, `scrollY` — so a click, a typed character, and a scroll are all
visible to it. **A hover is not.** There is no CDP event for an
OS-level pointer move, so a human hovering a button tells the agent
nothing.

If hover matters, we inject a small forwarder into the page that reports
`mousemove`, `click`, `keydown`, and `focus`. cptr already injects a runtime
script of this kind. The decision is recorded but not made.

That forwarder, and the agent through CDP, can see **everything on the
page, including credentials the human types into a login form.** That cost
was withdrawn once when the design briefly became two browsers, and with one
instance it returns. It is unavoidable here, and it is a decision to make
consciously.

The distinction worth protecting: **observability is solved, intent is
not.** Seeing that a human hovered "Delete workspace" is not knowing they
meant to. The handoff below is what closes that gap, and it is a
conversation, not a stream.

### The handoff is the instance

This is what separates this from the rejected proposal. When the human says
"take a look at this," the agent is already looking at the human's page
because it is one page. When the agent opens something, the human is already
watching. Nothing is copied, mapped, or kept in step.

Every navigation is reported onto the session, so the trail shows where the
browser has been and who moved it.

### The screen size is fixed at session start

`Xvnc` sets its framebuffer size at startup and the client scales to fit.
That is how RFB has always worked, and it removes the resize problem that
the earlier capture-based design carried as its sharpest edge.

### The panel states the current URL at all times

One new risk comes with this design and it needs naming: the human's browser
now displays **whatever the agent's browser displays**, as pixels inside our
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

The transport went first, as an isolated experiment with no product surface
attached. **Two transports were measured**, because the first one measured
well enough to raise a second question:

1. **Video.** Headful Chromium on `Xvfb`, `ffmpeg` to H.264, WebCodecs
   `VideoDecoder`. Measured and viable, then **superseded**.
2. **Framebuffer.** `Xvnc` serving RFB, Chromium on X11, ZRLE. Measured, and
   better. **Adopted.**
3. **The product.** Lifecycle, both drivers, the trail, the panel, and a
   client for RFB. Not started.
4. **The mode choice.** Deferred, and described in Consequences.

## Spike results

Run in `debian:bookworm-slim`, which supplies Chromium 154, `Xvfb`,
`ffmpeg`, and TigerVNC 1.12 from stock packages with no extra repository.
CPU was 4 cores of an AMD Ryzen 5 4500U. Capture was 1280x720.

### The video transport, measured and then superseded

| Stage                                    | Result                                     | Status       |
| ---------------------------------------- | ------------------------------------------ | ------------ |
| Capture, `x11grab` from `Xvfb`           | 60 fps, speed 1.0x                         | measured     |
| Encode, libx264 veryfast and zerolatency | 903 kbps, 6 s to 677 KB                    | measured     |
| Decode, WebCodecs `VideoDecoder`         | 2160 of 2160 frames, 1931 fps, zero errors | measured     |
| Decoded geometry and format              | 1280x738 coded, `I420`                     | measured     |
| CDP round trip, localhost                | 0.3 ms median, 0.73 ms p95                 | measured     |
| `Input.insertText` round trip            | passes                                     | measured     |
| Key down to a changed frame              | 31.2 ms median, 37.2 ms p95                | measured     |
| Wheel to a changed frame                 | 33.3 ms median, 40.0 ms p95                | measured     |
| Encode latency per frame                 | about one frame                            | **inferred** |

End to end that budget is **roughly 50 to 70 ms**, with one term inferred
rather than measured.

Two findings from it survive into the adopted design:

- **The port decision is justified by evidence.** Chromium binds its
  debugging port to loopback _inside_ the container even with
  `--remote-debugging-address=0.0.0.0`, so a published port cannot reach
  it. `--remote-debugging-pipe` is the only workable form when the server
  owns the process.
- **The Annex-B conversion was real client work.** `libx264 -f h264` emits
  start-code-prefixed Annex-B and `VideoDecoder` needs AVCC plus an `avcC`
  description. It is about sixty lines and nothing in the documentation
  says so. **The adopted transport does not need it**, which is one of the
  reasons it won.

The rest of that work is discarded. Its quality presets, its `zerolatency`
encoder settings, and its client decode path are not built.

### The framebuffer transport, adopted

| Measure                  | Raw                      | ZRLE                         | Status           |
| ------------------------ | ------------------------ | ---------------------------- | ---------------- |
| Key to visible pixels    | 15.0 ms median, 18.5 p95 | **14.4 ms median, 16.9 p95** | measured, 4 runs |
| Keypress volume          | 34.6 KB                  | **2.0 KB**                   | measured         |
| Scroll volume            | 1.64 MB                  | **25.4 KB**                  | measured         |
| Scroll to visible pixels | 48.3 ms median           | **not measured**             | gap              |

Volume comparisons are ZRLE against Raw, not against video. Against video
the volume win is larger still, because H.264 sustains roughly 900 kbps
whether or not anything changes, while ZRLE sends nothing for an unchanged
region.

### What the numbers decide

**Keys are about twice as fast, and the mechanism explains it.** 14 ms
against 31 ms, consistent across four runs. The video path spent most of
its budget on frame alignment: the 31 ms median was almost exactly two
frame intervals at 60 fps. **RFB has no vsync.** X delivers the event to
Chromium at once, Chromium repaints, and `Xvnc` pushes the damage. There is
no capture interval and no encoder buffer, which is why the difference is
predictable rather than lucky.

Typing is the latency-critical path. That is the "I see it, it sees me"
interaction, and it is the strongest single result here.

**The encoder leaves the container entirely.** `Xvnc` is the display server
_and_ the server, so there is no `ffmpeg`, no `Xvfb`, and no encoder
process. Two processes instead of three, and one dependency fewer.

**Input fidelity is solved rather than mitigated.** The human's input
reaches Chromium as real X11 events, so IME and dead keys come from the
input stack. An earlier draft of this ADR carried composition as a risk and
reached for `Input.insertText` as the workaround. That risk is gone,
because we no longer synthesize human keystrokes at all.

**`Xvnc` does not use `CopyRect`.** It emitted zero of them and sent
full-screen rectangles instead. That is why Raw scroll cost 1.64 MB, and
it is a property of this server rather than of RFB. Do not assume the cheap
path exists.

### The one gap

**Scroll latency under ZRLE is not measured.** With Raw encoding it was
48.3 ms against video's 33.3 ms, so this is the single case where video
might still win. The harness stopped producing observable scroll events,
and the diagnostic showed the probe was at fault: it read `window.scrollY`
inside the wheel handler, which runs before the default scroll action, so it
always read zero.

The reasoning says ZRLE should win, since it moves 25 KB where video
sustains 900 kbps and latency tracks volume at a given bandwidth. **That
is an inference and it is not recorded as a result.** The fix is a two-line
change to a throwaway probe and it does not need another spike. Close it in
the product, where the real client exists.

The case for the framebuffer path does not rest on this number: it rests on
keys being twice as fast, on bandwidth being 17 to 65 times smaller, and on
a dependency leaving the container.

### What the spikes did not tell us

- **Video latency was measured with CDP screencast, not `x11grab`**, and
  headless rather than headful. Its numbers are indicative, not exact.
- **The video control was never re-run** alongside the framebuffer test.
  The key comparison is trusted because the mechanism is explicable, not
  because the baseline was measured in the same session.
- **No RFB client has been written.** Everything measured used a raw
  protocol driver, not a browser.
- **Framebuffer latency was measured headful** on `Xvnc` with
  `--ozone-platform=x11`. The video numbers were headless. The comparison
  is across two configurations.
- **Everything was loopback.** The container adds a real hop.

### A measurement error worth recording

The framebuffer test took six runs, and **four of them produced numbers
that looked entirely plausible and were wrong**:

- Negotiating `Raw` only, which shipped uncompressed pixels and made
  scrolling look 3 times worse than RFB really is.
- Counting `CopyRect` and the cursor bitmap as content pixels, which put
  "first visible pixel" at 0.1 ms. A `CopyRect` is a move instruction and
  carries no pixels at all.
- Letting the on-screen counter scroll out of view, so keypresses changed
  nothing observable and the sample count fell to one.
- Reading `scrollY` before the scroll applied, in the diagnostic above.

Also earlier, a wheel measurement read 120 ms because 15 of 25 attempts
timed out against a page that could not scroll, and an idle figure read
540 kbps because the harness hammered the server with a 60 Hz request loop.

Record the pattern rather than the incidents: **a latency number alone,
from a harness written quickly, is close to worthless.** Every wrong number
above was caught by printing the completion count and the byte volume next
to the latency. Any future spike reports all three or it reports nothing.

## Consequences

- **Chromium and `tigervnc-standalone-server` become container
  dependencies.** `ffmpeg` and `Xvfb` do not. The manus template image
  changes, which is a change on the manus-dei side.
- **The human sees pixels, not a document.** A real downgrade against any
  iframe design, and it is the price of the goal. What is lost is DevTools
  on the previewed page and native text selection. Nothing else.
- **The agent gains a browser and the human gains visibility into it.**
  Both halves of the goal, which nothing we had before delivered.
- **Composition and IME are solved by the transport**, because the human's
  keystrokes are real X11 events. This is no longer a risk we carry.
- **The agent can see what the human types**, including credentials typed
  into a login form. Accepted, and stated in Decision.
- **Hover is invisible to the agent** unless we inject a forwarder. Recorded
  as an open decision, not a plan.
- **The remaining risk is the RFB client.** RFB is a published
  specification, so we can write one and avoid noVNC's MPL-2.0 terms, but it
  is a display protocol: framebuffer maintenance, scaling, input mapping,
  and reconnect. That is the largest single piece of work left, and it is
  only worth doing because the measurements justify the transport.
- **An earlier idea is deferred, not rejected.** cptr lets a session choose
  between an iframe proxy and a Chrome-backed stream per tab. That is the
  right shape, and the iframe mode needs the proxy route plus the URL
  rewriter described in Context. It is deliberately **not** built in this
  phase, because the instruction was to put all effort behind the shared
  instance first. The proxy route and its tests are preserved on the
  `scratch/preview-proxy` branch for that follow-up.
- **Tests.** CDP input mapping is a pure function from a DOM event to CDP
  parameters, so it is unit-tested exhaustively. The RFB client's frame
  parsing is a pure function over byte buffers and is unit-tested against
  captured fixtures. Lifecycle and restart are tested against a real
  Chromium and a real `Xvnc` in a guarded integration run.

## Out of scope

No iframe proxy and no URL rewriting in this phase. No mode choice between
surfaces. No tab-per-page or multiple browser windows. No recording. No
navigation allowlist. No video encoding, and therefore no `ffmpeg` and no
WebCodecs. No new server dependency that wraps a browser driver: CDP is
JSON over a pipe, and nothing in this runtime has a driver today. No
telemetry.

cptr is a **reference only**. It is ELv2 and is never a source we ship.

cptr is a **reference only**. It is ELv2 and is never a source we ship.
