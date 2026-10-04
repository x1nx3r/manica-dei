# AGENTS.md — manica-dei

Guidelines for AI coding agents working in **this** repository (the fork).

manica-dei is a **product built on opencode** — an MIT takeover of
`anomalyco/opencode`, not a tracking fork (ADR-0001,
`../docs/adr/007-product-fork.md` on the manus-dei side). It is the agent
runtime and the browser surface for **manus-dei** sessions: deusd summons a
container, this server runs as the agent, and this UI is what the user
sees. **The end goal is deep integration with manus-dei** — manus pages
(preview, trail, spend, snapshot) hanging beside a stock opencode core,
same-origin through deusd. Coupling to manus-dei is intended and lives only
here, never upstream.

## Branches and upstream

- `main` is the product. All work lands here.
- `dev` mirrors `anomalyco/opencode` — **fetch-only**. Never push to
  anomalyco. Never merge `dev` into `main` wholesale.
- The upstream relationship is **pull-only cherry-picks** (security fixes
  first), taken when we decide, on no schedule.

## manus-dei relationship

- The manus-dei checkout is the **parent directory (`../`)**. For agents in
  this repo it is **READ-ONLY**: read `../docs/adr/006-opencode-native-surface.md`,
  `../docs/adr/007-product-fork.md`, `../docs/PLAN.md` (§12 surface
  contract, §10 roadmap) and `../internal/app/port/` (the port interfaces)
  to keep the API contract aligned. Never modify, commit, or create files
  there.
- The seam between the products is opencode's documented HTTP/SSE/WS API —
  summarized in `../docs/PLAN.md` §12 ("Surface contract"). **Assume the UI
  is served same-origin with/through deusd.** Never hardcode absolute URLs
  or cross-origin assumptions; the opencode server port never leaves the
  container's loopback.

## Hard rules

- **No new telemetry or external services**, and removing inherited ones is
  required work, not optional (Sentry, the `app.opencode.ai` UI-proxy
  fallback, upgrade checks, stats/share, console/identity wiring — see
  `PLAN.md` F0). The product must not call anomalyco infrastructure.
- **License**: our own code is MIT — keep `LICENSE` and the upstream copyright
  notice; our additions carry the same license. We may also take in third-party
  code under any **permissive** license, and under **MPL-2.0** (weak,
  file-level copyleft). Apache-2.0 is permissive, not copyleft: keep its
  `LICENSE`/`NOTICE` and state what we changed. If we modify an MPL-2.0 file,
  that file stays MPL-2.0; files we write are ours. No license here is viral
  across our tree. The one exclusion is **ELv2** (`ref/computer`, cptr): never
  ship it, never vendor it.
- **Engineering rules for code work** live in
  `docs/UPSTREAM-AGENTS.md` (the relocated upstream guide) and the
  per-package `AGENTS.md` files. They still apply — follow them.
- **No package trimming yet.** Which packages stay/go is a deferred avenue
  (`PLAN.md` → Avenues): until integration stabilizes, the ability to
  cherry-pick from upstream is worth more than leanness.
- **Tests**: keep the per-package suites green; manus additions get tests in
  the same style, next to the code they cover.

## Roadmap

`PLAN.md` at the repo root — F0 (own the artifact) → F1 (integration
surface) → Avenues. "Later" tiers are sequenced with manus-dei phases; read
both PLANs before scheduling work, and record non-obvious decisions as ADRs
in `docs/adr/`.
