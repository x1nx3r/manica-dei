import * as path from "path"
import { Patch } from "../patch"

/**
 * Fork ADR-0010: the authorized goal is the implementation boundary.
 *
 * A session with `goal.required` enabled is scoping until its root goal is
 * authorized. Scoping reads, searches, asks, researches, records the goal, and
 * writes the ADR. Implementation waits. The decision is a pure function of the
 * tool, its arguments, the worktree, and the goal state so it can be tested
 * without a session, and the call site stays one line.
 *
 * The allow-list is deliberate: a tool this table does not name is refused, so
 * a new tool cannot slip through the boundary by being forgotten. `bash` and
 * `browser` are named exceptions (ADR-0010, "the deliberate hole").
 */

/** Tools that may run before the goal is authorized. */
export const ALLOWED = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "skill",
  "question",
  "goal",
  "webfetch",
  "websearch",
  "browser",
  "task",
  "bash",
  "plan_enter",
  "plan_exit",
  "list_mcp_resources",
  "read_mcp_resource",
])

/** Tools whose paths must be scoping artifacts. */
export const CONDITIONAL = new Set(["edit", "write", "apply_patch"])

export const NO_GOAL =
  "Refused: implementation needs an authorized goal. Scoping tools (read, glob, grep, question), shell commands, and ADR writes under docs/adr/ are allowed. Set the goal with the goal tool and ask the human to authorize it, then continue."

export const UNAUTHORIZED =
  "Refused: the goal is set but not authorized. Ask the human to confirm the outcome and the check that proves it, then call the goal tool again with commit: true."

export const PATH_ONLY =
  "Refused: before the goal is authorized, files may be written only under docs/adr/, .opencode/scratchpads/, or .opencode/plans/. Set and authorize the goal before editing implementation files."

export const TODO = "Refused: a task list is implementation; set and authorize the goal first."

export const OPAQUE =
  "Refused: this tool can change the workspace, so it is unavailable before the goal is authorized. Use the scoping tools, or set and authorize the goal first."

const SCOPING = [/(^|\/)docs\/adr\//, /(^|\/)\.opencode\/(scratchpads|plans)\//]

function relative(worktree: string, file: string) {
  const normalized = file.replaceAll("\\", "/")
  const value = path.isAbsolute(normalized) ? path.relative(worktree, normalized).replaceAll("\\", "/") : normalized
  return path.posix.normalize(value).replace(/^\.\//, "")
}

/** Whether a path is a scoping artifact: an ADR, a scratchpad, or a plan. */
export function scopingPath(worktree: string, file: string): boolean {
  const value = relative(worktree, file)
  if (value === ".." || value.startsWith("../")) return false
  return SCOPING.some((pattern) => pattern.test(value))
}

function patchPaths(patchText: unknown): string[] | undefined {
  if (typeof patchText !== "string") return undefined
  try {
    const { hunks } = Patch.parsePatch(patchText)
    if (hunks.length === 0) return undefined
    return hunks.flatMap((hunk) =>
      hunk.type === "update" && hunk.move_path ? [hunk.path, hunk.move_path] : [hunk.path],
    )
  } catch {
    // The tool's own parser will reject it before any write. Do not turn a
    // malformed patch into a boundary decision.
    return undefined
  }
}

function paths(tool: string, args: Record<string, unknown>): string[] | undefined {
  if (tool === "apply_patch") return patchPaths(args.patchText)
  const file = args.filePath
  return typeof file === "string" && file.length > 0 ? [file] : undefined
}

export type PreGoalInput = {
  /** The flag `OPENCODE_GOAL_REQUIRED`. Off means this is the old behavior. */
  readonly required: boolean
  /** The root session's goal, when it has one. */
  readonly goal?: { readonly authorized: boolean }
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly worktree: string
}

/**
 * The refusal text for a tool call, or `undefined` when the call may proceed.
 *
 * A conditional tool is allowed only when every path it names is a scoping
 * artifact; the normal permission rules still run after this, so an ADR write
 * can still be asked or denied by the agent's own rules.
 */
export function refusal(input: PreGoalInput): string | undefined {
  if (!input.required || input.goal?.authorized) return undefined
  if (ALLOWED.has(input.tool)) return undefined

  const unauthorized = input.goal !== undefined
  if (CONDITIONAL.has(input.tool)) {
    const files = paths(input.tool, input.args)
    // A patch the tool itself cannot parse cannot write; its own rejection is
    // clearer than a boundary refusal.
    if (input.tool === "apply_patch" && files === undefined) return undefined
    if (files?.length && files.every((file) => scopingPath(input.worktree, file))) return undefined
    return PATH_ONLY
  }
  if (input.tool === "todowrite") return TODO
  if (input.tool.startsWith("mcp:") || input.tool === "execute") return OPAQUE
  return unauthorized ? UNAUTHORIZED : NO_GOAL
}
