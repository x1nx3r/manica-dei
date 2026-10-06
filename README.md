# Manica Dei

*The hand, mirrored.* The session surface for
[manus-dei](../..): one process inside the session container that runs the
agent **and** serves the browser UI it is driven through. A human and an
agent share **one live browser** — the agent drives it over CDP, the human
watches and takes the wheel over RFB, and both act on the same page.

You vibecode in the browser; the agent works beside you in the same window.

manus-dei summons the container from a template and owns the fleet; this
repo is product code and runs inside it. The seam between them is
opencode's documented HTTP/SSE/WS API, surfaced same-origin through deusd
— never a second door.

| Document | Purpose |
|---|---|
| [PLAN.md](PLAN.md) | Product plan: F0 → F1 → avenues |
| [AGENTS.md](AGENTS.md) | Rules for agents working in this repo |
| [docs/adr/](docs/adr/) | Why things are the way they are |

## Verify

```bash
bun install                  # from the repo root, not a package dir

bun turbo typecheck          # all packages
cd packages/opencode && bun test     # the server suite
cd packages/app      && bun run test # the UI suite (its script sets conditions)
cd packages/vnc      && bun test     # the RFB client suite
```

The VNC suite has guarded live tests that drive a real Xvnc. They skip
silently unless the guard is set:

```bash
cd packages/vnc && MANUS_INTEGRATION=1 bun test
```

## Status

The shared browser works end to end and is released. `v0.3.1` is the
current tag; fork CI publishes the linux-x64 server binary and the web
dist, and the template pins that release.

Two halves, and only one of them is unusual:

- **The agent's half is a `browser` tool** over `agent-browser` — the full
  surface (snapshot with `@eN` refs, click, fill, wait, tabs, screenshot,
  network, console) with the dangerous verbs refused by construction. It
  always attaches to the session's own Chromium and can never launch,
  close, or repoint a browser. `docs/adr/0005-agent-browser-tool.md`.
- **The human's half is ours**: `packages/vnc`, an RFB client written
  against the specification. ZRLE decode, cursor pseudo-encoding,
  `SetDesktopSize`, continuous updates, damage-based repaint. This is the
  part almost nobody builds, and it is why the human half is not a
  screenshot log.

What is left is integration, not invention: the template pins `v0.2.5` and
must move to `v0.3.1`, and `agent-browser` is not in the image yet. See
`ref/CONTEXT-HANDOFF-AGENT-BROWSER.md` (local) for the exact delta.

## Quick start (dev)

The server and the UI run as two processes, because local UI changes do not
show through the hosted proxy paths.

```bash
# backend — the fork's server
cd packages/opencode
OPENCODE_DB=/tmp/opencode/dev.db \
  bun run ./src/index.ts serve --port 4096

# app — in another shell
cd packages/app
bun dev --port 4444
```

Open http://localhost:4444 and add a server pointing at
`http://localhost:4096`. Do not set `OPENCODE_SERVER_PASSWORD` locally: the
app does not send credentials unless you add them in the server dialog, and
every request returns 401 without them. The server binds loopback, so no
password is needed for a dev run.

`OPENCODE_DB` keeps a dev run off your real database. Point it at a scratch
file and your normal sessions are untouched.

To exercise the browser tool the server must find `agent-browser` on
`PATH` — the tool spawns it by name:

```bash
agent-browser --version      # must resolve
agent-browser doctor         # launch test + a Chrome-for-Testing check
```

Ask the session browser to open a page and it appears in the pane. If the
tool errors with "not found", this is why.

## Local development dependencies

What you need depends on what you are changing.

| To work on | You need |
|---|---|
| The UI, the server, the tests | Bun only |
| The shared browser | the four executables below |
| Window-follow (window tracks the pane) | `xrandr` — optional |

### The browser stack

Four executables, spawned **by name from `PATH`**:

| Binary | Provides | Required |
|---|---|---|
| `Xvnc` | TigerVNC's display server | yes |
| `chromium` | a real headful browser | yes |
| `agent-browser` | the CLI the `browser` tool spawns | yes |
| `xrandr` | screen size, so the window follows the pane | no |

Linux:

```bash
# Arch
sudo pacman -S tigervnc xorg-xrandr chromium

# Debian/Ubuntu — but read the chromium note below first
sudo apt install tigervnc-standalone-server x11-xserver-utils

# the CLI, on any platform with node
npm install -g agent-browser
```

**`chromium` is the trap on Ubuntu.** 26.04 carries no deb chromium;
`chromium-browser` is a snap transitional shim and useless in this context.
The template works around it with a pinned Chrome for Testing symlinked to
`chromium`, and the same approach works locally. See
`../../docs/upstream-finding/chromium-is-not-in-ubuntu-26-04.md`.

**`agent-browser` needs only its CLI here.** Our tool always attaches with
`--cdp <port>` to the session's own Chromium, so the browser that
`agent-browser install` would fetch is never launched. The CLI on `PATH` is
the whole requirement.

**`xrandr` missing is not fatal.** `window-follow` reads the screen size and
quietly does nothing when it cannot, so the browser still runs; the window
just stops tracking the pane.

There is no preflight. A missing binary surfaces as a launch error that does
**not** name the tool — `chromium did not spawn`, or `RFB port <n> never
answered` when `Xvnc` is absent. If the browser pane fails to start, check
`PATH` for all four before looking anywhere else.

### On macOS

The app and the server are cross-platform; the browser stack is not. It
spawns Linux X11 binaries — `Xvnc`, a `chromium` on `PATH`, `xrandr` — and
macOS ships no X server and no binary under the name `chromium` (Chrome for
macOS is `Google Chrome.app`). Assembling a native equivalent is not a
supported or tested path, so treat it as out of scope.

What works on a mac: the UI, the server, the TUI, and the test suites — so
all ordinary work, and all of `packages/vnc` against a fake server.

To exercise the shared browser from a mac, run the server where the X11
stack lives — a Linux host, or the session container — and point the local
app at it. The app's add-server dialog takes any URL, and the RFB relay
runs through that server, so the display never has to be local:

```bash
# on the Linux host
cd packages/opencode && bun run ./src/index.ts serve --port 4096

# on the mac — the app is just a web UI pointed at a server
cd packages/app && bun dev --port 4444
# then add http://<linux-host>:4096 in the server dialog
```

This mirrors manus-dei's own model: the mac is a development machine
driving a Linux host, not a second fleet. The dev image below is the quickest
way to get such a host.

### A dev image

`Dockerfile.dev` ships the whole browser stack — `Xvnc`, Chromium,
`agent-browser`, `xrandr` — plus Bun, so none of the installs above are
needed. It mirrors manus-dei's session image (`templates/base/Dockerfile`) on
purpose: the same Ubuntu base, the same pinned Chrome for Testing under the
name `chromium`, the same pinned `agent-browser`. A bug that reproduces in a
session reproduces here.

```bash
docker build --platform linux/amd64 -f Dockerfile.dev -t manica-dei-dev .

docker run --rm -it --platform linux/amd64 \
  -v "$PWD":/workspace \
  -p 4096:4096 -p 4444:4444 \
  manica-dei-dev

# inside the container
bun install
bun run ./src/index.ts serve --hostname 0.0.0.0 --port 4096
```

The repo is mounted, not copied, so edits are live and the image stays the
environment. The server must bind `0.0.0.0` to be reachable from outside the
container. Chrome for Testing is linux64, so the image is `linux/amd64` and the
`--platform` flag above is load-bearing: a no-op on an amd64 host, emulation on
Apple silicon.

To exercise the pane, point the app at that server:

```bash
cd packages/app && bun dev --port 4444
# then add http://localhost:4096 in the server dialog
```

## The shared browser, in one paragraph

A session gains one Chromium in the container, headful on Xvnc. Xvnc is
display server and RFB server in one process, so the human's pixels cross
the boundary as ZRLE rectangles over a WebSocket relay — no video codec and
no second port. The agent's side is CDP on container loopback. There is no
state synchronisation and none is planned: whoever acts last wins, and the
other sees the next frame. That is the whole design, and it is what makes
it affordable.

Both surfaces are reachable only on **container loopback**; deusd publishes
only the agent port.

## Layout

A bun workspace. The two shipped packages:

- `packages/opencode` — the server: agent runtime, HTTP/SSE/WS API, PTY,
  the `browser` tool, embedded web UI
- `packages/app` — the web UI, including the browser pane

The browser stack, split by concern:

```
packages/vnc        a generic RFB client — knows nothing about browsers
packages/core/src/browser/   the session browser: Xvnc + Chromium, CDP,
                             the relay, the launch page, window-follow
packages/opencode/src/tool/browser.ts   the agent's tool, over agent-browser
```

`packages/vnc` speaks RFB to any server. Swapping the two spawns in
`core/src/browser/browser.ts` points the pattern at a different program
with no change below it.

`docs/` holds the plan and the ADRs; `.github/workflows/` holds CI and
tag-triggered releases.

## Law

`AGENTS.md` at the root is binding for agents working here. Three rules
carry the rest:

- **No calls to upstream infrastructure.** Every inherited one is removed
  and stays removed. `docs/adr/0002-f0-de-service.md`.
- **The agent's browser tool is narrow by construction.** It cannot start
  or close a browser, point at a different one, or read cookies, storage,
  or the clipboard. Adding one of those means deleting a test that says
  why it is refused.
- **`main` is the product; `dev` mirrors upstream, fetch-only.** Upstream
  is pull-only cherry-picks. `docs/adr/0001-product-takeover.md`.

## License

MIT — see [`LICENSE`](LICENSE) (upstream copyright retained) and
[`NOTICE`](NOTICE) (lineage). Third-party code enters only under a
permissive license or MPL-2.0; ELv2 is excluded outright.
