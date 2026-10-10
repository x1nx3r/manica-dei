export * as GoalJudge from "./judge"

import type { SessionGoal } from "@opencode-ai/schema/session-goal"

// Fork ADR-0006: the judge. It reads the goal, the completion contract, and the
// agent's last response — never the whole transcript — and returns one verdict.
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
  "its goal. You receive the goal, the agent's completion contract, the agent's",
  "most recent response, and — when present — the assumptions the agent recorded.",
  "Decide one of four verdicts.",
  "",
  "DONE — the goal is met:",
  "- The response shows the deliverable exists AND the completion contract's",
  "  Verification criterion is satisfied, with concrete evidence in the response",
  "  (a command result, file contents, a test result).",
  "- A claim without evidence is not done. An explanation of why the goal cannot",
  "  be reached is BLOCKED, not DONE.",
  "",
  "BLOCKED — the goal cannot be met as stated, or the next step needs a human:",
  "- The response explains the goal is unachievable, or that progress needs input",
  "  from a person.",
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
  "Reply with a single JSON object on one line. Shapes:",
  '{"verdict":"done","reason":"<one sentence>"}',
  '{"verdict":"blocked","reason":"<one sentence>"}',
  '{"verdict":"continue","reason":"<one sentence>"}',
  '{"verdict":"wait","wait_on_pid":123,"reason":"<one sentence>"}',
  '{"verdict":"wait","wait_on_session":"<id>","reason":"<one sentence>"}',
  '{"verdict":"wait","wait_for_seconds":600,"reason":"<one sentence>"}',
].join("\n")

export interface JudgePromptInput {
  readonly goal: string
  readonly contract?: SessionGoal.Contract
  readonly assumptions?: string
  readonly lastResponse: string
}

/**
 * How much of the last response the judge sees. The judge reads the last
 * response, not the transcript; the cap is what keeps that true when the
 * response is enormous.
 */
export const MAX_RESPONSE_CHARS = 8_000

/** The judge's user turn: the goal, the contract, the assumptions, the response. */
export function buildJudgePrompt(input: JudgePromptInput): string {
  return [
    "Goal:",
    input.goal,
    "",
    ...(input.contract
      ? ["Completion contract (the authoritative definition of done):", renderContract(input.contract), ""]
      : []),
    ...(input.assumptions ? ["Assumptions the agent recorded:", input.assumptions, ""] : []),
    "Agent's most recent response:",
    clip(input.lastResponse, MAX_RESPONSE_CHARS),
    "",
    "Is the goal met — done, blocked, continue, or wait?",
  ].join("\n")
}

/**
 * Reads a verdict from the judge's reply. Never throws and never fails: an
 * unreadable reply is `FAIL_OPEN` (continue), because a broken judge must not
 * silently end a run.
 */
export function parseVerdict(raw: string): Judgement {
  const object = extractObject(raw)
  if (!object) return FAIL_OPEN

  const verdict = object["verdict"]
  if (verdict === "done" || verdict === "blocked" || verdict === "continue") {
    return { verdict, reason: reasonOf(object) }
  }
  if (verdict === "wait") {
    const wait = waitOf(object)
    // A `wait` with nothing to wait on must not park the loop forever.
    if (!wait) return FAIL_OPEN
    return { verdict: "wait", reason: reasonOf(object), wait }
  }

  // The legacy shape, still accepted: `{"done": true|false}`.
  if (object["done"] === true) return { verdict: "done", reason: reasonOf(object) }
  if (object["done"] === false) return { verdict: "continue", reason: reasonOf(object) }

  return FAIL_OPEN
}

function renderContract(contract: SessionGoal.Contract): string {
  return [
    `Outcome: ${contract.outcome}`,
    `Verification: ${contract.verification}`,
    `Constraints: ${contract.constraints}`,
    `Boundaries: ${contract.boundaries}`,
    `Stop when: ${contract.stop_when}`,
  ].join("\n")
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`
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
 * Finds the JSON object in a reply. Models wrap it in a fence, put a sentence
 * in front, or both; all of that is noise around one object.
 */
function extractObject(raw: string): Record<string, unknown> | undefined {
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
