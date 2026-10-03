// CDP over the remote debugging pipe.
//
// Chromium reads fd 3 and writes fd 4 (`content_switches.cc` spells it
// "[in=3, out=4]", and `devtools_pipe.h` has kReadFD = 3, kWriteFD = 4). Node
// hands the child a duplex channel for each "pipe" entry, so both directions
// work from the same stdio array.
//
// The framing is **bare JSON, NUL-terminated**, and this is not a guess. From
// `content/browser/devtools/devtools_pipe_handler.cc`:
//
//   class PipeWriterASCIIZ::WriteIntoPipe:
//     WriteBytes(message.data(), message.size());
//     WriteBytes("\0", 1);
//
//   class PipeReaderASCIIZ::ReadLoopInternal:
//     walks the read buffer looking for a null byte, and everything before it
//     is one message.
//
// Do not confuse this with the CBOR envelope in
// `third_party/inspector_protocol/crdtp/cbor.cc`. That code is real, it is used
// by other CDP transports, and this pipe does not use it. Sending an envelope
// here makes Chromium answer `{"error":{"code":-32700,"message":"JSON: no
// input at position 0"}}`, because it tries to parse the leading 0x00 as JSON.

const MAX_BUFFER = 100 * 1024 * 1024 // Chromium's kReceiveBufferSizeForDevTools

/** One CDP message: bare JSON followed by a NUL byte. */
export function encodeMessage(payload: string): Buffer {
  return Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0])])
}

export type Decoded = { payload: string; consumed: number }

/**
 * Decode one NUL-terminated message from the head of `buffer`.
 * Returns undefined when no complete message is present yet.
 */
export function decodeMessage(buffer: Buffer): Decoded | undefined {
  const nul = buffer.indexOf(0)
  if (nul < 0) {
    if (buffer.length > MAX_BUFFER) throw new Error("cdp-pipe: unterminated message exceeded the buffer limit")
    return undefined
  }
  return { payload: buffer.subarray(0, nul).toString("utf8"), consumed: nul + 1 }
}

/** Pull every complete message out of `buffer`, returning the unread remainder. */
export function decodeAll(buffer: Buffer): { payloads: string[]; rest: Buffer } {
  const payloads: string[] = []
  let rest = buffer
  for (;;) {
    const decoded = decodeMessage(rest)
    if (!decoded) return { payloads, rest }
    if (decoded.payload) payloads.push(decoded.payload)
    rest = rest.subarray(decoded.consumed)
  }
}
