import { describe, expect, test } from "bun:test"
import { GoalJudge } from "@opencode-ai/core/session/goal/judge"

// Fork ADR-0006, M3: the judge's pure half. The parser is the piece that
// matters — a mis-parse silently ends or extends a run — so every accepted
// shape and every way a reply can be unreadable is pinned here.

const verdict = (raw: string) => GoalJudge.parseVerdict(raw)

describe("GoalJudge.parseVerdict — accepted shapes", () => {
  test("done, blocked, and continue carry their reason", () => {
    expect(verdict('{"verdict":"done","reason":"the tests pass"}')).toEqual({
      verdict: "done",
      reason: "the tests pass",
    })
    expect(verdict('{"verdict":"blocked","reason":"needs a key"}')).toEqual({
      verdict: "blocked",
      reason: "needs a key",
    })
    expect(verdict('{"verdict":"continue","reason":"more to do"}')).toEqual({
      verdict: "continue",
      reason: "more to do",
    })
  })

  test("wait carries exactly what it waits on", () => {
    expect(verdict('{"verdict":"wait","wait_on_session":"ses_1","reason":"ci"}')).toEqual({
      verdict: "wait",
      reason: "ci",
      wait: { session: "ses_1" },
    })
    expect(verdict('{"verdict":"wait","wait_on_pid":123,"reason":"build"}')).toEqual({
      verdict: "wait",
      reason: "build",
      wait: { pid: 123 },
    })
    expect(verdict('{"verdict":"wait","wait_for_seconds":600,"reason":"rate limit"}')).toEqual({
      verdict: "wait",
      reason: "rate limit",
      wait: { seconds: 600 },
    })
  })

  test("the legacy done shape is still read", () => {
    expect(verdict('{"done":true}')).toEqual({ verdict: "done", reason: "" })
    expect(verdict('{"done":false}')).toEqual({ verdict: "continue", reason: "" })
  })
})

describe("GoalJudge.parseVerdict — unreadable replies fail open", () => {
  test("garbage, empties, and non-objects continue", () => {
    for (const raw of ["", "   ", "not json", '{"verdict":', "[1,2,3]", "null", "42"]) {
      expect(verdict(raw)).toEqual(GoalJudge.FAIL_OPEN)
    }
  })

  test("an unknown verdict continues", () => {
    expect(verdict('{"verdict":"finished"}')).toEqual(GoalJudge.FAIL_OPEN)
  })

  test("no verdict and no done continues", () => {
    expect(verdict('{"reason":"hmm"}')).toEqual(GoalJudge.FAIL_OPEN)
  })

  test("wait with nothing to wait on continues — it must not park forever", () => {
    expect(verdict('{"verdict":"wait","reason":"idle"}')).toEqual(GoalJudge.FAIL_OPEN)
  })
})

describe("GoalJudge.parseVerdict — noise around the object", () => {
  test("a reasoning preamble is ignored", () => {
    expect(verdict('Let me think. The tests pass.\n{"verdict":"done","reason":"tests pass"}')).toEqual({
      verdict: "done",
      reason: "tests pass",
    })
  })

  test("a json fence is unwrapped", () => {
    expect(verdict('```json\n{"verdict":"blocked","reason":"needs input"}\n```')).toEqual({
      verdict: "blocked",
      reason: "needs input",
    })
  })

  test("unknown fields are ignored", () => {
    expect(verdict('{"verdict":"continue","reason":"x","confidence":0.9}')).toEqual({
      verdict: "continue",
      reason: "x",
    })
  })
})

describe("GoalJudge.buildJudgePrompt", () => {
  const contract = {
    outcome: "the widget renders",
    verification: "bun test widget",
    constraints: "nothing else changes",
    boundaries: "packages/widget",
    stop_when: "the spec is ambiguous",
  }

  test("carries the goal, the contract verbatim, and the response", () => {
    const prompt = GoalJudge.buildJudgePrompt({
      goal: "add the widget",
      contract,
      lastResponse: "I added it and ran the tests.",
    })

    expect(prompt).toContain("Goal:\nadd the widget")
    for (const line of [
      "Outcome: the widget renders",
      "Verification: bun test widget",
      "Constraints: nothing else changes",
      "Boundaries: packages/widget",
      "Stop when: the spec is ambiguous",
    ]) {
      expect(prompt).toContain(line)
    }
    expect(prompt).toContain("I added it and ran the tests.")
  })

  test("includes the assumption ledger when present, omits the blocks when absent", () => {
    const withLedger = GoalJudge.buildJudgePrompt({
      goal: "g",
      lastResponse: "r",
      assumptions: "- the API is stable",
    })
    expect(withLedger).toContain("Assumptions the agent recorded:")
    expect(withLedger).toContain("- the API is stable")

    const bare = GoalJudge.buildJudgePrompt({ goal: "g", lastResponse: "r" })
    expect(bare).not.toContain("Assumptions the agent recorded:")
    expect(bare).not.toContain("Completion contract")
  })

  test("bounds the response — the judge never sees the whole transcript", () => {
    const huge = "x".repeat(GoalJudge.MAX_RESPONSE_CHARS * 4)
    const prompt = GoalJudge.buildJudgePrompt({ goal: "g", lastResponse: huge })
    expect(prompt).toContain("[truncated]")
    expect(prompt.length).toBeLessThan(GoalJudge.MAX_RESPONSE_CHARS + 2_000)
  })
})
