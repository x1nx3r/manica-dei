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
   - The human's browser is outside the container and the agent's Chromium
     is inside it, so the instance is shared by **streaming its output**.
     That is the constraint the whole design follows from, and it is why a
     local renderer, an embedded client-side engine, or a two-browser design
     cannot serve this goal.
   - The server owns the lifecycle: launch, resize, restart, teardown. It
     launches headful on `Xvfb` and encodes with `ffmpeg`, because Chromium
     has no native H.264 screencast. Those become container dependencies
     (the manus template image changes, their side).
   - Both parties drive the same instance, so **there is no state
     synchronization and none is planned**. Whoever acts last wins and the
     other sees it, the way a shared screen behaves. This is what makes the
     feature affordable.
   - The agent's side is a curated tool surface over CDP — never raw CDP
     methods. The human's side is decoded video plus dispatched input.
   - Text entry uses `Input.insertText`, so composition and IME work. The
     reference implementations synthesize from `charCode` and are
     ASCII-only; that is not acceptable here.
   - The current URL stays continuously visible in the panel. It is the one
     new risk: the human now sees whatever the agent's browser shows, so an
     agent could render a convincing login page inside our own interface.
   - **Sequence the transport first.** Spike Chromium + `Xvfb` + `ffmpeg` +
     WebSocket + WebCodecs with no product surface, and measure latency,
     frame rate, CPU, and input responsiveness. Then build the product on
     whatever that validates.
   - Status: ADR-0003 accepted 2026-10-02.
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
