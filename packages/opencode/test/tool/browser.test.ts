import { describe, expect, test } from "bun:test"
import { buildArgs, buildCommand, commandFor, renderResult } from "../../src/tool/browser"

// ADR-0005: the browser tool is a named surface over `agent-browser`. The part
// we own is the mapping from model intent to a command line, and the parse of
// the JSON envelope back. Both are pure, so they are tested here directly; the
// attach path is tested against a real binary and Chromium in a guarded run.

describe("browser tool command mapping", () => {
  test("each action maps to the agent-browser command", () => {
    // Our names, not theirs. `navigate` is `open`, `evaluate` is `eval`, and the
    // rest happen to agree.
    expect(commandFor("navigate")).toBe("open")
    expect(commandFor("evaluate")).toBe("eval")
    expect(commandFor("snapshot")).toBe("snapshot")
    expect(commandFor("click")).toBe("click")
    expect(commandFor("fill")).toBe("fill")
    expect(commandFor("press")).toBe("press")
    expect(commandFor("scroll")).toBe("scroll")
    expect(commandFor("back")).toBe("back")
    expect(commandFor("screenshot")).toBe("screenshot")
  })

  test("navigate carries the url", () => {
    expect(buildArgs({ action: "navigate", url: "https://example.com" })).toEqual(["open", "https://example.com"])
  })

  test("click carries the ref", () => {
    expect(buildArgs({ action: "click", target: "@e3" })).toEqual(["click", "@e3"])
  })

  test("fill carries the ref and the text as separate arguments", () => {
    // The text must not be joined onto the ref: agent-browser takes them as two
    // arguments, and a space in the text would otherwise become part of the ref.
    expect(buildArgs({ action: "fill", target: "@e4", text: "hello world" })).toEqual(["fill", "@e4", "hello world"])
  })

  test("snapshot defaults to interactive, and `full` asks for everything", () => {
    expect(buildArgs({ action: "snapshot" })).toEqual(["snapshot", "-i"])
    expect(buildArgs({ action: "snapshot", full: true })).toEqual(["snapshot"])
  })

  test("snapshot can be scoped to a selector", () => {
    expect(buildArgs({ action: "snapshot", selector: "main" })).toEqual(["snapshot", "-i", "--selector", "main"])
  })

  test("scroll defaults to down", () => {
    expect(buildArgs({ action: "scroll" })).toEqual(["scroll", "down"])
    expect(buildArgs({ action: "scroll", text: "up" })).toEqual(["scroll", "up"])
  })

  test("press and evaluate carry their argument", () => {
    expect(buildArgs({ action: "press", text: "Enter" })).toEqual(["press", "Enter"])
    expect(buildArgs({ action: "evaluate", script: "document.title" })).toEqual(["eval", "document.title"])
  })

  test("an action missing its required argument is refused before any subprocess", () => {
    // These throw rather than sending a command that would fail in the browser,
    // so the model gets an immediate, honest error.
    expect(() => buildArgs({ action: "navigate" })).toThrow(/url/)
    expect(() => buildArgs({ action: "click" })).toThrow(/target/)
    expect(() => buildArgs({ action: "fill", target: "@e1" })).toThrow(/text/)
    expect(() => buildArgs({ action: "press" })).toThrow(/key/)
    expect(() => buildArgs({ action: "evaluate" })).toThrow(/script/)
  })

  test("actions with no arguments build nothing extra", () => {
    expect(buildArgs({ action: "back" })).toEqual(["back"])
    expect(buildArgs({ action: "screenshot" })).toEqual(["screenshot"])
  })
})

describe("browser tool attach flags", () => {
  test("the port is passed bare, as a number, not as host:port", () => {
    // agent-browser accepts a port number or a full ws/http URL and rejects
    // anything else, so `127.0.0.1:9222` would fail its parse and exit. This is
    // the invariant that keeps the attach working.
    const argv = buildCommand(9222, { action: "snapshot" })
    expect(argv.slice(0, 2)).toEqual(["--cdp", "9222"])
    for (const arg of argv) expect(arg).not.toContain("127.0.0.1:")
    expect(argv).not.toContain("127.0.0.1")
  })

  test("it asks for JSON, and never for a launch", () => {
    const argv = buildCommand(9222, { action: "back" })
    expect(argv).toContain("--json")
    // `--auto-connect` is the one flag that could take a launch-capable path, so
    // it must never appear. Attaching is what makes `close` a disconnect.
    expect(argv).not.toContain("--auto-connect")
    expect(argv).not.toContain("--headed")
  })

  test("the action arguments follow the attach flags", () => {
    expect(buildCommand(41000, { action: "click", target: "@e2" })).toEqual([
      "--cdp",
      "41000",
      "--json",
      "click",
      "@e2",
    ])
  })
})

describe("browser tool result rendering", () => {
  test("a snapshot renders as its tree, not as JSON", () => {
    const envelope = {
      success: true,
      data: { snapshot: '- button "Sign in" [ref=e2]\n- textbox "Email" [ref=e3]' },
    }
    expect(renderResult("snapshot", envelope)).toBe('- button "Sign in" [ref=e2]\n- textbox "Email" [ref=e3]')
  })

  test("other results unwrap `data` rather than echoing the envelope", () => {
    // The model should not pay context for the `{success, data}` wrapper.
    const envelope = { success: true, data: { url: "https://example.com", title: "Example" } }
    expect(JSON.parse(renderResult("open", envelope))).toEqual({
      url: "https://example.com",
      title: "Example",
    })
  })

  test("a failure is raised with the tool's own message", () => {
    // A failing command must not look like a successful empty result.
    const envelope = { success: false, error: "No element found for ref @e9" }
    expect(() => renderResult("click", envelope)).toThrow("No element found for ref @e9")
  })

  test("a string payload is returned as-is", () => {
    expect(renderResult("eval", { success: true, data: "Example Domain" })).toBe("Example Domain")
  })

  test("a non-object envelope is stringified rather than dropped", () => {
    expect(renderResult("open", "plain")).toBe("plain")
  })
})
