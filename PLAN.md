# PLAN — manica-dei (the manus session product)

Lineage: taken over from `anomalyco/opencode` (MIT) at `2fa3363c9` plus a
lockfile renewal; product line is `main`. Decision record:
`docs/adr/0001-product-takeover.md`; the manus-dei-side record is
`../docs/adr/007-product-fork.md` (read-only).

## End goal

The session product for manus-dei. deusd summons a container from a
template; this repo's server runs as the agent; this repo's UI is the
browser surface; manus pages (preview, trail, spend, snapshot) hang beside
a stock opencode core, same-origin through deusd. **Deep integration with
manus-dei is the point** — coupling to manus-dei is intended, and it lives
only in this repo, never upstream.

## F0 — own the artifact (now)

Status: landed on `f0-own-artifact` (2026-09-30). Boundary decisions and
residue recorded in `docs/adr/0002-f0-de-service.md`.

1. **De-service.** Remove every runtime call to anomalyco infrastructure:
   - Sentry: the `@sentry/vite-plugin` block in `packages/app/vite.config.ts`
     and the `@sentry/solid` usage in `packages/app/src/entry.tsx`.
   - The embedded-UI proxy fallback to `app.opencode.ai`
     (`packages/opencode/src/server/shared/ui.ts` — `UI_UPSTREAM`); decide
     and document the fallback behavior (our dist is always embedded or
     served — fail loudly, never proxy).
   - Upgrade check, stats/share surfaces, console/identity wiring — locate
     via a grep for `opencode.ai`, `console`, `stats`, `sentry` and remove
     or disable behind build flags.
2. **Identity.** Build-time app name (`VITE_APP_NAME` or equivalent)
   driving `packages/app/index.html` title, `site.webmanifest`,
   `theme-color`; replace `packages/app/public/` icons; restart version at
   `0.1.0`; keep `LICENSE`, add a lineage `NOTICE`.
3. **Auth UX.** `src/entry.tsx` reads `?auth_token` and strips it from the
   address bar (`clearAuthToken`). Verify the credential **survives reload**
   once stripped; if not, persist per-server credentials in the server
   store (`src/context/server.tsx`, persisted key `"server.v3"`).
4. **CI.** Lint + per-package test suites; build the linux-x64 server binary
   (`packages/opencode` `script/build.ts` single-target) and the web dist
   (`packages/app`: `bun install --ignore-scripts` — the
   `tree-sitter-powershell` native script fails and is unneeded — then
   `bun run build`); publish both as a release; smoke: boot the binary,
   `GET /api/health` returns `{pid}`.
5. **Template handoff.** Tag the release; manus-dei's `templates/base/`
   switches its pin from anomalyco releases to this repo's releases (their
   side — ADR-007 there).

**Exit:** one tag whose binary + dist boot a session under manus identity
with zero calls to anomalyco infrastructure.

## F1 — session-native features (this repo's server + UI)

Under the takeover these are simply product features — no manus-dei
dependency, no sequencing against its roadmap.

6. **The session browser.** The agent and the human work on the same page
   together. Either hands the other a URL, a page, or a decision, and the
   other picks it up. One Chromium per session in the container, driven by
   both parties, streamed to the human.
   - The **human is not in the container** — eyes, keyboard, GPU, and window
     manager are on their machine, so a page rendered inside the container
     has to reach them and **something must cross the boundary**. `Xvnc`
     plus a headful Chromium is the browser they are watching, and that is
     the constraint the design follows from: it is why a local renderer,
     an embedded client-side engine, or a two-browser design cannot serve
     this goal.
   - The server owns the lifecycle: launch, restart, teardown. It launches
     headful on `Xvnc`, which serves RFB from its own framebuffer and is
     therefore both the display server and the server. The container gains
     `tigervnc-standalone-server` and **not** `ffmpeg` or `Xvfb` — two
     processes instead of three (the manus template image changes, their
     side).
   - Both parties drive the same instance, so **there is no state
     synchronization and none is planned**. Whoever acts last wins and the
     other sees it, the way a shared screen behaves. This is what makes the
     feature affordable.
   - The agent's side is a curated tool surface over CDP — never raw CDP
     methods. The human's side is an RFB framebuffer with **ZRLE**.
   - **The human's input goes through X11, not CDP.** `Xvnc` injects it as
     real OS-level events, so IME and dead keys come from the input stack.
     The composition risk an earlier draft carried is gone rather than
     mitigated.
   - Screen size is fixed when the session starts and the client scales.
     That removes the resize edge the video design carried as its sharpest
     risk.
   - The current URL stays continuously visible in the panel. It is the one
     new risk: the human now sees whatever the agent's browser shows, so an
     agent could render a convincing login page inside our own interface.
     The same sharing means the agent can read what the human types,
     credentials included. Accepted.
   - **Transport measured 2026-10-03, and RFB won.** Keys to visible pixels
     **14.4 ms median** against the video path's 31.2 ms, consistent across
     four runs. The video path spent its budget on frame alignment — 31 ms is
     two frame intervals at 60 fps — and RFB has no vsync. Volume with ZRLE:
     keypress **2.0 KB**, scroll **25.4 KB**, against 34.6 KB and 1.64 MB
     for Raw.
   - Chromium binds its debugging port to container-loopback even with
     `--remote-debugging-address`, so `--remote-debugging-pipe` is the only
     workable form. That finding survived from the video spike.
   - **One gap:** scroll latency under ZRLE is unmeasured. With Raw it was
     48.3 ms against video's 33.3 ms, so it is the one case where video
     might still win. The fix is a two-line probe change and it does not
     need a spike. Close it in the product.
   - **The largest remaining piece is the RFB client.** RFB is a published
     spec, so we can write one and avoid noVNC's MPL-2.0 terms.
   - Status: ADR-0003 accepted 2026-10-02, transport chosen 2026-10-03.
   - Deferred to a later phase: cptr's per-tab choice between this stream and
     an iframe proxy, which needs the proxy route and a URL rewriter. The
     route and its tests are preserved on `scratch/preview-proxy`.
7. **Trail and spend.** Both are native server data — message history and
   per-session cost/tokens are already in the session objects. Surface
   them in the UI (the timeline exists; add a usage/cost view). Cross-
   *session* audit stays manus-dei's job (its registry harvests `/event`),
   and fleet-level budgets are its Phase 4 — this repo only guarantees the
   documented API those features read.
8. **Identity context + system-prompt stance** (manus-dei ADR-015). deusd
   injects four fields at summon — name, github account, human-readable
   role, and time. Render them as a synthetic System Context source
   (`packages/core/src/system-context/`, alongside `core/environment` and
   `core/date`) fed by env (e.g. `MANUS_USER_NAME`, `MANUS_USER_GITHUB`,
   `MANUS_USER_ROLE`), and tune the system prompt
   (`packages/opencode/src/session/prompt/*.txt`) so the agent's persistent
   stance is: greet the named user, read the repo's standards first, and ask
   what to work on before diving in. The opening prompt is the trigger;
   this is the stance.

## Avenues (explicitly deferred — not scheduled work)

- **Package trimming.** `console`, `web`, `docs`, `enterprise`, `identity`,
  `stats`, `slack`, `desktop`, `storybook`, `function`, … The end goal is a
  lean product integrated with manus-dei, and trimming happens once F1
  stabilizes — until then, cherry-pickability from upstream is worth more
  than leanness.
  - **Wave 0 executed 2026-10-01:** the 11 free packages (`console`,
    `enterprise`, `identity`, `stats`, `slack`, `function`, `web`, `docs`,
    `storybook`, `cli`, `containers` — nothing in the product graph
    depended on them) deleted; ~85M smaller tree, 30 → 20 turbo tasks.
    `desktop` and `tui` deliberately kept (desktop is a distribution
    surface; `tui` is a server dependency — wave 1 surgery, post-F1).
- **Hide the multi-server picker** behind a build flag; keep the code.
- **File editing.** CodeMirror plus a save endpoint behind the server's
  auth. Possible now that we own the server; a product decision, not an
  architecture one.
- **Phase 4 hooks.** Permission relay and budget enforcement live on
  manus-dei's side (its PLAN §10 Phase 4); if the server needs hooks, design
  them with that phase, not before.

## Principles

- The fork never learns manus-dei exists at the *code* level: the seam is
  opencode's documented HTTP/SSE/WS API, and manus-aware features talk to
  deusd the same way any client would.
- Keep upstream's per-package engineering guides intact
  (`packages/*/AGENTS.md`, `docs/UPSTREAM-AGENTS.md`) — they encode real
  constraints (Effect patterns, dependency direction, i18n rules).
- Every non-obvious product decision gets an ADR in `docs/adr/`.
