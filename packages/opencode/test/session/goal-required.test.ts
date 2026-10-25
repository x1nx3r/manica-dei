import { describe, expect, test } from "bun:test"
import * as GoalRequired from "@/session/goal-required"

const worktree = "/workspace"
const call = (input: Partial<GoalRequired.PreGoalInput> = {}): GoalRequired.PreGoalInput => ({
  required: true,
  tool: "edit",
  args: { filePath: `${worktree}/src/widget.ts` },
  worktree,
  ...input,
})

const patch = (...files: string[]) =>
  [
    "*** Begin Patch",
    ...files.flatMap((file) => [`*** Update File: ${file}`, "@@", "-old", "+new"]),
    "*** End Patch",
  ].join("\n")

describe("GoalRequired before the first goal", () => {
  test("the flag off keeps the old behavior", () => {
    for (const tool of ["todowrite", "mcp:github:create_issue", "edit", "execute"]) {
      expect(GoalRequired.refusal(call({ required: false, tool }))).toBeUndefined()
    }
  })

  test("an authorized goal keeps the old behavior", () => {
    for (const tool of ["todowrite", "mcp:github:create_issue", "edit", "execute"]) {
      expect(GoalRequired.refusal(call({ goal: { authorized: true }, tool }))).toBeUndefined()
    }
    expect(GoalRequired.refusal(call({ goal: { authorized: true } }))).toBeUndefined()
  })

  test("scoping tools and the shell stay open", () => {
    for (const tool of [
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
    ]) {
      expect(GoalRequired.refusal(call({ tool }))).toBeUndefined()
    }
  })

  test("an ADR, a scratchpad, and a plan may be written before the goal", () => {
    for (const file of [
      `${worktree}/docs/adr/0010-boundary.md`,
      `${worktree}/carbon-go-stack/docs/adr/0001-x.md`,
      `${worktree}/.opencode/scratchpads/notes.md`,
      `${worktree}/.opencode/plans/plan.md`,
      "docs/adr/relative.md",
    ]) {
      expect(GoalRequired.refusal(call({ args: { filePath: file } }))).toBeUndefined()
      expect(GoalRequired.refusal(call({ tool: "write", args: { filePath: file } }))).toBeUndefined()
    }
  })

  test("implementation files are refused, including a traversal that escapes the scoping directory", () => {
    for (const file of [
      `${worktree}/src/widget.ts`,
      `${worktree}/carbon-go-stack/main.go`,
      `${worktree}/docs/adr/../../src/widget.ts`,
      "/etc/passwd",
      `${worktree}/docs/architecture/x.md`,
      "",
    ]) {
      expect(GoalRequired.refusal(call({ args: { filePath: file } }))).toBe(GoalRequired.PATH_ONLY)
    }
  })

  test("apply_patch follows the same path rule, including a rename's destination", () => {
    expect(
      GoalRequired.refusal(call({ tool: "apply_patch", args: { patchText: patch("docs/adr/x.md") } })),
    ).toBeUndefined()
    expect(
      GoalRequired.refusal(call({ tool: "apply_patch", args: { patchText: patch("docs/adr/x.md", "src/x.ts") } })),
    ).toBe(GoalRequired.PATH_ONLY)
    expect(GoalRequired.refusal(call({ tool: "apply_patch", args: { patchText: patch("src/x.ts") } }))).toBe(
      GoalRequired.PATH_ONLY,
    )
    const move = [
      "*** Begin Patch",
      "*** Update File: docs/adr/x.md",
      "*** Move to: src/x.ts",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n")
    expect(GoalRequired.refusal(call({ tool: "apply_patch", args: { patchText: move } }))).toBe(GoalRequired.PATH_ONLY)
  })

  test("a malformed patch is left to the tool's own parser", () => {
    expect(GoalRequired.refusal(call({ tool: "apply_patch", args: { patchText: "not a patch" } }))).toBeUndefined()
  })

  test("a task list is implementation", () => {
    expect(GoalRequired.refusal(call({ tool: "todowrite", args: { todos: [] } }))).toBe(GoalRequired.TODO)
  })

  test("MCP tools and code mode are refused with the opaque-tool message", () => {
    for (const tool of ["mcp:github:create_issue", "mcp:context7:query", "execute"]) {
      expect(GoalRequired.refusal(call({ tool }))).toBe(GoalRequired.OPAQUE)
    }
    // An unknown tool is refused by default, with the message that names the
    // next act rather than guessing what it does.
    expect(GoalRequired.refusal(call({ tool: "some_new_tool" }))).toBe(GoalRequired.NO_GOAL)
  })

  test("a goal that is set but not authorized says so", () => {
    expect(GoalRequired.refusal(call({ tool: "some_new_tool", goal: { authorized: false } }))).toBe(
      GoalRequired.UNAUTHORIZED,
    )
    expect(GoalRequired.refusal(call({ tool: "mcp:github:create_issue", goal: { authorized: false } }))).toBe(
      GoalRequired.OPAQUE,
    )
    expect(GoalRequired.refusal(call({ tool: "todowrite", goal: { authorized: false } }))).toBe(GoalRequired.TODO)
    expect(GoalRequired.refusal(call({ goal: { authorized: false } }))).toBe(GoalRequired.PATH_ONLY)
  })
})
