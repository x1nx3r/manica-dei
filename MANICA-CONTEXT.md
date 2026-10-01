# MANICA-CONTEXT.md — handoff to the Manica Dei agent

## 1. What phase we're in

**F0 is done and released** (`v0.1.0`): de-serviced server binary + embedded
web UI, no calls to anomalyco infrastructure, CI builds + smoke-tests the
artifact pair (`manica-dei-linux-x64.tar.gz` + `manica-dei-web-ui.zip`).

**F1 is in progress** — session-native features, tracked in `PLAN.md`:
preview proxy route, trail/spend surfacing, identity context source
(`MANUS_USER_*` env → `core/system-context/`), system-prompt stance tune.

**manus-dei side (the backend, `../`)**: the fleet UI exists and works
(login, sessions list, admin). deusd reverse-proxies sessions at
`/session/{id}/…` with the per-session password injected as Basic auth.
Transport through that proxy is proven (WebSocket dial, SSE streaming, SPA
subpaths — all green). **But the embedded session view is broken in the
browser**, which is what this document is about.

## 2. The problem you need to resolve: no cookie auth

**Symptom.** The fleet UI iframes the agent at `/session/{id}/`. The page
shell loads (`<title>Manica Dei</title>` ✓) but the app never boots. Browser
console:

```
Loading module from “…/assets/index-*.js” was blocked … disallowed MIME type ("text/plain")
The resource from “…/assets/index-*.css” was blocked due to MIME type mismatch (X-Content-Type-Options: nosniff)
```

**Root cause, verified.** Two facts combine:

1. The app bundle hardcodes root-absolute asset paths (`src="/assets/…"`)
   *and* dozens of root-absolute `/api/…` paths. Single-origin
   path-prefix proxying cannot work with this bundle — and HTML-rewriting
   the assets wouldn't suffice either, because runtime API calls would then
   hit the *wrong* `/api/*` (deusd's, not the agent's — e.g. `/api/health`
   returns deusd's health). Prefix-awareness is real fork work, correctly
   scoped to later (see §4).
2. Bypassing the proxy and loading the agent directly with `?auth_token=`
   serves the document (query-param auth works there) but **all static
   assets 401**. There is **no cookie mechanism** in the server auth
   (verified: zero `Set-Cookie` in `packages/opencode/src/server/`).
   `<script src>` / `<link>` tags cannot carry headers, so with a password
   set the app's own JS can never load. Query auth works for the document
   and for API fetches the app makes explicitly (it attaches `Basic` itself
   — see `authTokenFromCredentials` in `packages/app/src/utils/server.ts`),
   but never for subresources.

So today there is **no working way to load the UI in a browser against a
password-gated server**. That blocks the whole fleet-UI session view.

**What to build: cookie issuance on query-auth.** Small, server-only,
principled — the standard way to make query-param auth work with static
assets:

- On successful `?auth_token=` validation
  (`packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`,
  `credentialFromURL`), issue a signed `HttpOnly` session cookie and accept
  it on every subsequent request — document, static assets, API, WebSocket
  (`/pty`), SSE (`/event`).
- Browsers attach same-origin cookies automatically, which covers exactly
  the three things headers can't: `<script>`/`<link>` subresources, `new
  WebSocket()`, and `EventSource`. No app-side (`packages/app`) changes
  needed.
- Keep Basic + `?auth_token=` working as today. Sign with HMAC over the
  configured server password (no new secret to manage); per-boot rotation
  is acceptable — sessions are ephemeral, and expiry just means re-present
  the token.
- Tests: query-auth sets the cookie; assets load with cookie alone;
  API/WS/SSE accept the cookie; wrong cookie 401s.

**Out of scope for this task:** prefix-awareness (runtime API base +
asset base for subpath serving) — that's the hosted-mode fix, tracked
separately. Do not build it here; just don't preclude it (keep base-URL
construction centralized if you touch it).

## 3. What the backend expects from Manica Dei (the contract)

These are the load-bearing assumptions deusd and the fleet UI already rely
on. Keep them green; the backend verifies them end to end after every
release:

1. **Auth surface (after §2 lands):** `?auth_token=` accepted on all
   routes → sets cookie → cookie accepted on all routes (document, assets,
   API, WS, SSE). Basic auth unchanged. No password → everything public,
   unchanged.
2. **Health:** `GET /api/health` → `{"healthy":true}`. The summon gate and
   the release smoke test assert this shape.
3. **Provider/models:** `GET /provider` lists providers with models; the
   configured model id must resolve at turn time.
4. **Session lifecycle (legacy paths):** `POST /session` create,
   `POST /session/{id}/prompt_async` → `204`, `GET /session/{id}/message`
   returns the bare message array. (Note: the `/api/`-prefixed prompt path
   is *not* a real route — it 200s from the UI catch-all without doing
   anything. Do not "fix" this by adding it; the backend uses legacy.)
5. **`GET /event`** is the global SSE stream the trail harvester reads —
   message parts, errors, heartbeats must keep flowing there.
6. **`/pty` WebSocket** with ticket auth — the terminal surface.
7. **Embedded UI:** `/` serves the app shell with `<title>Manica Dei</title>`;
   the binary reports its release version via `--version`. Template pins
   releases, never `latest`.
8. **Identity context (F1.8, in progress):** `MANUS_USER_*` env → system
   context source + prompt stance. Independent of §2; either may land first.

## 4. Verification (what "done" looks like from the backend)

After the release containing §2, deusd will: summon → open the fleet
session page in a real browser flow → assert the iframe boots (no console
MIME/401 errors) → drive a turn → assert the reply. The smoke that let this
through only checked `<title>`; it now boots the JS too.
