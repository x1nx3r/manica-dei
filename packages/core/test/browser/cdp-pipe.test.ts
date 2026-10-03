import { describe, expect, test } from "bun:test"
import { decodeAll, decodeMessage, encodeMessage } from "@opencode-ai/core/browser/cdp-pipe"

// Framing comes from Chromium's devtools_pipe_handler.cc: PipeWriterASCIIZ
// appends a NUL, and PipeReaderASCIIZ splits on NUL. These cases pin the bytes.

describe("encodeMessage", () => {
  test("appends exactly one NUL terminator", () => {
    const encoded = encodeMessage('{"id":1}')
    expect(encoded.subarray(0, encoded.length - 1).toString("utf8")).toBe('{"id":1}')
    expect(encoded[encoded.length - 1]).toBe(0)
  })

  test("adds one byte, not a prefix", () => {
    expect(encodeMessage("abc").length).toBe(4)
  })
})

describe("decodeMessage", () => {
  test("reads a whole message", () => {
    expect(decodeMessage(encodeMessage('{"id":1}'))).toEqual({ payload: '{"id":1}', consumed: 9 })
  })

  test("waits instead of throwing when the terminator is missing", () => {
    expect(decodeMessage(Buffer.from('{"id":1}'))).toBeUndefined()
    expect(decodeMessage(Buffer.alloc(0))).toBeUndefined()
  })

  test("stops at the first NUL and leaves the rest", () => {
    const two = Buffer.concat([encodeMessage('{"id":1}'), encodeMessage('{"id":2}')])
    expect(decodeMessage(two)?.payload).toBe('{"id":1}')
  })

  test("tolerates JSON containing no NUL of its own", () => {
    // JSON cannot contain a raw NUL, which is exactly why this framing works.
    const payload = JSON.stringify({ id: 1, result: { text: "a\nb\tc" } })
    expect(decodeMessage(encodeMessage(payload))?.payload).toBe(payload)
  })
})

describe("decodeAll", () => {
  test("splits several messages from one read and keeps the remainder", () => {
    const a = encodeMessage('{"id":1}')
    const b = encodeMessage('{"id":2}')
    const partial = encodeMessage('{"id":3}').subarray(0, 4)
    const { payloads, rest } = decodeAll(Buffer.concat([a, b, partial]))
    expect(payloads).toEqual(['{"id":1}', '{"id":2}'])
    expect(rest).toEqual(partial)
  })

  test("returns nothing for a fragment", () => {
    const { payloads, rest } = decodeAll(encodeMessage('{"id":1}').subarray(0, 5))
    expect(payloads).toEqual([])
    expect(rest.length).toBe(5)
  })

  test("handles two messages arriving in one chunk", () => {
    const { payloads } = decodeAll(Buffer.concat([encodeMessage("a"), encodeMessage("b"), encodeMessage("c")]))
    expect(payloads).toEqual(["a", "b", "c"])
  })
})
