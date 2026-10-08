import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Session } from "@/session/session"
import { Scratchpad } from "@/session/scratchpad"
import type { InstanceContext } from "@/project/instance-context"

// Fork ADR-0006, M2: the session's scratchpad — a file, not a message.
//
// The compaction invariant ("message compaction leaves the file byte-identical")
// is asserted in `compaction.test.ts`, where the compaction stack already
// stands; it is the same property, tested where it can actually be driven.

const dirs: string[] = []

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-scratchpad-"))
  dirs.push(dir)
  return path.join(dir, "scratchpad.md")
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("Scratchpad", () => {
  test("write then read round-trips", async () => {
    const file = await tempFile()
    const content = Scratchpad.upsertSection(Scratchpad.init(), "Goal", "add the widget")
    await Scratchpad.write(file, content)
    expect(await Scratchpad.read(file)).toBe(content)
  })

  test("reading a missing file gives an empty scratchpad, not an error", async () => {
    const content = await Scratchpad.read(await tempFile())
    for (const section of Scratchpad.SECTIONS) expect(Scratchpad.readSection(content, section)).toBe("")
  })

  test("every named section is present after init", () => {
    const content = Scratchpad.init()
    for (const section of Scratchpad.SECTIONS) expect(content).toContain(`## ${section}\n`)
    expect(Object.keys(Scratchpad.sections(content))).toEqual([...Scratchpad.SECTIONS])
  })

  test("upsertSection replaces one section and leaves siblings byte-identical", () => {
    let content = Scratchpad.init()
    content = Scratchpad.upsertSection(content, "Goal", "add the widget")
    content = Scratchpad.upsertSection(content, "Decisions", "a file, not a message")
    const goal = Scratchpad.readSection(content, "Goal")
    const size = Scratchpad.readSection(content, "Size")

    content = Scratchpad.upsertSection(content, "Assumptions", "the API is stable")

    expect(Scratchpad.readSection(content, "Goal")).toBe(goal)
    expect(Scratchpad.readSection(content, "Size")).toBe(size)
    expect(Scratchpad.readSection(content, "Assumptions")).toBe("the API is stable")
    expect(Scratchpad.readSection(content, "Decisions")).toBe("a file, not a message")
  })

  test("a section with no cap grows: a 20 KB list round-trips whole", () => {
    const big = Array.from({ length: 400 }, (_, index) => `- assumption ${index}: ${"x".repeat(40)}`).join("\n")
    expect(big.length).toBeGreaterThan(20_000)
    const content = Scratchpad.upsertSection(Scratchpad.init(), "Assumptions", big)
    expect(Scratchpad.readSection(content, "Assumptions")).toBe(big)
  })

  test("the path is deterministic for a session and distinct across sessions", () => {
    const instance = { project: { vcs: "git" }, worktree: "/repo" } as unknown as InstanceContext
    const one = { slug: "abc", time: { created: 1000 } }
    const two = { slug: "def", time: { created: 2000 } }

    expect(Session.scratchpad(one, instance)).toBe(Session.scratchpad(one, instance))
    expect(Session.scratchpad(one, instance)).not.toBe(Session.scratchpad(two, instance))
    expect(Session.scratchpad(one, instance)).toBe(path.join("/repo", ".opencode", "scratchpads", "1000-abc.md"))
  })
})
