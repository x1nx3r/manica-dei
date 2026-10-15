import { describe, expect, test } from "bun:test"
import { GoalQa } from "../../../src/session/goal/qa"
import { GoalJudge } from "../../../src/session/goal/judge"

// The fork bug the wallpaper run found the hard way: the judge prompt's probe
// output was spread per character (`...(cond ? [] : indent(...))` splatted
// indent's *string*), so a judge read its author-check one letter per line,
// inside the prompt that asks it to rule. The pin: the record renders as lines,
// never as a character ladder — for a probe output with real newlines and for
// one whose model double-escaped them into `\\n`, which is what deepseek wrote.
describe("Judge.buildJudgePrompt's record section", () => {
  const rawRecord = String.raw`{"state":"de532f29cb3f29989d95f87188f06fe0f4b2134d","verdict":"clean","probes":[{"criterion":"the check that proves the outcome","derived":false,"command":"bun test widget","output":"$ bun test widget\\nEXIT=0","result":"pass"},{"criterion":"a derived probe","derived":true,"command":"curl widget","output":"OK line 1\nOK line 2","result":"pass"}],"findings":[]}`

  const record = GoalQa.parseRecord(rawRecord, "de532f29cb3f29989d95f87188f06fe0f4b2134d")
  const prompt = GoalJudge.buildJudgePrompt({
    goal: "the goal",
    contract: { outcome: "o", verification: "v", constraints: "c", boundaries: "b", stop_when: "s" },
    record: record as never,
  })
  const probes = prompt.slice(prompt.indexOf("Probes:"), prompt.indexOf("Findings:"))

  test("each probe is one indented paragraph, not a character ladder", () => {
    // The ladder the run produced: `$`, ` `, `e`, … each followed by a newline.
    // One probe line carries its own chars; nothing renders a char at the head
    // of a line with the next char as its own line.
    expect(probes).toContain("  $ bun test widget\\nEXIT=0")
    expect(probes).toContain("  OK line 1")
    expect(probes).toContain("  OK line 2")
    for (const line of probes.split("\n")) {
      // A body line is a sentence, a finding, or the indent's own two spaces —
      // never a lone character followed by another lone character on the next.
      const isLone = line.length <= 1 && line !== "" && !/[a-zA-Z]/.test(line) === false
      if (isLone)
        throw new Error(
          `character ladder at the prompt: a rendered line is a single character (${JSON.stringify(line)})`,
        )
    }
  })

  test("a probe output with real newlines keeps its lines", () => {
    // The derived probe wrote two lines; the renderer indents each.
    expect(probes).toContain("  OK line 1\n  OK line 2")
  })

  test("the state hash carries its meaning, so the binder is not parroting a token", () => {
    // The wallpaper run's QA: "the commit de532f29 doesn't exist in the repo…
    // I'll echo it as given." A reviewer that cannot say what it says no longer
    // binds anything — the prompt names what the hash is, at the place the
    // reviewer reads it (ADR-0006, "state binding"). The QA wording is asserted
    // through the QA's own prompt; the judge's is the next test.
    const qaPrompt = GoalQa.buildQaPrompt({
      state: "de532f29cb3f29989d95f87188f06fe0f4b2134d",
      diff: "",
      evidence: [],
    } as never)
    expect(qaPrompt).toContain("(the workspace snapshot this round is bound to")
    expect(qaPrompt).toContain("echo it unchanged in your record's state field")
  })

  test("the judge's record names what the state hash is, not just the hash", () => {
    // The judge weighs the record against the round; teaching it where the hash
    // comes from means a mis-binding is a reason, not a ritual.
    expect(prompt).toContain("(the workspace snapshot the round is bound to")
  })
})

describe("GoalJudge's own rendering", () => {
  test("the same record through the judge's render keeps single lines", () => {
    const record = GoalQa.parseRecord(
      '{"state":"s","verdict":"clean","probes":[{"criterion":"c","derived":true,"command":"cmd","output":"one\\ntwo","result":"pass"}],"findings":[]}',
      "s",
    )
    const prompt = GoalJudge.buildJudgePrompt({
      goal: "g",
      contract: { outcome: "o", verification: "v", constraints: "c", boundaries: "b", stop_when: "s" },
      record: record as never,
    })
    expect(prompt).toContain("  one\n  two")
  })
})
