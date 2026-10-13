export * as GoalJudge from "./judge"

import type { SessionGoal } from "@opencode-ai/schema/session-goal"

// Fork ADR-0006: the judge. It reads the goal, the completion contract, the
// gate's captured output, and QA's record — never the agent's account of its
// own work, and never the whole transcript — and returns one verdict.
//
// Everything here is pure: the prompt is a string built from data, and the
// verdict is parsed from a string. The model call that sits between them is the
// only effectful part, and it lives in `packages/opencode`.

export type Verdict = "done" | "blocked" | "continue" | "wait"

/** What a `wait` verdict is waiting on. At least one field is set. */
export interface WaitDirective {
  readonly session?: string
  readonly pid?: number
  readonly seconds?: number
}

export interface Judgement {
  readonly verdict: Verdict
  readonly reason: string
  readonly wait?: WaitDirective
  /**
   * The three-part relay the dev receives when a contradiction is ratified
   * (draft `f1-goal-loop-relay.md` §2). Each part is a label around a record
   * field; the loop renders the message, so the judge never writes the prose.
   */
  readonly handoff?: Handoff
}

/** The three parts the judge fills from the record — all three, or none. */
export interface Handoff {
  /** "QA tested" — the probe's criterion and what it observed. */
  readonly tested: string
  /** "Your implementation" — what the artifact does, per QA's read. */
  readonly implementation: string
  /** "The likely cause" — the contradiction, or why the finding does not hold. */
  readonly cause: string
}

/**
 * Fail-open. A judge whose reply cannot be read must not end a run that was
 * still working, so anything unreadable continues.
 */
export const FAIL_OPEN: Judgement = {
  verdict: "continue",
  reason: "the judge's reply could not be read; continuing",
}

/**
 * The judge's system prompt. The hidden `goal-judge` agent carries it; the user
 * turn is `buildJudgePrompt`. Kept here so the two halves cannot drift.
 */
export const JUDGE_SYSTEM_PROMPT = [
  "You are a strict judge deciding whether an autonomous coding agent has met",
  "its goal. You receive the goal, the completion contract, the verification",
  "evidence the loop captured, QA's record, and — when present — the assumptions",
  "the agent recorded. You do not receive the agent's account of its own work.",
  "Decide one of four verdicts.",
  "",
  "DONE — the goal is met:",
  "- The record shows QA derived and ran a probe and found no contradiction. A",
  "  record with no derived probe is an abstention, not a pass. A record whose",
  "  verdict is `contradicted` is never done, whatever you think of the finding.",
  "- The verification evidence below is the loop's own capture of the check —",
  "  judge whether it proves the outcome, not whether a command passed.",
  "- The Outcome, not the command, is the criterion. A passing verification",
  "  proves the outcome only when it exercises the outcome; a green run over a",
  "  deliverable that does not do the job is not done.",
  "- A claim without evidence is not done. An explanation of why the goal cannot",
  "  be reached is BLOCKED, not DONE.",
  "",
  "BLOCKED — the goal cannot be met as stated, or the next step needs a human:",
  "- The record shows the goal cannot be reached as stated, or that progress",
  "  needs input from a person. Do not invent a reason: it must come from the",
  "  record or the gate's own output.",
  "- The agent reached the contract's Stop condition — the point at which it",
  "  stops and asks instead of pushing on. Reaching it is BLOCKED, never DONE.",
  "- BLOCKED is a refusal, not a completion. Never return BLOCKED for a goal that",
  "  was achieved.",
  "",
  "WAIT — not done, but the next step is to wait for async work rather than act:",
  "- Choose this only when progress is genuinely gated on something running on",
  "  its own — a build, a test run, a background process. Name it with exactly one",
  "  of `wait_on_pid`, `wait_on_session`, or `wait_for_seconds`.",
  "- Do not choose WAIT just because work remains.",
  "",
  "CONTINUE — not done, and there is a concrete next step. The default when in doubt.",
  "",
  "When QA contradicted the work, you also tell the dev why. Your reply gains",
  "`handoff`: three strings, each restating a field of QA's record and nothing",
  "else. The loop writes the message; you supply only the parts.",
  "- `tested`: the probe's criterion and what it observed.",
  "- `implementation`: the finding's evidence — what the artifact does.",
  "- `cause`: the finding's detail. If the finding does not hold, say so here",
  "  instead, with the reason from the record or the verification evidence — a",
  "  manufactured finding is a defect, and judging it is your job, not the dev's.",
  "Every clause must come from the record or the verification evidence below; a",
  "clause with no source there is a defect. The probes' commands are not shown to",
  "you, so you cannot relay one.",
  "",
  "Reply with a single JSON object on one line. Shapes:",
  '{"verdict":"done","reason":"<one sentence>"}',
  '{"verdict":"blocked","reason":"<one sentence>"}',
  '{"verdict":"continue","reason":"<one sentence>"}',
  '{"verdict":"continue","reason":"<one sentence>","handoff":{"tested":"<the criterion and what QA observed>","implementation":"<what the artifact does — file:line>","cause":"<the contradiction, or why it does not hold>"}}',
  '{"verdict":"wait","wait_on_pid":123,"reason":"<one sentence>"}',
  '{"verdict":"wait","wait_on_session":"<id>","reason":"<one sentence>"}',
  '{"verdict":"wait","wait_for_seconds":600,"reason":"<one sentence>"}',
].join("\n")

export interface JudgePromptInput {
  readonly goal: string
  readonly contract?: SessionGoal.Contract
  readonly assumptions?: string
  /**
   * QA's record: the pass that QA ran, and what it found (ADR-0006, "the
   * record"). It is the evidence that QA tried; the judge weighs it.
   */
  readonly record?: SessionGoal.Record
  /**
   * What the loop's gates actually produced, captured by the loop rather than
   * reported by the agent. The judge is only called when every gate passed, so
   * this is the check's real output, and the agent cannot shape it.
   */
  readonly evidence?: ReadonlyArray<GateEvidence>
}

/** One gate's result, as the loop saw it. */
export interface GateEvidence {
  readonly command: string
  readonly exitCode: number
  readonly output: string
}

/** The judge's user turn: the goal, the contract, the evidence, the record. */
export function buildJudgePrompt(input: JudgePromptInput): string {
  return [
    "Goal:",
    input.goal,
    "",
    ...(input.contract
      ? [
          "Completion contract (the authoritative definition of done):",
          renderContract(input.contract),
          "",
          "Run condition (not a criterion — reaching it is BLOCKED, never done):",
          `Stop when: ${input.contract.stop_when}`,
          "",
        ]
      : []),
    ...(input.evidence && input.evidence.length > 0
      ? ["Verification evidence (the loop ran these and captured the output):", renderEvidence(input.evidence), ""]
      : []),
    ...(input.record
      ? [
          "QA's record (the pass QA ran, and what it found — never the author's account):",
          renderRecord(input.record),
          "",
        ]
      : []),
    ...(input.assumptions ? ["Assumptions the agent recorded:", input.assumptions, ""] : []),
    input.record?.verdict === "contradicted"
      ? "QA contradicted the work. Is the finding sound — and if the work continues, fill the three-part handoff?"
      : "Is the goal met — done, blocked, continue, or wait?",
  ].join("\n")
}

/**
 * Reads a verdict from the judge's reply, and the three-part handoff when one is
 * present. Never throws and never fails: an unreadable reply is `FAIL_OPEN`
 * (continue), because a broken judge must not silently end a run.
 */
export function parseVerdict(raw: string): Judgement {
  const object = extractObject(raw)
  if (!object) return FAIL_OPEN

  // The relay, when the judge supplied all three parts. A partial handoff is the
  // same as none: the loop falls back to the record's own relay.
  const handoff = handoffOf(object)

  const verdict = object["verdict"]
  if (verdict === "done" || verdict === "blocked" || verdict === "continue") {
    return { verdict, reason: reasonOf(object), ...(handoff ? { handoff } : {}) }
  }
  if (verdict === "wait") {
    const wait = waitOf(object)
    // A `wait` with nothing to wait on must not park the loop forever.
    if (!wait) return FAIL_OPEN
    return { verdict: "wait", reason: reasonOf(object), wait }
  }

  // The legacy shape, still accepted: `{"done": true|false}`.
  if (object["done"] === true) return { verdict: "done", reason: reasonOf(object), ...(handoff ? { handoff } : {}) }
  if (object["done"] === false) return { verdict: "continue", reason: reasonOf(object), ...(handoff ? { handoff } : {}) }

  return FAIL_OPEN
}

/**
 * The four criteria. `Stop when` is deliberately not here: it is a run
 * condition, and rendering it under "the definition of done" is what let a
 * judge read it as a licence (ADR-0006, "What the eval showed").
 */
function renderContract(contract: SessionGoal.Contract): string {
  return [
    `Outcome: ${contract.outcome}`,
    `Verification: ${contract.verification}`,
    `Constraints: ${contract.constraints}`,
    `Boundaries: ${contract.boundaries}`,
  ].join("\n")
}

/** The gates' captured output, rendered as the fact it is. */
function renderEvidence(evidence: ReadonlyArray<GateEvidence>): string {
  return evidence
    .map((entry) =>
      [
        `$ ${entry.command}`,
        `exit code: ${entry.exitCode}`,
        "output (tail):",
        "```",
        entry.output.trim().length === 0 ? "(no output)" : entry.output,
        "```",
      ].join("\n"),
    )
    .join("\n\n")
}

/** QA's record, rendered per criterion — the evidence that QA tried. */
function renderRecord(record: SessionGoal.Record): string {
  const probes = record.probes.length
    ? record.probes
        // The command is deliberately withheld: the judge relays to the dev, and
        // a relayed command is the thing the dev can tune to (draft §6). The gate
        // evidence above is the judge's record of what actually ran.
        .map((probe) =>
          [
            `- [${probe.result}]${probe.derived ? " (derived)" : ""} ${probe.criterion}`,
            ...(probe.output.trim().length === 0 ? [] : indent(probe.output)),
          ].join("\n"),
        )
        .join("\n")
    : "(no probes were run — an abstention, not a pass)"
  const derived = record.probes.some((probe) => probe.derived)
  const findings = record.findings.length
    ? record.findings.map((finding) => `- ${finding.criterion}: ${finding.detail}\n  evidence: ${finding.evidence}`).join("\n")
    : "(none)"
  return [
    `State reviewed: ${record.state}`,
    `Verdict: ${record.verdict}`,
    `Derived probes: ${derived ? "yes" : "no — an abstention, not a pass"}`,
    "",
    "Probes:",
    probes,
    "",
    "Findings:",
    findings,
  ].join("\n")
}

function indent(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function reasonOf(object: Record<string, unknown>): string {
  const value = object["reason"]
  return typeof value === "string" ? value : ""
}

function waitOf(object: Record<string, unknown>): WaitDirective | undefined {
  const session = object["wait_on_session"]
  if (typeof session === "string" && session.length > 0) return { session }
  const pid = object["wait_on_pid"]
  if (typeof pid === "number" && Number.isInteger(pid)) return { pid }
  const seconds = object["wait_for_seconds"]
  if (typeof seconds === "number" && Number.isFinite(seconds)) return { seconds }
  return undefined
}

/**
 * The three-part handoff, when the reply carries one. All three parts or none: a
 * partial handoff would render a message with a hole in it, and the record's own
 * relay is the better fallback (draft `f1-goal-loop-relay.md` §2).
 */
function handoffOf(object: Record<string, unknown>): Handoff | undefined {
  const raw = object["handoff"]
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const parts = raw as Record<string, unknown>
  const tested = stringOf(parts["tested"])
  const implementation = stringOf(parts["implementation"])
  const cause = stringOf(parts["cause"])
  if (tested.length === 0 || implementation.length === 0 || cause.length === 0) return undefined
  return { tested, implementation, cause }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Finds the JSON object in a reply. Models wrap it in a fence, put a sentence
 * in front, or both; all of that is noise around one object. Exported so the
 * QA record parser reads replies the same way.
 */
export function extractObject(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim()
  if (text.length === 0) return undefined

  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) candidates.push(fenced[1])
  candidates.push(text)
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.trim())
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}
