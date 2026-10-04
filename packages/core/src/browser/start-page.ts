// The page the session browser opens on.
//
// The browser is in a container the session owns, and it is persistent for the
// life of the session: anything typed into it stays there, and the agent can
// read the same page. That is worth saying plainly at the moment the human first
// looks, because a page asking for a password looks identical whether it is a
// throwaway container or their own machine.
//
// It is a `data:` URL rather than a file or a fetched page. A file would need the
// container image to carry it and a path contract between the two products; a
// fetched page would be a network dependency at every launch, and the product
// forbids new external services. A data URL is none of those: it ships with the
// code that spawns the browser and needs nothing at runtime.

/**
 * The warning page, as HTML.
 *
 * Styled to read as part of the product rather than as an error: dark, quiet, one
 * heading and three short lines. No external resources at all — no fonts, no
 * images — so it renders the same with no network.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This browser is in a container</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0a0a0a;
    color: #e8e8e8;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
  }
  main { width: 100%; max-width: 620px; }
  .mark {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8a8a8a;
    margin-bottom: 28px;
  }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: #d9a441; }
  h1 {
    font-size: 26px;
    line-height: 1.25;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 16px;
  }
  p { font-size: 15px; line-height: 1.6; color: #a8a8a8; margin: 0 0 12px; }
  strong { color: #e8e8e8; font-weight: 600; }
  ul { margin: 24px 0 0; padding: 0; list-style: none; }
  li {
    font-size: 14px;
    line-height: 1.5;
    color: #a8a8a8;
    padding: 12px 0;
    border-top: 1px solid #1e1e1e;
  }
  li:last-child { border-bottom: 1px solid #1e1e1e; }
  .label { color: #e8e8e8; font-weight: 600; }
  footer { margin-top: 28px; font-size: 12px; color: #6a6a6a; }
</style>
</head>
<body>
<main>
  <div class="mark"><span class="dot"></span>Containerized browser</div>
  <h1>This browser runs in a container, and it is persistent.</h1>
  <p>
    Anything you type here stays in this session. The agent shares this same
    page and can read it.
  </p>
  <ul>
    <li><span class="label">Never enter passwords, passphrases, or payment details.</span> Not for any site, however familiar it looks.</li>
    <li><span class="label">Sign-in pages you find here may not be genuine.</span> A page can look like a service you trust and not be it.</li>
    <li><span class="label">Treat everything on this display as visible to the session.</span> It is not a private window.</li>
  </ul>
  <footer>Navigate away when you are ready. This page is only the starting point.</footer>
</main>
</body>
</html>`

/**
 * The warning page as a URL Chromium can open at launch.
 *
 * Percent-encoded rather than base64 so the markup stays readable in a devtools
 * address bar and in a log, which matters more than the few bytes base64 would
 * save. `encodeURIComponent` covers the `#` and `%` that CSS is full of.
 */
export function warningPageUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`
}

export const WARNING_PAGE_HTML = PAGE
