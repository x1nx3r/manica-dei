import { describe, expect, test } from "bun:test"
import { ProcessGuard } from "@opencode-ai/core/tool/process-guard"

// ADR-0006 live-fire finding: QA's `pkill -9 -f 'next'` matched the command
// line of the shell executing it, killing the pass. The guard refuses the
// pattern families where that happens; exact names and PIDs stay allowed.

describe("ProcessGuard.broadKill", () => {
  test("refuses pkill -f, killall -r, and pgrep -f piped into kill", () => {
    expect(ProcessGuard.broadKill("pkill -9 -f 'next'")).toBeDefined()
    expect(ProcessGuard.broadKill("pkill -f next")).toBeDefined()
    expect(ProcessGuard.broadKill("killall -r 'next.*'")).toBeDefined()
    expect(ProcessGuard.broadKill("pgrep -f next | xargs kill")).toBeDefined()
    expect(ProcessGuard.broadKill("pgrep -f 'next start' | kill")).toBeDefined()
  })

  test("allows exact names, PIDs, and plain process inspection", () => {
    expect(ProcessGuard.broadKill("pkill -x next")).toBeUndefined()
    expect(ProcessGuard.broadKill("kill 12345")).toBeUndefined()
    expect(ProcessGuard.broadKill("killall next")).toBeUndefined()
    expect(ProcessGuard.broadKill("pgrep -x next")).toBeUndefined()
    expect(ProcessGuard.broadKill("pgrep -af node")).toBeUndefined()
    expect(ProcessGuard.broadKill("rm -rf .next && npm run build")).toBeUndefined()
  })

  test("the refusal names the safe path", () => {
    const text = ProcessGuard.refuse(ProcessGuard.broadKill("pkill -f next")!)
    expect(text).toContain("Refused:")
    expect(text).toContain("pgrep -x")
    expect(text).toContain("kill <pid>")
    expect(text).toContain("pkill -x")
  })
})
