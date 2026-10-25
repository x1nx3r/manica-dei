import { describe, expect, test } from "bun:test"
import { autoFocusAllowed } from "@opencode-ai/core/util/dom"

// ADR-018: the fleet embeds a session in a cross-origin iframe. Chrome blocks
// autofocus there and logs a warning, so automatic focus is skipped when the
// page is not the top-level window (issue #33).
describe("autoFocusAllowed", () => {
  test("only the top-level window may take focus without a gesture", () => {
    const top = {}
    expect(autoFocusAllowed(top, top)).toBe(true)
    expect(autoFocusAllowed({}, top)).toBe(false)
  })
})
