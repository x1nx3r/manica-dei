# Manica Dei

The session surface for [manus-dei](../..): one process that runs the coding
agent and serves the browser UI a session is driven through.

deusd summons a container from a template; this repo's server runs inside it
as the agent; this UI is what the user sees. manus pages (preview, trail,
spend, snapshot) hang beside a stock opencode core, same-origin through
deusd.

## Lineage

A product takeover of [`anomalyco/opencode`](https://github.com/anomalyco/opencode)
(MIT) at `2fa3363c9` — not a tracking fork. `main` is the product line;
`dev` mirrors upstream, fetch-only; upstream is pull-only cherry-picks.
See `docs/adr/0001-product-takeover.md` and `docs/adr/0002-f0-de-service.md`.

## Layout

- `packages/opencode` — the server: agent runtime, HTTP/SSE/WS API, PTY,
  embedded web UI
- `packages/app` — the web UI (built by fork CI and embedded into the
  server binary)
- `docs/` — product plan (`PLAN.md`), ADRs, upstream engineering guide
- `.github/workflows/` — CI (app + opencode suites) and tag-triggered
  releases publishing the linux-x64 server binary and web dist

## Law

`AGENTS.md` at the root is binding for agents working here. Product
direction lives in `PLAN.md` (F0 → F1 → avenues). The product makes no
calls to upstream infrastructure; the seam to manus-dei is opencode's
documented HTTP/SSE/WS API and deusd's same-origin proxying only.

## License

MIT — see `LICENSE` (upstream copyright retained) and `NOTICE` (lineage).
