# ADR-0005: The agent's browser tool, on `agent-browser`

Status: accepted · Date: 2026-10-04
Amends: ADR-0003 ("Both parties drive the same instance"; "Out of scope")
Implements: PLAN.md F1 item 6, the agent's half
Depends on: the shared Chromium from ADR-0003 and the RFB client from ADR-0004

## Context

### What is already built, and what is missing

ADR-0003 settled the shared browser: one headful Chromium per session on
`Xvnc`, the human watching over RFB, Chromium's CDP endpoint on container
loopback with the port read back from `DevToolsActivePort`. Phase B shipped
that — the relay, the pane, the cursor, resize, reconnect. The human's half
works.

The agent's half does not. ADR-0003 named six tools (`browser_open`,
`browser_navigate`, `browser_click`, `browser_type`, `browser_read`,
`browser_screenshot`) and none are built. `packages/core` holds a page-scoped
CDP client (`cdp-session.ts`) used by the relay and the launch-page tests, but
there is no tool that turns a model's intent into CDP.

The question this ADR answers: **do we write that tool, or do we adopt one?**

### Prior art, checked against source

ADRs are not written from memory. Two checkouts were read for this, both in
the gitignored `ref/` tree, and the findings are recorded in
`ref/README.md`.

**Hermes Agent** (`NousResearch/hermes-agent`, MIT, Python) is the closest
prior art: an agent runtime whose browser tools drive one browser a human may
also see. Its high-level tools — `browser_navigate`, `browser_snapshot`,
`browser_click`, `browser_vision` — **do not speak CDP themselves**. They
shell out to a separate Node CLI and parse its output
(`tools/browser_tool_session.py:822,865`). Its own CDP code is a raw method
passthrough plus a supervisor, and the accessibility tree, refs, and click
logic live in that external CLI.

**agent-browser** (`vercel-labs/agent-browser`, Apache-2.0, Rust) is that
CLI. It speaks CDP directly, attaches to a running Chromium with
`--cdp <port|url>`, and exposes the accessibility tree with element refs as
its central feature. It is the piece Hermes outsources, and it does the
whole job: `snapshot`, `click`, `fill`, `press`, `wait`, `tab`,
`screenshot`, `network`, `console`, `eval`, `batch`. It has a client-daemon
architecture: each command talks to a long-lived daemon over a Unix socket
that holds the CDP connection and the ref map.

### The finding that decides it

**Adopting agent-browser is not a neutral attach. It installs itself into the
browser.** On attach it enables `Fetch` interception and re-enables it on
every new page target (`cli/src/native/actions.rs:836-1000`, `Fetch.enable`
at `:4018`), enables `Network`, injects launch init scripts, tags
cursor-interactive elements with `data-__ab-ci` during a snapshot
(`cli/src/native/snapshot.rs:849`, removed again at `:962`), and injects an
overlay during an annotated screenshot.

For a browser the agent owns headlessly, that is the design. For a browser a
human is watching, it was first read here as contamination.

**It is the opposite.** The human is watching the same framebuffer the agent
is acting on — that is Phase B, and it is the whole point. When the agent
walks the tree, the tags and overlays render into that framebuffer. When it
intercepts the network, the human sees the page it is driving. The agent's
footprints are the visible-work signal the shared browser exists to produce.
Buying that signal for free, from a tool we would otherwise write, is the
reason to adopt rather than build.

### The safety property, verified in source

One property is load-bearing and was checked rather than assumed. Over
`--cdp`, agent-browser **never sends `Browser.close`**:

```rust
if self.browser_process.is_some() {
    // Only send Browser.close when we launched the browser ourselves.
    // For external connections (--auto-connect, --cdp) we just disconnect
    // without shutting down the user's browser.
    let close = self.client.send_command_no_params("Browser.close", None);
```

`browser_process` is set only when it spawned Chromium itself
(`cli/src/native/browser.rs:1313-1320`), so an attached close is a disconnect
and nothing more. A test asserts the negative (`browser.rs:3404`). The same
guard backs `close --all` and the daemon's `close_all_browser_backends`. So
"close" means "close the connection", which is what we require, and it is a
property of the tool rather than something we add.

### A policy change this work produced

The fork's `AGENTS.md` said "MIT-only". That was stricter than the licenses
require and wrong about them: Apache-2.0 is permissive, not copyleft, and
MPL-2.0 is file-level copyleft; neither is viral across our tree. The rule
was corrected in this change. It matters here because agent-browser is
Apache-2.0, and its vendored `axe-core` is MPL-2.0. Neither was ever a legal
barrier; the correction removes a false one.

## Decision

### The agent's browser tool is a curated surface over agent-browser

Our `browser` tool maps model intent to `agent-browser` commands and returns
their `--json` output. It does not implement CDP, the accessibility tree, or
click resolution. Those already exist, are better tested than anything we
would write this phase, and bring the visible-work effect with them.

### It always attaches, and never launches or owns the browser

Every call passes `--cdp <endpoint>`, where the endpoint comes from
`DevToolsActivePort`, which the `Browser` service already reads. This is not
a preference; it is what keeps the safety property above true.

- `--auto-connect` is **never** used. It reads `DevToolsActivePort` by a
  different path and could take a launch-capable branch. `--cdp` is pinned at
  our call site.
- agent-browser must not spawn Chromium. The one browser is ours.
- The agent's session is one agent-browser session (`--session <id>`), so a
  session's agent and its human share one browser and nothing else does.

### "Close" means detach

Our tool's `close` runs `agent-browser close`, which over `--cdp` closes the
WebSocket and leaves Chromium running. It never means "kill the browser".
`close --all` is not surfaced as an agent verb.

The browser is not removed from any close path an agent can reach. The
human's browser dies when the session dies, which is the server's business,
not the agent's.

### The dangerous verbs are not exposed raw

The model gets the driving and observing vocabulary, not the process
vocabulary. Concretely, exposed: `navigate`, `snapshot`, `click`, `fill`,
`press`, `scroll`, `wait`, `evaluate`, `screenshot`, `tab new`, `tab list`,
`tab select`. Not exposed: `close --all`, `tab close`, `--auto-connect`, and
any provider flag. The agent may move the page — that is the shared-browser
goal — but it has no verb that removes the browser or the tab the human is
looking at.

### The daemon is accepted, with a known cost

agent-browser runs a daemon per session over a Unix socket that holds the CDP
connection and the ref map. It is a second process in the container with an
idle timeout. We accept it: it is what makes `@eN` refs survive between
commands, and it holds no browser while attached. Our session teardown runs
`agent-browser close` so we do not depend on the idle timer.

### The binary is a pinned build dependency

It is added to the template image, pinned to an exact version, fetched at
image build time. At runtime it is a local process and calls no external
service, so it does not violate the no-new-external-services rule. The
pin is bumped deliberately, like the template's own pins.

### This amends ADR-0003 twice, explicitly

ADR-0003 said the agent's tools are "a curated named surface over CDP ...
never raw CDP methods, so the protocol stays out of the model's reach". The
first half stands: the surface is still named, and raw CDP stays out of
reach. What changes is that the surface is implemented over agent-browser
rather than over our own CDP calls. There is one exception worth naming: an
`evaluate` verb lets the model run page JavaScript. That is not raw CDP, but
it is more reach than ADR-0003's six names implied, and it is recorded here
rather than slipped in.

ADR-0003 also said, in Out of scope: "No new server dependency that wraps a
browser driver". This ADR buys exactly that dependency. The reasoning that
put it out of scope was sound when the alternative was writing the driver
ourselves; the premise that changed is that a mature, attach-capable,
Apache-2.0 driver exists, and the visible-work effect comes with it. The
sentence is superseded for the agent's tool, not for the human's transport.

## Consequences

- **The template image gains a binary.** A pinned agent-browser build, plus
  its system dependencies if any. A manus-dei side change, like Chromium and
  `tigervnc-standalone-server` before it.
- **The accessibility tree, refs, and click resolution are not ours.**
  Recorded in `ref/README.md` as the reference if we ever need to build a
  first-party replacement, and the license now permits porting. This ADR
  chooses not to, this phase.
- **The agent's work is visible in the shared browser**, because the tool
  acts on the same framebuffer the human watches and does not hide its
  instrumentation. This is the intended effect, not a side effect.
- **The agent can see what the human types**, already true per ADR-0003 and
  unchanged here.
- **A second process exists in the container** (the daemon), with a Unix
  socket and an idle timer. Teardown closes it explicitly.
- **The daemon may create a tab** when the browser has no page target
  (`cli/src/native/browser.rs:705`). The launch page means there is
  always one, so this should not fire; it is named so a strange new tab is
  not a mystery.
- **Tests.** The tool's mapping from model intent to command, and the parse
  of `--json` output, are pure functions and are unit-tested. The attach path
  is tested against a real `agent-browser` and a real Chromium in a guarded
  integration run, asserting the browser is still alive after `close`. The
  ref workflow (`snapshot` then `click`) is tested live, since a fake would
  not exercise the part we did not write.

## Out of scope

No first-party CDP tool. No raw CDP passthrough for the model. No navigation
allowlist — agent-browser has domain filtering and we do not surface it. No
providers (Browserbase, Kernel, BrowserUse): they are external services. No
`a11y` audit, no `webmcp`, no `stream` — we have RFB. No launch or kill of
the shared browser, by any path. No telemetry.

The RFB client and the human's transport are untouched. This ADR is the
agent's half only.
