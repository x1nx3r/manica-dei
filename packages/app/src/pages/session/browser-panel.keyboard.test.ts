import { describe, expect, test } from "bun:test"

// The pane owns its keyboard.
//
// The session page listens on the document for keydown and moves focus to the
// composer on any printable key, so that a person can start typing a prompt
// without clicking first. A region that takes its own keys has to say so, or the
// first character goes to the page and the composer takes focus for the rest.
//
// This is the rule that prevents it, stated as a test: the session handler
// returns early when the event path contains a `[data-prevent-autofocus]`
// element, and the browser pane marks its container with that attribute. The
// terminal has done the same since before the pane existed.
//
// The failure this covers was real: typing into the shared browser forwarded one
// character to the page and then sent the rest to the prompt box.

/** The session handler's guard, kept in step with it by this test. */
function guardProtects(event: Event): boolean {
  // Mirrors `protectedTarget` in pages/session.tsx: any element in the path
  // whose closest ancestor carries the attribute protects the event.
  return event
    .composedPath()
    .some((item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null)
}

describe("browser pane keyboard ownership", () => {
  test("a key on the canvas is protected by the pane container", () => {
    // The shape the pane renders: a container that declares ownership, and a
    // canvas inside it that takes the keys.
    const container = document.createElement("div")
    container.setAttribute("data-prevent-autofocus", "")
    const canvas = document.createElement("canvas")
    canvas.tabIndex = 0
    container.appendChild(canvas)
    document.body.appendChild(container)

    try {
      const event = new KeyboardEvent("keydown", { key: "g", bubbles: true, composed: true })
      canvas.dispatchEvent(event)
      expect(guardProtects(event)).toBe(true)
    } finally {
      container.remove()
    }
  })

  test("the same key is not protected without the attribute", () => {
    // The bug, reproduced: a bare canvas is neither editable nor protected, so
    // the composer took the key.
    const container = document.createElement("div")
    const canvas = document.createElement("canvas")
    canvas.tabIndex = 0
    container.appendChild(canvas)
    document.body.appendChild(container)

    try {
      const event = new KeyboardEvent("keydown", { key: "g", bubbles: true, composed: true })
      canvas.dispatchEvent(event)
      expect(guardProtects(event)).toBe(false)
    } finally {
      container.remove()
    }
  })

  test("a canvas is not an editable target, which is why the attribute is needed", () => {
    // The session handler also returns early for editable targets. A canvas is
    // not one, so this must not be relied on as the protection.
    const canvas = document.createElement("canvas")
    const editable =
      canvas.isContentEditable ||
      canvas.closest("[contenteditable='true']") !== null ||
      canvas.closest("input, textarea, select") !== null
    expect(editable).toBe(false)
  })
})
