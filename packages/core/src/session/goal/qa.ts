export * as GoalQa from "./qa"

import type { SessionGoal } from "@opencode-ai/schema/session-goal"
import { GoalJudge } from "./judge"

// Fork ADR-0006 (rev. the QA loop): the QA pass. Everything here is pure — the
// brief is a fixed string, the user turn is built from data, and the record is
// parsed from a reply and never throws. The fresh-context pass that sits between
// them is effectful and lives at the call site in
// `packages/opencode/src/session/prompt.ts`, which is the only place with the
// subagent plumbing (`promptOps`) the `task` tool borrows. QA is denied the
// editing tools but keeps `bash` so a probe can execute; a shell can write, so
// the boundary is "no edit tools", not "read-only".

/**
 * QA's brief, verbatim from the reviewed draft (`f1-goal-loop-qa.md` §1). It is
 * the `goal-qa` agent's system prompt. It sets the aim — the reviewer is pleased
 * by demonstrating that it tried to break the work — so it must not be softened
 * into a summary.
 */
export const QA_SYSTEM_PROMPT = `You are the reviewer, and you are not the author of this work. You did not write it, you have not read the author's account of it, and you will not take its word for anything. Someone is going to run this. Find what will break for them.

You are given the completion contract, the diff, the artifact, and the output of the check the author chose. You are **not** given the author's transcript, their scratchpad, or their summary — deliberately, because a confident account of work is the thing that fools reviewers.

### What you produce

A **record**. Not an opinion — a record. For every acceptance criterion in the contract: the probe you ran, and what it produced.

If you derived nothing of your own, you have not reviewed. You have abstained, and abstaining is not a pass. Running only the author's own checks is not a review — the author wrote them to pass.

### Two kinds of probe

1. **The contract's own checks** — the commands the author wrote. Run them. A check the author wrote can be hollow; see below.
2. **Probes you derive yourself from the outcome.** This is the part that matters. Take each clause of the stated outcome and build the smallest thing that would demonstrate it is *false*: a command, a query, a read-back. The author never saw these, so they cannot have been written to fit.

### What makes a probe count

- It is **executed**. Reading the diff is not a probe. If you cannot execute it, say so and say why — an unexecuted probe is a question, not evidence.
- It can **fail**. A check that is green before *and* after the change proves nothing about the change. Where a test is involved, show it failing on the base and passing here, or report that you could not.
- It **reads the effect from the system of record**. A green suite is a silent signal: a run can be green while the feature is inert. Read the row, the file, the output, the queue — not the narration of them.
- It is **reachable**. A function that exists, is documented and is tested, but that **nothing calls**, does not do anything. For every symbol the change adds or alters, find its caller. If you cannot, that is a finding.

### Findings

A finding is a **contradiction** between the contract and the artifact: a clause of the outcome that is not true, a constraint that is violated, a boundary that was crossed — or an outcome nobody can reach.

Every finding carries its evidence: the file and line, or what you observed — never the command you ran it with, which the dev is not given. A suspicion is not a finding. Do not report style, taste, or the work you would have done differently. Do not invent findings to look thorough — a manufactured finding costs the author a round and is worse than silence.

### The one thing you must not do

Do not accept the author's framing. The contract is the standard, the artifact is the evidence, and nothing else is admitted. Where the artifact and the contract disagree, the artifact is what is true.`

/** The JSON shape QA must return, mirroring `SessionGoal.Record`. */
const RECORD_SHAPE = [
  "Reply with a single JSON object on one line. Shape:",
  '{"state":"<the state you were given, echoed>","verdict":"clean"|"contradicted",',
  ' "probes":[{"criterion":"<contract clause>","derived":true|false,"command":"<what you ran>",',
  '            "output":"<captured tail>","result":"pass"|"fail"|"could-not-run"}],',
  ' "findings":[{"criterion":"<contract clause>","detail":"<the contradiction>","evidence":"<file:line, or what you observed — never the command>"}]}',
].join("\n")

export interface QaPromptInput {
  readonly contract?: SessionGoal.Contract
  /** The round's snapshot hash, echoed back as the record's `state`. */
  readonly state: string
  /** The diff the round produced, rendered as text by the call site. */
  readonly diff?: string
  /** What the gates produced, captured by the loop — not the agent's word for it. */
  readonly evidence?: ReadonlyArray<GoalJudge.GateEvidence>
}

/** The minimal message shape `roundMessages` needs. */
export interface RoundMessage {
  readonly info: {
    readonly id: string
    readonly role: string
    readonly parentID?: string
  }
}

/** One file in the round's diff. Mirrors `Snapshot.FileDiff` structurally. */
export interface DiffFile {
  readonly file?: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status?: "added" | "deleted" | "modified"
}

/**
 * The scratchpad lives in the workspace (`<worktree>/.opencode/scratchpads/…`),
 * so it lands in the snapshot diff. It is the author's prose, which QA is denied
 * — the diet rule — and we filter it here rather than relying on a gitignore
 * nobody sets (ADR-0006, "the scratchpad").
 */
const SCRATCHPAD = /(^|\/)\.opencode\/scratchpads\//

/** Whether a diff path is the author's scratchpad, not the work under review. */
export function isScratchpad(file: string | undefined): boolean {
  return file !== undefined && SCRATCHPAD.test(file.replaceAll("\\", "/"))
}

/**
 * The round's own messages: the user turn and the assistant replies answering
 * it. `summary.computeDiff` over every message returns the cumulative session
 * diff, so from round two QA would re-read round one; this narrows it to the
 * change this round made.
 */
export function roundMessages<T extends RoundMessage>(messages: ReadonlyArray<T>, userID: string): T[] {
  return messages.filter((message) => message.info.id === userID || (message.info.role === "assistant" && message.info.parentID === userID))
}

/** The round's diff, rendered for QA — the change, not an account of it. */
export function renderDiff(files: ReadonlyArray<DiffFile>): string {
  return files
    .filter((file) => !isScratchpad(file.file))
    .map((file) => {
      const header = `${file.file ?? "(unknown)"} (${file.status ?? "modified"}, +${file.additions} -${file.deletions})`
      return file.patch && file.patch.trim().length > 0 ? `${header}\n${file.patch}` : header
    })
    .join("\n\n")
}

/**
 * Whether the round produced a change QA can review. An empty diff is not a
 * pass: the ADR's rule is that a `done` over an empty diff is phantom, so the
 * call site fails the pass on one rather than let QA certify a change it cannot
 * see. A scratchpad-only change is empty for this purpose — it is the author's
 * prose, not work (ADR-0006, "state binding").
 */
export function isReviewableDiff(files: ReadonlyArray<DiffFile>): boolean {
  return files.some((file) => !isScratchpad(file.file) && (file.patch ?? "").trim().length > 0)
}

/**
 * QA's user turn. It carries only the diet: the contract, the diff, and the
 * gate's own output. Never the agent's response, the transcript, or the
 * scratchpad — an inherited "we are nearly done" is how a reviewer pleases by
 * agreeing (ADR-0006, "Three diets").
 */
export function buildQaPrompt(input: QaPromptInput): string {
  return [
    ...(input.contract
      ? ["Completion contract (the standard you hold the artifact to):", renderContract(input.contract), ""]
      : []),
    "State under review:",
    input.state,
    "",
    "Diff under review:",
    input.diff && input.diff.trim().length > 0 ? input.diff : "(no diff was recorded for this round)",
    "",
    ...(input.evidence && input.evidence.length > 0
      ? ["The check the author chose, as the loop ran it:", renderEvidence(input.evidence), ""]
      : []),
    "The artifact is in the working directory. Read it, run it, try to break it.",
    "",
    RECORD_SHAPE,
  ].join("\n")
}

/**
 * Reads a record from QA's reply. Never throws: an unreadable reply is an
 * abstention — a `clean` record bound to the round's state with no probes — so
 * a broken QA pass sends the loop back to work instead of passing silently.
 */
export function parseRecord(raw: string, state: string): SessionGoal.Record {
  const object = GoalJudge.extractObject(raw)
  if (!object) return abstention(state)
  const verdict = object["verdict"]
  if (verdict !== "clean" && verdict !== "contradicted") return abstention(state)
  // QA echoes the state it was given; if it omits it, the round's own state is
  // the best binding the loop has.
  const reviewed = object["state"]
  return {
    state: typeof reviewed === "string" && reviewed.length > 0 ? reviewed : state,
    verdict,
    probes: parseProbes(object["probes"]),
    findings: parseFindings(object["findings"]),
  }
}

/** A `clean` record with nothing executed. Silence is never a pass. */
export function abstention(state: string): SessionGoal.Record {
  return { state, verdict: "clean", probes: [], findings: [] }
}

/**
 * Attributes each probe to its author. `authorCommands` is the loop's own list —
 * the gates it runs and the contract's verification. A probe marked `derived`
 * whose command is one of them is the author's check wearing the badge: not a
 * holdout, and the loop must not let a relabel satisfy the rule that a `clean`
 * pass needs one (draft §4, "the holdout"). Correcting the flag keeps the record
 * honest for the judge, which weighs it.
 */
export function attributeProbes(
  record: SessionGoal.Record,
  authorCommands: ReadonlyArray<string>,
): SessionGoal.Record {
  const author = new Set(authorCommands.map(normalizeCommand).filter((command) => command.length > 0))
  if (author.size === 0) return record
  return {
    ...record,
    probes: record.probes.map((probe) =>
      probe.derived && author.has(normalizeCommand(probe.command)) ? { ...probe, derived: false } : probe,
    ),
  }
}

/** Command equality is exact but whitespace-insensitive: `bun  test` is `bun test`. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

/**
 * The fallback relay: the record's own findings, used when the judge supplied no
 * three-part handoff — it failed open, or its reply was partial. Each probe's
 * `command` is withheld: the dev needs the observation to find the cause, not
 * the command it can tune to (draft §6).
 */
export function relayContinuation(goal: string, record: SessionGoal.Record): string {
  const findings = record.findings.map((finding) =>
    [`- ${finding.criterion}: ${finding.detail}`, `  evidence: ${finding.evidence}`].join("\n"),
  )
  const observations = record.probes.map((probe) => `- ${probe.criterion}: ${probe.result} — ${observation(probe.output)}`)
  return [
    "[Continuing toward your standing goal — QA tested this, and it failed]",
    `Goal: ${goal}`,
    "",
    "QA's findings:",
    findings.length > 0 ? findings.join("\n") : "(no findings were recorded)",
    "",
    "What QA observed (the probe's command is withheld):",
    observations.length > 0 ? observations.join("\n") : "(no probes were recorded)",
    "",
    "Check it. If the cause is right, fix it. If it is wrong, say why, with the evidence — the record will be weighed again.",
  ].join("\n")
}

/**
 * The continuation the judge's three-part handoff produces. The judge frames the
 * parts; the loop renders them, so a paraphrased command cannot creep back in
 * (draft §6, "give the observation, withhold the probe's command").
 */
export function handoffContinuation(goal: string, handoff: GoalJudge.Handoff): string {
  return [
    "[Continuing toward your standing goal — QA tested this, and it failed]",
    `Goal: ${goal}`,
    "",
    "QA tested:",
    `  ${handoff.tested}`,
    "",
    "Your implementation:",
    `  ${handoff.implementation}`,
    "",
    "The likely cause:",
    `  ${handoff.cause}`,
    "",
    "Check it. If the cause is right, fix it. If it is wrong, say why, with the evidence — the record will be weighed again.",
  ].join("\n")
}

/** The continuation after a QA pass that ran nothing — an abstention. */
export function abstentionContinuation(goal: string): string {
  return [
    "[Continuing toward your standing goal — QA derived no probe of its own, so the round is not a pass]",
    `Goal: ${goal}`,
    "",
    "QA abstained: it recorded no probe it derived from the stated outcome, and the author's own checks are not enough — silence is not a pass. Make the outcome checkable — a command a reviewer can run against the artifact — and show it.",
  ].join("\n")
}

/**
 * The continuation after a QA pass that could not run at all. Fail-open: a
 * broken QA must not end a run that was still working, and the loop counts
 * consecutive failures so a misconfiguration stops the run instead of looping
 * blind (ADR-0006, "the loop has a floor").
 */
export function errorContinuation(goal: string): string {
  return [
    "[Continuing toward your standing goal — the QA pass could not run]",
    `Goal: ${goal}`,
    "",
    "The review did not complete, so this round was not certified. Continue the work; if the failure repeats, the loop stops and names the QA configuration rather than loop blind.",
  ].join("\n")
}

/** The continuation after a record that cannot be weighed because it is stale. */
export function staleContinuation(goal: string): string {
  return [
    "[Continuing toward your standing goal — the last QA record is stale]",
    `Goal: ${goal}`,
    "",
    "The work moved after QA reviewed it, so that record cannot be weighed. Finish this round and leave the workspace still — a fresh pass will follow.",
  ].join("\n")
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

function renderEvidence(evidence: ReadonlyArray<GoalJudge.GateEvidence>): string {
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

function observation(output: string): string {
  const trimmed = output.trim()
  if (trimmed.length === 0) return "(no output)"
  const [first] = trimmed.split("\n")
  return first ?? trimmed
}

function parseProbes(value: unknown): SessionGoal.Probe[] {
  if (!Array.isArray(value)) return []
  const probes: SessionGoal.Probe[] = []
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue
    const object = item as Record<string, unknown>
    const result = object["result"]
    if (result !== "pass" && result !== "fail" && result !== "could-not-run") continue
    probes.push({
      criterion: stringOf(object["criterion"]),
      derived: object["derived"] === true,
      command: stringOf(object["command"]),
      output: stringOf(object["output"]),
      result,
    })
  }
  return probes
}

function parseFindings(value: unknown): SessionGoal.Finding[] {
  if (!Array.isArray(value)) return []
  const findings: SessionGoal.Finding[] = []
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue
    const object = item as Record<string, unknown>
    findings.push({
      criterion: stringOf(object["criterion"]),
      detail: stringOf(object["detail"]),
      evidence: stringOf(object["evidence"]),
    })
  }
  return findings
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}
