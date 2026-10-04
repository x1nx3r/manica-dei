import { describe, expect, test } from "bun:test"
import { ACTIONS, buildArgs, buildCommand, commandFor, renderResult } from "../../src/tool/browser"

// ADR-0005: the browser tool is a named surface over `agent-browser`. The part
// we own is the mapping from model intent to a command line, and the parse of
// the JSON envelope back. Both are pure, so they are tested here directly; the
// attach path is tested against a real binary and Chromium in a guarded run.

const call = (params: Parameters<typeof buildArgs>[0]) => buildArgs(params).join(" ")

describe("browser tool action mapping", () => {
  test("navigating", () => {
    expect(call({ action: "navigate", url: "https://example.com" })).toBe("open https://example.com")
    expect(call({ action: "back" })).toBe("back")
    expect(call({ action: "forward" })).toBe("forward")
    expect(call({ action: "reload" })).toBe("reload")
    expect(call({ action: "pushstate", url: "/dash" })).toBe("pushstate /dash")
  })

  test("reading the page", () => {
    expect(call({ action: "snapshot" })).toBe("snapshot -i")
    expect(call({ action: "snapshot", full: true })).toBe("snapshot")
    expect(call({ action: "snapshot", selector: "main" })).toBe("snapshot -i --selector main")
    expect(call({ action: "get", what: "text", target: "@e1" })).toBe("get text @e1")
    expect(call({ action: "get", what: "url" })).toBe("get url")
    expect(call({ action: "is", what: "visible", target: "@e1" })).toBe("is visible @e1")
    expect(call({ action: "find", locator: "role", text: "button", what: "click" })).toBe("find role button click")
    expect(call({ action: "console" })).toBe("console")
    expect(call({ action: "errors" })).toBe("errors")
    expect(call({ action: "network" })).toBe("network requests")
    expect(call({ action: "read", url: "https://example.com" })).toBe("read https://example.com")
  })

  test("acting on an element", () => {
    expect(call({ action: "click", target: "@e2" })).toBe("click @e2")
    expect(call({ action: "dblclick", target: "@e2" })).toBe("dblclick @e2")
    expect(call({ action: "hover", target: "@e2" })).toBe("hover @e2")
    expect(call({ action: "focus", target: "@e2" })).toBe("focus @e2")
    expect(call({ action: "check", target: "@e3" })).toBe("check @e3")
    expect(call({ action: "uncheck", target: "@e3" })).toBe("uncheck @e3")
    expect(call({ action: "select", target: "@e4", text: "Option A" })).toBe("select @e4 Option A")
    expect(call({ action: "fill", target: "@e5", text: "hello world" })).toBe("fill @e5 hello world")
    expect(call({ action: "type", target: "@e5", text: "more" })).toBe("type @e5 more")
    expect(call({ action: "press", text: "Enter" })).toBe("press Enter")
    expect(call({ action: "keyboard", text: "hello" })).toBe("keyboard type hello")
    expect(call({ action: "scroll" })).toBe("scroll down")
    expect(call({ action: "scroll", text: "up" })).toBe("scroll up")
    expect(call({ action: "scrollintoview", target: "@e6" })).toBe("scrollintoview @e6")
    expect(call({ action: "drag", target: "@e7", into: "@e8" })).toBe("drag @e7 @e8")
  })

  test("upload takes several files, download takes a path", () => {
    expect(call({ action: "upload", target: "@e1", text: "/a.txt,/b.txt" })).toBe("upload @e1 /a.txt /b.txt")
    expect(call({ action: "download", target: "@e2", text: "/tmp/out.bin" })).toBe("download @e2 /tmp/out.bin")
  })

  test("waiting", () => {
    // The command auto-detects: a number is a timeout, anything else a selector.
    expect(call({ action: "wait", target: ".loaded" })).toBe("wait .loaded")
    expect(call({ action: "waitms", text: "500" })).toBe("wait 500")
  })

  test("tabs, and no way to close one", () => {
    expect(call({ action: "tabnew", url: "https://example.com" })).toBe("tab new https://example.com")
    expect(call({ action: "tablist" })).toBe("tab list")
    expect(call({ action: "tabselect", target: "2" })).toBe("tab select 2")
  })

  test("capturing and JavaScript", () => {
    expect(call({ action: "screenshot" })).toBe("screenshot")
    expect(call({ action: "screenshot", full: true })).toBe("screenshot --full")
    expect(call({ action: "pdf", text: "/tmp/page.pdf" })).toBe("pdf /tmp/page.pdf")
    expect(call({ action: "highlight", target: "@e1" })).toBe("highlight @e1")
    expect(call({ action: "evaluate", script: "document.title" })).toBe("eval document.title")
  })

  test("an action missing its required argument is refused before any subprocess", () => {
    // These throw rather than sending a command that would fail in the browser,
    // so the model gets an immediate, honest error.
    expect(() => buildArgs({ action: "navigate" })).toThrow(/url/)
    expect(() => buildArgs({ action: "click" })).toThrow(/target/)
    expect(() => buildArgs({ action: "fill", target: "@e1" })).toThrow(/text/)
    expect(() => buildArgs({ action: "press" })).toThrow(/key/)
    expect(() => buildArgs({ action: "evaluate" })).toThrow(/script/)
    expect(() => buildArgs({ action: "get" })).toThrow(/what/)
    expect(() => buildArgs({ action: "is", what: "visible" })).toThrow(/target/)
    expect(() => buildArgs({ action: "select", target: "@e1" })).toThrow(/value/)
    expect(() => buildArgs({ action: "drag", target: "@e1" })).toThrow(/destination/)
  })
})

describe("browser tool never exposes the excluded surface", () => {
  // ADR-0005: nothing the agent can reach may remove the browser, the human's
  // tab, or their session state. These are refused by construction -- the action
  // does not exist -- and this test is what keeps it that way.
  const forbidden = ["close", "connect", "cookies", "storage", "auth", "clipboard", "route", "set"]

  test("the excluded commands are not actions", () => {
    for (const name of forbidden) {
      expect(ACTIONS as readonly string[]).not.toContain(name)
      // Neither bare nor as a nested sub-command.
      expect(ACTIONS as readonly string[]).not.toContain(`tab${name}`)
      expect(ACTIONS as readonly string[]).not.toContain(`network${name}`)
    }
  })

  test("no action's command line can name an excluded command", () => {
    // Walk every action with a permissive argument set and assert the resulting
    // argv never starts with a command that could reach the browser or the
    // human's state.
    const argvFor = (action: string) =>
      buildArgs({
        action: action as never,
        url: "/",
        target: "x",
        text: "x",
        what: "text",
        selector: "x",
        locator: "role",
        into: "y",
        script: "1",
      })
    for (const action of ACTIONS) {
      const argv = argvFor(action)
      expect(forbidden).not.toContain(argv[0])
      // `tab close` would be two words; neither may appear adjacent.
      expect(argv.slice(0, 2).join(" ")).not.toBe("tab close")
    }
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
})

describe("browser tool result rendering", () => {
  test("a snapshot renders as its tree, not as JSON", () => {
    const envelope = {
      success: true,
      data: { snapshot: '- button "Sign in" [ref=e2]\n- textbox "Email" [ref=e3]' },
    }
    expect(renderResult(["snapshot"], envelope)).toBe('- button "Sign in" [ref=e2]\n- textbox "Email" [ref=e3]')
  })

  test("other results unwrap `data` rather than echoing the envelope", () => {
    // The model should not pay context for the `{success, data}` wrapper.
    const envelope = { success: true, data: { url: "https://example.com", title: "Example" } }
    expect(JSON.parse(renderResult(["open"], envelope))).toEqual({
      url: "https://example.com",
      title: "Example",
    })
  })

  test("a failure is raised with the tool's own message", () => {
    // A failing command must not look like a successful empty result.
    const envelope = { success: false, error: "No element found for ref @e9" }
    expect(() => renderResult(["click"], envelope)).toThrow("No element found for ref @e9")
  })

  test("a string payload is returned as-is", () => {
    expect(renderResult(["eval"], { success: true, data: "Example Domain" })).toBe("Example Domain")
  })

  test("a non-object envelope is stringified rather than dropped", () => {
    expect(renderResult(["open"], "plain")).toBe("plain")
  })
})

describe("browser tool command list", () => {
  test("every action maps to a non-empty command", () => {
    for (const action of ACTIONS) {
      expect(commandFor(action).length).toBeGreaterThan(0)
    }
  })
})
