# ADR-0004: The VNC client is its own package

Status: accepted · Date: 2026-10-03
Depends on: ADR-0003 (the session browser chooses RFB)

## Context

The RFB client behind the session browser works. It decodes ZRLE against a
real `Xvnc`, it carries input, and it paints a page in the pane. It also
took far longer to get there than it should have, and the reason is worth
recording because it decides the shape of the package.

Every bug in that work needed the same test: _what does the server actually
send in reply to this?_ The client under test sat behind four layers — the
app, the SDXL context, the relay, the backend — and reaching a live server
meant standing all of them up. So each question became a probe of the whole
product, and each wrong guess cost an hour. The decoder's shape was wrong
four times; the request pacing was wrong once and deadlocked a static page.

The client code itself was never the problem. It is a clean, self-contained
protocol implementation: four files, one external dependency (`pako`), no
product types crossing its boundary. What was wrong was that the only way to
test it was to run the product.

## Decision

**Move the RFB client into `packages/vnc` (`@manica-dei/vnc`), a separate
package with its own tests and its own test harness.**

The package owns the protocol and nothing else:

- `src/protocol.ts` — framing, handshake, message encoding
- `src/decode.ts` — ZRLE, Raw, CopyRect
- `src/inflate.ts` — the exact-count zlib inflate, over `pako`
- `src/client.ts` — the connection and its loop
- `src/index.ts` — the public surface

It knows nothing about sessions, tickets, relays, or Chromium. Its whole
outside world is a `Transport` (`{ write(bytes) }`) and a `ByteQueue` the
caller fills. That is what makes it testable: a test supplies the pair and
the conversation is in-process bytes.

**The product-specific relay stays in `packages/core` as `browser/relay.ts`.**
The ticket request, the `x-opencode-directory` header, and the
`/browser/connect` path are opencode's convention, not RFB's. Putting them in
a general library would make the library a lie. `core` keeps the browser
lifecycle, the CDP connection, and the ticket service; `relay.ts` is the one
file that joins them to the client.

## What this buys

- **The client is testable one layer down.** The whole class of "run the
  product to see one byte" disappears. A fake server drives the handshake and
  scripted updates with no socket at all.
- **The failing tests move with the code.** The decoder's references
  (`ref/ZRLE-REFERENCE.md`), the fake server, and the real-server reader all
  live where the code does.
- **The licence boundary is preserved, not reopened.** The package is MIT and
  carries its own `LICENSE`. `pako` stays a normal dependency, recorded as
  `(MIT AND Zlib)`.

The extraction already found a bug the old arrangement hid. The fake server
emitted three bytes per Raw pixel, where the client correctly reads four. The
old test only passed because it replayed the handshake a second time, which
supplied the two missing bytes by accident. That test was pinning a fixture
bug as if it were behaviour — exactly the failure mode this package exists to
end.

## Consequences

- Consumers import from two places: `@manica-dei/vnc` for the client and the
  `Framebuffer` type, `@opencode-ai/core/browser/relay` for the connection.
  This is deliberate. The seam shows where the general library ends and the
  product begins.
- The package is `private` and workspace-only for now. It is not published.
  If it earns a repository of its own later — and it is general enough to —
  the move is mechanical, because it already has a test suite worth releasing.
- The cursor pseudo-encodings are recognised and skipped to keep the stream
  aligned, but the cursor is not drawn. That is the next feature, and it will
  be built here, against the fake server.
