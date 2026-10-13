import { describe, expect, test } from "bun:test"
import { GoalQa } from "@opencode-ai/core/session/goal/qa"

// Fork ADR-0006, the QA loop: the QA pass's pure half. The brief is the prompt
// the reviewer runs on, the prompt carries only the diet, and the parser reads
// the record the way the judge reads its verdict — never throwing, and never
// treating an unreadable reply as a pass.

const state = "snap-1"
const contract = {
  outcome: "the widget renders",
  verification: "bun test widget",
  constraints: "nothing else changes",
  boundaries: "packages/widget",
  stop_when: "the spec is ambiguous",
}

describe("GoalQa.QA_SYSTEM_PROMPT", () => {
  const prompt = GoalQa.QA_SYSTEM_PROMPT

  test("sets the aim at breaking the work, and denies the author's account", () => {
    expect(prompt).toContain("Find what will break for them.")
    expect(prompt).toContain("you have not read the author's account of it")
  })

  test("abstention is not a pass, and a probe must be executed and reachable", () => {
    expect(prompt).toContain("abstaining is not a pass")
    expect(prompt).toContain("It is **executed**")
    expect(prompt).toContain("It is **reachable**")
    // A test is not a caller: this is the check that neither the gate nor the
    // test-integrity replay performs.
    expect(prompt).toContain("Tests do not count")
  })
})

describe("GoalQa.buildQaPrompt", () => {
  test("carries the contract, the state, and the diff", () => {
    const prompt = GoalQa.buildQaPrompt({ contract, state, diff: "diff --git a/x b/x" })
    expect(prompt).toContain("Outcome: the widget renders")
    expect(prompt).toContain("State under review:\nsnap-1")
    expect(prompt).toContain("diff --git a/x b/x")
    expect(prompt).toContain("Reply with a single JSON object")
  })

  test("marks a missing diff rather than inventing one", () => {
    const prompt = GoalQa.buildQaPrompt({ contract, state })
    expect(prompt).toContain("(no diff was recorded for this round)")
  })

  test("carries the gate's own output when the loop supplies it", () => {
    const prompt = GoalQa.buildQaPrompt({
      contract,
      state,
      evidence: [{ command: "bun test widget", exitCode: 0, output: "12 pass" }],
    })
    expect(prompt).toContain("$ bun test widget")
    expect(prompt).toContain("12 pass")
  })

  test("omits the blocks it was not given", () => {
    const prompt = GoalQa.buildQaPrompt({ state })
    expect(prompt).not.toContain("Outcome:")
    expect(prompt).not.toContain("The check the author chose")
  })
})

describe("GoalQa.parseRecord — accepted shapes", () => {
  test("a contradicted record keeps its probes and findings", () => {
    const record = GoalQa.parseRecord(
      JSON.stringify({
        state,
        verdict: "contradicted",
        probes: [
          { criterion: "reaches HR", derived: true, command: "run sweep", output: "queue: (empty)", result: "fail" },
        ],
        findings: [{ criterion: "reaches HR", detail: "nothing calls escalate", evidence: "leave.ts:79" }],
      }),
      state,
    )
    expect(record.verdict).toBe("contradicted")
    expect(record.probes).toHaveLength(1)
    expect(record.probes[0]?.result).toBe("fail")
    expect(record.findings[0]?.evidence).toBe("leave.ts:79")
  })

  test("noise around the object is ignored", () => {
    const record = GoalQa.parseRecord(
      'Let me think.\n```json\n{"state":"snap-1","verdict":"clean","probes":[],"findings":[]}\n```',
      state,
    )
    expect(record.verdict).toBe("clean")
  })

  test("keeps the state QA reviewed — a mismatch is the loop's to reject", () => {
    const record = GoalQa.parseRecord('{"state":"snap-9","verdict":"clean","probes":[],"findings":[]}', state)
    expect(record.state).toBe("snap-9")
  })

  test("a missing state is bound to the round's state", () => {
    const record = GoalQa.parseRecord('{"verdict":"clean","probes":[],"findings":[]}', state)
    expect(record.state).toBe("snap-1")
  })
})

describe("GoalQa.parseRecord — unreadable replies are an abstention", () => {
  test("garbage, empties, and bad verdicts abstain", () => {
    for (const raw of ["", "   ", "not json", "[]", "42", '{"verdict":"finished"}', '{"no":"state"}']) {
      const record = GoalQa.parseRecord(raw, state)
      expect(record).toEqual(GoalQa.abstention(state))
    }
  })

  test("malformed probes and findings are dropped, not trusted", () => {
    const record = GoalQa.parseRecord(
      '{"state":"snap-1","verdict":"contradicted","probes":[{"criterion":"x"},{"result":"pass","command":"c"}],"findings":[1]}',
      state,
    )
    expect(record.probes).toEqual([
      { criterion: "", derived: false, command: "c", output: "", result: "pass" },
    ])
    expect(record.findings).toEqual([])
  })
})

describe("GoalQa.relayContinuation", () => {
  test("relays the findings verbatim but withholds each probe's command", () => {
    const record = GoalQa.parseRecord(
      JSON.stringify({
        state,
        verdict: "contradicted",
        probes: [
          {
            criterion: "reaches HR",
            derived: true,
            command: "bun run sweep && queue",
            output: "queue: (empty)",
            result: "fail",
          },
        ],
        findings: [{ criterion: "reaches HR", detail: "nothing calls escalate", evidence: "leave.ts:79" }],
      }),
      state,
    )
    const prompt = GoalQa.relayContinuation("add escalation", record)
    expect(prompt).toContain("nothing calls escalate")
    expect(prompt).toContain("leave.ts:79")
    // The observation is the symptom the dev can chase; the command is withheld
    // because it is the thing the dev could tune to (draft §6).
    expect(prompt).toContain("queue: (empty)")
    expect(prompt).not.toContain("bun run sweep")
  })
})

describe("GoalQa.handoffContinuation", () => {
  test("renders the judge's three parts as labels the dev reads", () => {
    const prompt = GoalQa.handoffContinuation("add escalation", {
      tested: "a request pending 7+ days reaches the HR manager — the queue is empty",
      implementation: "escalateOverdue is never called (src/domain/leave.ts:79)",
      cause: "the sweep never invokes escalateOverdue",
    })
    expect(prompt).toContain("QA tested this, and it failed")
    expect(prompt).toContain("QA tested:\n  a request pending 7+ days reaches the HR manager — the queue is empty")
    expect(prompt).toContain("Your implementation:\n  escalateOverdue is never called (src/domain/leave.ts:79)")
    expect(prompt).toContain("The likely cause:\n  the sweep never invokes escalateOverdue")
    expect(prompt).toContain("the record will be weighed again")
  })
})

describe("GoalQa.abstentionContinuation", () => {
  test("demands a probe", () => {
    expect(GoalQa.abstentionContinuation("add escalation")).toContain("silence is not a pass")
  })

  test("names the derived probe as the thing missing", () => {
    const prompt = GoalQa.abstentionContinuation("add escalation")
    expect(prompt).toContain("derived no probe")
    expect(prompt).toContain("the author's own checks are not enough")
  })
})

describe("GoalQa.attributeProbes", () => {
  const clean = (command: string, derived: boolean) => ({
    state,
    verdict: "clean" as const,
    probes: [{ criterion: "the widget renders", derived, command, output: "1 pass", result: "pass" as const }],
    findings: [],
  })

  test("an author's check marked derived is not a holdout", () => {
    const record = GoalQa.attributeProbes(clean("bun test widget", true), ["bun test widget"])
    expect(record.probes[0]!.derived).toBe(false)
  })

  test("the match ignores whitespace: `bun  test widget` is the author's command", () => {
    const record = GoalQa.attributeProbes(clean("bun  test widget", true), ["bun test widget"])
    expect(record.probes[0]!.derived).toBe(false)
  })

  test("a probe with a command of its own is left alone", () => {
    const record = GoalQa.attributeProbes(clean("query the queue", true), ["bun test widget"])
    expect(record.probes[0]!.derived).toBe(true)
  })

  test("with no author commands the record is returned untouched", () => {
    const original = clean("bun test widget", true)
    expect(GoalQa.attributeProbes(original, [])).toBe(original)
  })
})

describe("GoalQa.errorContinuation", () => {
  test("says the round was not certified and names the repeat-stop", () => {
    const prompt = GoalQa.errorContinuation("add escalation")
    expect(prompt).toContain("could not run")
    expect(prompt).toContain("not certified")
    expect(prompt).toContain("names the QA configuration")
  })
})

describe("GoalQa.isReviewableDiff", () => {
  const file = (file: string, patch: string) => ({ file, patch, additions: 1, deletions: 0, status: "modified" as const })

  test("an empty diff is not reviewable", () => {
    expect(GoalQa.isReviewableDiff([])).toBe(false)
  })

  test("a scratchpad-only change is not reviewable", () => {
    expect(GoalQa.isReviewableDiff([file(".opencode/scratchpads/1-goal.md", "the plan")])).toBe(false)
  })

  test("a file entry with no patch text is not reviewable", () => {
    expect(GoalQa.isReviewableDiff([file("assets/logo.png", "")])).toBe(false)
  })

  test("a change with a patch is reviewable", () => {
    expect(GoalQa.isReviewableDiff([file("src/widget.ts", "-old\n+new")])).toBe(true)
  })
})

describe("GoalQa.renderDiff", () => {
  const file = (file: string, patch: string) => ({ file, patch, additions: 1, deletions: 0, status: "modified" as const })

  test("keeps the work in the round's change", () => {
    const rendered = GoalQa.renderDiff([file("src/widget.ts", "diff --git a/src/widget.ts b/src/widget.ts")])
    expect(rendered).toContain("src/widget.ts")
    expect(rendered).toContain("diff --git a/src/widget.ts")
  })

  test("drops the author's scratchpad — it is prose QA is denied", () => {
    const rendered = GoalQa.renderDiff([
      file(".opencode/scratchpads/123-goal.md", "the author's private plan"),
      file("src/widget.ts", "the work"),
    ])
    expect(rendered).toContain("src/widget.ts")
    expect(rendered).not.toContain("scratchpads")
    expect(rendered).not.toContain("private plan")
  })

  test("recognises a Windows-separated scratchpad path", () => {
    expect(GoalQa.isScratchpad(".opencode\\scratchpads\\1-goal.md")).toBe(true)
    expect(GoalQa.isScratchpad("src/widget.ts")).toBe(false)
    expect(GoalQa.isScratchpad(undefined)).toBe(false)
  })
})

describe("GoalQa.roundMessages", () => {
  const message = (id: string, role: string, parentID?: string) => ({ info: { id, role, ...(parentID ? { parentID } : {}) }, parts: [] })

  test("keeps the round's user turn and its assistant replies, and drops earlier rounds", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant", "u1"),
      message("u2", "user"),
      message("a2", "assistant", "u2"),
      message("a2b", "assistant", "u2"),
      message("other", "assistant", "u1"),
    ]
    const round = GoalQa.roundMessages(messages, "u2")
    expect(round.map((item) => item.info.id)).toEqual(["u2", "a2", "a2b"])
  })
})
