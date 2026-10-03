# F1 Phase B implementation notes (the session browser)

Running notes for the session browser on `main`. Durable decisions and
gotchas — not a changelog. The boundary decision lives in
`docs/adr/0003-session-browser.md`. This file records how it went and
what surprised us. Background: `PLAN.md` F1 item 6.

---

## 1. The story, compressed

The feature went through five documents and six reruns before anything
worked. What follows is the version worth telling, because the misses were
systematic and not bad luck.

### The goal kept moving, because nobody wrote it down

The requirement on the first pass was "show a dev server in a tab". What
the user wanted — said explicitly, in the first message on the topic, and
confirmed twice after — was:

> The agent and the human work on the same page together. Either hands the
> other a URL, a page, or a decision, and the other picks it up.

Reading mechanism before goal produced three contradictory
architecture documents in one session: an iframe proxy, then a shared
screencast viewport, then two browsers plus a URL grammar. All three were
shaped like features of the product the writer thought best rather than the
one asked for.

**Rule now in force:** no mechanism gets designed, proposed, or documented
until the goal sentence is agreed in the user's own terms. If it cannot be
written in one sentence and then tested against, that is a design that
has not started.

### But the constraint that decided everything came from the recon

**The human is not in the container.** Their eyes, keyboard, GPU, and
window manager are on their machine, so a page rendered inside the
container has to reach them, and **something must cross the boundary**.
deusd publishes one port, on the container's loopback. `Xvnc` plus a
headful Chromium _is_ the browser they are watching, so what varies is only
what carries the rendered page across. That sentence eliminates whole
classes of idea on sight: a local renderer, an embedded client-side
engine, any two-browser design. All three were pursued before it was
stated.

## 2. Where the clever paths went to die

Checked against source, not folklore. The checkout lives in a gitignored
`ref/` folder, so the findings are recorded in the ADR rather than left
behind.

**There is no client-side engine.** StackBlitz's WebContainer SDK is MIT
but the engine is proprietary and served from their CDN — a third-party
call, which also breaks the fork's own hard rule. BrowserBox, the project
that compiled Firefox to WebAssembly, is dead and both of its repositories 404. No Chromium-to-WebAssembly build exists. So the idea of a browser
inside the bundle dies on availability before it even reaches sharing.

**It was the wrong shape anyway.** An engine in the bundle renders the
container's page _and_ the agent drives the container's Chromium — two
browser instances. Fidelity solved, sharing untouched. That constraint was
hitting every edge of the design and looked like bad architecture before
it was recognised as the recon's port rule.

**VS Code ships an iframe, and its Remote product never streams.** Simple
Browser (`extensions/simple-browser`, MIT) is a toolbar and one sandboxed
iframe, with no CDP anywhere. Remote syncs file trees and text deltas and
renders locally. Both facts are true. Neither answers the session browser,
because VS Code has no requirement for an agent to drive the page.

## 3. Prior art that turned out to be the design

**cptr** (ELv2, study-only) ships **both** surfaces and lets a session
choose: `proxy.py` streams HTML through a parser and rewrites a fixed
allowlist of URL attributes plus CSS `url()` and loopback-only ES modules.
`viewer.py` writes H.264 to a WebSocket from a real Chrome in the container
with quality presets at 3/6/12 Mbps and 15/24/30 fps. Its per-tab choice
was a strong signal that "which transport" is a **user preference**, not an
architecture decision — that idea is deferred to a later phase, and the
proxy route is preserved on `scratch/preview-proxy` for it.

Two details there worth stealing even now:

- `Input.insertText` alongside `Input.dispatchKeyEvent`, the IME primitive
- `integrity` attributes dropped on rewrite, because rewriting bytes
  invalidates subresource integrity — quietly breakable on real sites

**browserless** shows the two things about putting CDP on a wire you already
authenticate: delete `req.headers.origin`, because Chromium refuses a
mismatched upgrade, and tear down both the client socket and the backend on
close, or HTTP shutdown hangs. Its `network-security.ts` is **not our
guard**, it blocks outbound cloud metadata endpoints by hostname. Our
resolve-then-check loopback guard is stronger and different. No overlap.

## 4. What won, on measurement

Two transports were measured before anything was built. Video is **viable
and was superseded on numbers**, not on reasoning.

**Video** (headful Chromium on `Xvfb`, `ffmpeg` to H.264, WebCodecs
`VideoDecoder`): 60 fps at speed 1.0x, 903 kbps, 2160 of 2160 frames
decoded with zero errors, **50 to 70 ms end to end** with one term
inferred. Two findings from that spike still stand:

- Chromium binds its debugging port to **container loopback** even with
  `--remote-debugging-address=0.0.0.0`, so a published port cannot reach it.
  `--remote-debugging-pipe` is the only workable form. This makes the ADR's
  earlier pipe choice evidence-backed rather than preferred.
- `libx264 -f h264` emits start-code-prefixed Annex-B, and `VideoDecoder`
  needs AVCC plus an `avcC` description from the SPS and PPS NALs. About
  sixty lines, mandatory, and **the documentation does not mention it**.

**Framebuffer** (`Xvnc` serving RFB, Chromium on X11, **ZRLE**): keys to
visible pixels **14.4 ms median against 31.2 ms**, consistent across four
runs, because RFB has **no vsync anywhere**. Volume with ZRLE: keypress
**2.0 KB**, scroll **25.4 KB**, against **34.6 KB** and **1.64 MB** for
Raw. **Two processes instead of three and one dependency fewer**, since
`Xvnc` is both the display server and the server.

The rug-pull there was `Xvnc` never emitting `CopyRect`: it sent zero of
them and full-screen rectangles instead — a property of this server, **not
of RFB**. So the cheapest scroll path does not exist as configured, and
assuming it does is exactly the kind of quiet mistake that turns into a
bug.

## 5. What surprised us: the measurement harness said no six times

Of the six runs of the framebuffer test, **four produced numbers that were
wantonly wrong and looked entirely plausible**:

- Negotiating `Raw` only, shipping uncompressed pixels and making
  scrolling look three times worse than RFB really is.
- Counting `CopyRect` and the cursor bitmap as content pixels, putting
  "first visible pixel" at **0.1 ms**. A `CopyRect` is a move instruction
  and carries no pixels at all.
- Letting the on-screen counter scroll out of view, so keypresses changed
  nothing and the sample count fell to one.
- Reading `scrollY` before the scroll applied in the diagnostic.

Also earlier, a wheel reading of **120 ms** because 15 of 25 attempts timed
out against a page that could not scroll, and an idle figure of **540
kbps** because the harness hammered the server with a 60 Hz request loop.

**The lesson is the pattern, not the incidents:** a latency number alone,
from a harness written quickly, is close to worthless. Every wrong number
above was caught by printing the completion count and the byte volume next
to the latency. Any future spike reports all three, or it reports nothing.

## 6. What landed

| Commit      | Content                                                          |
| ----------- | ---------------------------------------------------------------- |
| `2b0dcc7ac` | ADR-0003: the session browser, one instance both parties drive   |
| `707bfc959` | the video transport spike results                                |
| `a9f5fbf24` | the session browser lifecycle service + guarded integration test |

## 7. What has not started

The **RFB client** for the human. That is the largest remaining piece: a
display protocol in the browser, with framebuffer upkeep, scaling, input
mapping, and reconnect. RFB is a published specification, so we can write
one ourselves and avoid noVNC's MPL-2.0 terms.

Two run-order facts from the spike worth carrying into it:

- The display must exist before Chromium renders into it, or Youtube-size
  delays show up later as blank frames, and that is worth an explicit pixel
  check rather than a process-exists call.
- `Xvnc` never emitted `CopyRect` here. Whether that is the app's scroll
  path or this server's choice is unjudged.
