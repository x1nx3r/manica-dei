import { describe, expect, test } from "bun:test"
import { createKeyReleaser, keyHandlers } from "./browser-keys"

const CONTROL = 0xffe3
const SHIFT = 0xffe1

describe("pressed keys", () => {
  test("release sends a key-up for every held key, exactly once", () => {
    const sent: [number, boolean][] = []
    const keys = createKeyReleaser((keysym, down) => sent.push([keysym, down]))
    keys.down(CONTROL)
    keys.down(SHIFT)
    expect(keys.pressed()).toBe(2)

    keys.release()
    expect(sent).toEqual([
      [CONTROL, true],
      [SHIFT, true],
      [CONTROL, false],
      [SHIFT, false],
    ])
    expect(keys.pressed()).toBe(0)

    keys.release()
    expect(sent).toHaveLength(4)
  })

  test("a keyup clears the entry, and an unmatched up is still sent", () => {
    const sent: [number, boolean][] = []
    const keys = createKeyReleaser((keysym, down) => sent.push([keysym, down]))

    // Held before the canvas took focus: the remote still needs the release.
    keys.up(CONTROL)
    expect(sent).toEqual([[CONTROL, false]])

    keys.down(CONTROL)
    keys.up(CONTROL)
    keys.release()
    expect(sent).toEqual([
      [CONTROL, false],
      [CONTROL, true],
      [CONTROL, false],
    ])
  })
})

describe("canvas handlers", () => {
  const bind = (keys: ReturnType<typeof createKeyReleaser>) => {
    const handlers = keyHandlers(keys)
    const canvas = document.createElement("canvas")
    canvas.tabIndex = 0
    canvas.addEventListener("keydown", handlers.onKeyDown)
    canvas.addEventListener("keyup", handlers.onKeyUp)
    canvas.addEventListener("blur", () => keys.release())
    document.body.append(canvas)
    return canvas
  }

  test("Ctrl down followed by blur releases Ctrl", () => {
    const sent: [number, boolean][] = []
    const keys = createKeyReleaser((keysym, down) => sent.push([keysym, down]))
    const canvas = bind(keys)

    try {
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", bubbles: true }))
      expect(sent).toEqual([[CONTROL, true]])
      expect(keys.pressed()).toBe(1)

      // Focus leaves before the release: the composer, another pane, the OS.
      canvas.blur()
      expect(sent).toEqual([
        [CONTROL, true],
        [CONTROL, false],
      ])
      expect(keys.pressed()).toBe(0)
    } finally {
      canvas.remove()
    }
  })

  test("a normal keyup is not released twice by the blur", () => {
    const sent: [number, boolean][] = []
    const keys = createKeyReleaser((keysym, down) => sent.push([keysym, down]))
    const canvas = bind(keys)

    try {
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", bubbles: true }))
      canvas.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true }))
      canvas.blur()
      expect(sent).toEqual([
        [CONTROL, true],
        [CONTROL, false],
      ])
    } finally {
      canvas.remove()
    }
  })

  test("an unmapped key is dropped, not guessed", () => {
    const sent: [number, boolean][] = []
    const keys = createKeyReleaser((keysym, down) => sent.push([keysym, down]))
    const canvas = bind(keys)

    try {
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Unidentified", bubbles: true }))
      expect(sent).toEqual([])
      expect(keys.pressed()).toBe(0)
    } finally {
      canvas.remove()
    }
  })
})
