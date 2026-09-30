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

6. **Preview.** The **server** gains a same-origin proxy route scoped to
   container-localhost ports that the session manifest declares (guard it:
   localhost only, allowlist from the manifest — a proxy inside the
   container must not become an SSRF ladder). The UI gets a preview tab
   iframing its own server. Because the server serves the UI, API, PTY,
   and preview on one origin, nothing extra gets published and manus-dei
   needs no proxy at all.
7. **Trail and spend.** Both are native server data — message history and
   per-session cost/tokens are already in the session objects. Surface
   them in the UI (the timeline exists; add a usage/cost view). Cross-
   *session* audit stays manus-dei's job (its registry harvests `/event`),
   and fleet-level budgets are its Phase 4 — this repo only guarantees the
   documented API those features read.

## Avenues (explicitly deferred — not scheduled work)

- **Package trimming.** `console`, `web`, `docs`, `enterprise`, `identity`,
  `stats`, `slack`, `desktop`, `storybook`, `function`, … The end goal is a
  lean product integrated with manus-dei, and trimming happens once F1
  stabilizes — until then, cherry-pickability from upstream is worth more
  than leanness.
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
