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

  test("a three-part handoff is carried, and a partial one is dropped", () => {
    const handoff = { tested: "t", implementation: "i", cause: "c" }
    expect(verdict(JSON.stringify({ verdict: "continue", reason: "r", handoff }))).toEqual({
      verdict: "continue",
      reason: "r",
      handoff,
    })
    // A partial relay would render a message with a hole in it; the record's own
    // relay is the better fallback.
    expect(verdict(JSON.stringify({ verdict: "continue", reason: "r", handoff: { tested: "t" } }))).toEqual({
      verdict: "continue",
      reason: "r",
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
  const record = {
    state: "snap-1",
    verdict: "clean" as const,
    probes: [
      { criterion: "the widget renders", derived: true, command: "bun run render", output: "ok", result: "pass" as const },
    ],
    findings: [],
  }

  test("carries the goal and the contract verbatim", () => {
    const prompt = GoalJudge.buildJudgePrompt({ goal: "add the widget", contract })

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
  })

  test("never carries the agent's own account of the work", () => {
    // The judge's diet narrows to facts: the contract, the evidence, the
    // record. The author's prose is denied (ADR-0006, "Three diets").
    const prompt = GoalJudge.buildJudgePrompt({ goal: "g", contract, record })
    expect(prompt).not.toContain("Agent's most recent response")
  })

  test("the stop condition is a run condition, not part of the definition of done", () => {
    const prompt = GoalJudge.buildJudgePrompt({ goal: "add the widget", contract })
    const contractAt = prompt.indexOf("Completion contract")
    const runConditionAt = prompt.indexOf("Run condition")
    const stopAt = prompt.indexOf("Stop when:")

    expect(contractAt).toBeGreaterThanOrEqual(0)
    expect(runConditionAt).toBeGreaterThan(contractAt)
    expect(stopAt).toBeGreaterThan(runConditionAt)
  })

  test("carries the gates' own output as evidence when the loop supplies it", () => {
    const prompt = GoalJudge.buildJudgePrompt({
      goal: "g",
      contract,
      evidence: [{ command: "bun test widget", exitCode: 0, output: "12 pass, 0 fail" }],
    })
    expect(prompt).toContain("Verification evidence (the loop ran these and captured the output):")
    expect(prompt).toContain("$ bun test widget")
    expect(prompt).toContain("12 pass, 0 fail")
  })

  test("omits the evidence block when the loop supplied none", () => {
    const prompt = GoalJudge.buildJudgePrompt({ goal: "g", contract })
    expect(prompt).not.toContain("Verification evidence")
  })

  test("carries QA's record as the thing it weighs, with the probe's command withheld", () => {
    const withRecord = GoalJudge.buildJudgePrompt({ goal: "g", contract, record })
    expect(withRecord).toContain("QA's record")
    expect(withRecord).toContain("State reviewed: snap-1")
    expect(withRecord).toContain("Derived probes: yes")
    // The command is withheld: the judge relays to the dev, and a relayed
    // command is the thing the dev can tune to (draft §6).
    expect(withRecord).not.toContain("bun run render")

    const bare = GoalJudge.buildJudgePrompt({ goal: "g", contract })
    expect(bare).not.toContain("QA's record")
  })

  test("a record with no derived probe reads as an abstention", () => {
    const prompt = GoalJudge.buildJudgePrompt({
      goal: "g",
      contract,
      record: {
        state: "snap-1",
        verdict: "clean",
        probes: [{ criterion: "c", derived: false, command: "c", output: "ok", result: "pass" }],
        findings: [],
      },
    })
    expect(prompt).toContain("Derived probes: no — an abstention, not a pass")
  })

  test("includes the assumption ledger when present, omits the blocks when absent", () => {
    const withLedger = GoalJudge.buildJudgePrompt({ goal: "g", assumptions: "- the API is stable" })
    expect(withLedger).toContain("Assumptions the agent recorded:")
    expect(withLedger).toContain("- the API is stable")

    const bare = GoalJudge.buildJudgePrompt({ goal: "g" })
    expect(bare).not.toContain("Assumptions the agent recorded:")
    expect(bare).not.toContain("Completion contract")
  })
})

describe("GoalJudge.JUDGE_SYSTEM_PROMPT", () => {
  // The eval (ADR-0006, "What the eval showed") caught the judge accepting a
  // green gate over an unreached outcome, and reading the stop condition as a
  // licence. These two rules are the repair; pin them or they regress silently
  // and only the eval — which is not CI — would notice.
  const prompt = GoalJudge.JUDGE_SYSTEM_PROMPT

  test("done keys on the outcome, not on the verification command", () => {
    expect(prompt).toContain("The Outcome, not the command, is the criterion")
  })

  test("reaching the stop condition is blocked, never done", () => {
    expect(prompt).toContain("Reaching it is BLOCKED, never DONE")
  })

  test("done requires a derived probe; the author's checks are not a pass", () => {
    expect(prompt).toContain("record with no derived probe is an abstention, not a pass")
  })

  test("blocked comes from the record or the gate's output, not the agent's story", () => {
    expect(prompt).toContain("You do not receive the agent's account of its own work.")
    expect(prompt).toContain("Do not invent a reason")
  })
})
