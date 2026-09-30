import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"

describe("settings v2 controllers", () => {
  test("normalizes shell names and preserves an unavailable configured shell", () => {
    expect(
      createShellOptions({
        shells: [
          { path: "/bin/bash", name: "bash", acceptable: true },
          { path: "/opt/bash", name: "bash", acceptable: false },
          { path: "/bin/zsh", name: "zsh", acceptable: true },
        ],
        current: "fish",
      }),
    ).toEqual([
      { id: "auto", value: "", name: "", terminalOnly: false },
      { id: "/bin/bash", value: "/bin/bash", name: "/bin/bash", terminalOnly: false },
      { id: "/opt/bash", value: "/opt/bash", name: "/opt/bash", terminalOnly: true },
      { id: "/bin/zsh", value: "zsh", name: "zsh", terminalOnly: false },
      { id: "fish", value: "fish", name: "fish", terminalOnly: false },
    ])
  })

  test("debounces previews and stops owned audio on disposal", async () => {
    const played: string[] = []
    const stopped: string[] = []
    const owned = createRoot((dispose) => ({
      dispose,
      preview: createSoundPreviewController(async (id) => {
        played.push(id ?? "")
        return () => stopped.push(id ?? "")
      }),
    }))

    owned.preview.play("first")
    owned.preview.play("second")
    // Still inside the 100ms debounce window: the first play must never fire.
    await Bun.sleep(50)
    expect(played).toEqual([])

    await Bun.sleep(200)
    expect(played).toEqual(["second"])

    owned.dispose()
    expect(stopped).toEqual(["second"])
  })
})
