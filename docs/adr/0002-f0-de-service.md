# ADR-0002: F0 de-service boundary — what was removed, what was kept, and why

Status: accepted · Date: 2026-09-30
Companion: PLAN.md F0; manus-dei ADR-006/ADR-007 (read-only)

## Context

F0 requires zero runtime calls to anomalyco infrastructure. Sweeping the
tree (grep for `opencode.ai`, `sentry`, `share`, `console`, `stats`,
`telemetry`) surfaced more call paths than PLAN F0 named. This record
pins each judgment call so the next sweep does not relitigate them.

## Decisions

1. **UI proxy fallback: removed, fail loudly.** The embedded-UI fallback
   proxied to `app.opencode.ai`. Our dist is always embedded by fork CI
   (`script/build.ts` embeds `packages/app/dist`); a missing bundle is a
   build defect, so the server now answers 503 instead of proxying.

2. **Upgrade surface: removed wholesale.** `opencode upgrade`, the
   `/global/upgrade` endpoint, the TUI `checkUpgrade` call, and
   `Installation.latest` (which fetched opencode.ai/install, npm/brew/
   choco/scoop registries, and the GitHub releases API). The binary in a
   manus template is versioned by the template pin, never self-upgraded.
   `Installation.method` survives for the local uninstall command.

3. **Session share: disabled by default, code retained.** Share uploads
   transcripts to a hosted share service. The guard is inverted:
   disabled unless `OPENCODE_ENABLE_SHARE` is set. Excision (module,
   endpoints, `SessionShareTable` migration) rides the package-trimming
   avenue; the deployment-level second lock is
   `OPENCODE_DISABLE_SHARE=true` baked by the template entrypoint.

4. **Console/identity wiring: removed.** The `opencode account` command,
   the console config fetch with `OPENCODE_CONSOLE_TOKEN`,
   `consoleState`, and the `/experimental/console*` endpoints. manus
   sessions get providers from baked config, not a console org.

5. **OpenCode Go upsell: removed everywhere it surfaced.** Retry-time
   upsell actions and links, the usage-exceeded dialogs, and the
   Zen connect/marketing UI (unpaid-model dialogs, featured-provider
   placement, desktop oauth client_id special case, the
   `opencode auth login` hint). Zen remains selectable like any provider
   via manual API key — the *marketing and oauth identity flows* are
   what a session product must not carry. Dormant i18n strings were left
   in place rather than churning ~40 locales.

6. **`opencode github`: removed.** It called `api.opencode.ai` for the
   GitHub agent integration. `opencode pr` stays: local git only.

7. **models.dev: kept, vendoring deferred.** It is provider/model
   metadata fetched and cached at runtime, not telemetry, and manus
   templates bake exact providers anyway. Vendoring (via the existing
   models-snapshot mechanism) is a later avenue, decided here so it is
   not mistaken for an oversight.

## Consequences

- The session payload (server + embedded UI) makes no anomalyco calls;
  the only outbound identity surfaces left are models.dev metadata and
  user-invoked, user-chosen providers (API keys the operator bakes).
- Fork CI (`.github/workflows/`) replaces upstream's 27 workflows with
  CI (app + opencode suites) and tag-triggered releases that build the
  linux-x64 binary with the UI embedded, smoke `GET /api/health`, and
  publish binary + web dist for the template pin.
- Version identity restarts at `0.1.0`; `NOTICE` records the lineage.
