# @manica-dei/vnc

A small RFB (VNC) client, written from the specification.

RFB is the protocol behind VNC: a server sends a framebuffer, a client sends
input back. This package speaks that protocol. It connects, negotiates a
session, decodes the framebuffer, and carries input. It knows nothing about who
the server is or why anyone is watching it.

## What it does

- RFB 3.8: version exchange, `None` security, shared sessions
- Encodings: ZRLE, Raw, CopyRect
- A `Transport` abstraction, so a caller supplies the bytes and this package
  never opens the socket itself
- A `Framebuffer` the caller draws, as RGBA

## What it does not do

- Open sockets. `webSocketTransport` builds one over a `WebSocket` the caller
  already created, but the URL, the auth, and the relay are the caller's.
- Authenticate. Only the `None` security type is supported.
- Emit a cursor yet. The cursor pseudo-encodings are recognised and skipped so
  the stream stays aligned, but the shape is not drawn.
- Handle the clipboard. Cut-text messages are surfaced to `onCutText` and not
  wired to anything.

## Install

This package lives in the Manica Dei workspace and is not published. Depend on
it by workspace name:

```json
{
  "dependencies": {
    "@manica-dei/vnc": "workspace:*"
  }
}
```

## Use

```ts
import { start, webSocketTransport, ByteQueue } from "@manica-dei/vnc"

const queue = new ByteQueue()
const socket = new WebSocket(url)
const transport = webSocketTransport(socket, queue)

const client = await start(transport, {
  queue,
  onFrame: (framebuffer) => {
    // framebuffer.width, framebuffer.height, framebuffer.data (RGBA)
  },
  onClose: (error) => {
    // error is present on failure, absent on a clean close
  },
})

client.pointer(x, y, mask) // button mask: 1 left, 2 middle, 4 right
client.key(keysym, down) // X11 keysyms
client.close()
```

`start` resolves once the handshake completes. From that point, `onFrame` is
called whenever pixels change. An incremental request may legitimately go
unanswered until the screen changes, so a still page produces one frame and
then quiet — not a hang.

## The transport seam

Everything the client needs from the outside world is a `Transport`:

```ts
type Transport = { write: (bytes: Uint8Array) => void }
```

The reply path is a `ByteQueue` the caller fills. Push whatever arrives; the
protocol reader waits for exact lengths. This is what makes the client testable
without a server: a test supplies a transport that records writes and a queue
it pushes bytes into.

`webSocketTransport` is the common case. For anything else — a Node socket, a
pipe, a recorded fixture — build the pair yourself.

## Testing

- `bun test` runs the unit tests. They use a fake server and never open a
  network connection.
- `test/reader.ts` is a minimal Raw-only reader for inspecting a real display
  from a test. It is a separate, simpler code path on purpose, so it does not
  share a bug with the client it is used to check.

Real `Xvnc` integration is exercised from the product that consumes this
package, against a running server.

## Design notes

`ref/ZRLE-REFERENCE.md` in the fork records why the decoder pulls field by
field rather than inflating a whole rectangle. The short version: a ZRLE
rectangle's inflated size is not derivable from its header, so a client that
tries to size it up front must guess, and the guess is wrong.

`pako` provides the exact-count inflate the decoder needs. The platform
`DecompressionStream` cannot express it. `pako` is `(MIT AND Zlib)`.

## License

MIT. See `LICENSE`.
