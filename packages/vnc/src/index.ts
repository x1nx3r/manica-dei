// @manica-dei/vnc — a small RFB (VNC) client.
//
// The public surface is one connection and the pieces a caller needs to talk
// to it. Everything below that — the handshake staging, the byte framing, the
// ZRLE decoder, the request pacing — is an implementation detail.
//
// The three shapes a caller actually holds:
//
// - `Transport` — a sink. Anything with a `write(Uint8Array)`. A WebSocket, a
//   socket, a pair of buffers in a test.
// - `Framebuffer` — the pixels. `{ width, height, data }`, RGBA, row major.
// - `Interface` — a running session. Input in, frames out.
//
// A session is started with `start(transport, options)`. It resolves once the
// handshake completes, so a caller has a framebuffer to draw from that point
// on; updates then arrive through `onFrame`.
//
// `webSocketTransport` builds the common transport over a WebSocket. What the
// socket points at is the caller's business: this package knows nothing about
// tickets, relays, or sessions.

export { start, webSocketTransport, RfbError, type Interface, type Options, type Transport } from "./client"

export {
  ByteQueue,
  ENCODING,
  PIXEL_FORMAT,
  ProtocolError,
  handshake,
  encodeSetPixelFormat,
  encodeSetEncodings,
  encodeFramebufferUpdateRequest,
  encodeKeyEvent,
  encodePointerEvent,
  encodeSetDesktopSize,
  encodeEnableContinuousUpdates,
  unionRect,
  type DamageRect,
  type Cursor,
  type DesktopSize,
  type RectHeader,
  type Screen,
  type ServerInit,
  type Update,
} from "./protocol"

export { createFramebuffer, ZrleDecoder, decodeRaw, decodeCopyRect, type Framebuffer, type Rect } from "./decode"

export { Inflator, InflateError } from "./inflate"
