import { describe, expect, test } from "bun:test"
import { Identity } from "@opencode-ai/core/identity"

// F1.8: the identity block and the session stance. Pure, so it is tested
// directly — the injection point and the service method are one line each and
// have nothing to prove on their own.

const time = new Date("2026-10-08T10:00:00Z")

describe("Identity.fromEnv", () => {
  test("reads the three injected fields", () => {
    expect(
      Identity.fromEnv({
        MANUS_USER_NAME: "Ada",
        MANUS_USER_GITHUB: "ada",
        MANUS_USER_ROLE: "frontend developer",
      }),
    ).toEqual({ name: "Ada", github: "ada", role: "frontend developer" })
  })

  test("no name → undefined, so a stock session is untouched", () => {
    expect(Identity.fromEnv({})).toBeUndefined()
    expect(Identity.fromEnv({ MANUS_USER_GITHUB: "ada", MANUS_USER_ROLE: "dev" })).toBeUndefined()
  })

  test("partial fields are kept, not required", () => {
    expect(Identity.fromEnv({ MANUS_USER_NAME: "Ada" })).toEqual({ name: "Ada" })
    expect(Identity.fromEnv({ MANUS_USER_NAME: "Ada", MANUS_USER_ROLE: "dev" })).toEqual({
      name: "Ada",
      role: "dev",
    })
  })

  test("blank values are treated as absent", () => {
    expect(Identity.fromEnv({ MANUS_USER_NAME: "Ada", MANUS_USER_GITHUB: "  " })).toEqual({ name: "Ada" })
    expect(Identity.fromEnv({ MANUS_USER_NAME: "   " })).toBeUndefined()
  })
})

describe("Identity.render", () => {
  test("names the person, their github, their role, and the time", () => {
    const block = Identity.render({ name: "Ada", github: "ada", role: "frontend developer" }, time)
    expect(block).toContain("Name: Ada")
    expect(block).toContain("GitHub: ada")
    expect(block).toContain("Role: frontend developer")
    expect(block).toContain(`Time: ${time.toDateString()}`)
  })

  test("omits the fields that are absent", () => {
    const block = Identity.render({ name: "Ada" }, time)
    expect(block).not.toContain("GitHub:")
    expect(block).not.toContain("Role:")
  })

  test("carries the stance, and names the person in it", () => {
    const block = Identity.render({ name: "Ada" }, time)
    // ADR-0008.5: the greeting is first-turn only — the stance is re-sent on
    // every request, and an unconditional greet made a continuing session
    // greet again after a phantom session was minted.
    expect(block).toContain("greet Ada by name")
    expect(block).toContain("If Ada has already been greeted in this session, do not greet again")
    expect(block).toContain("Read every repository's own standards")
    expect(block).toContain("Ask what to work on before diving in")
    // The stance must point at the kickoff, or the agent just does the task.
    expect(block).toContain("set the goal with the goal tool")
    // And at the confirmation, so the agent asks the person to agree what done
    // means rather than only to run unattended (ADR-0006).
    expect(block).toContain("to confirm before running unattended")
  })

  test("teaches the contract as a spec, with a runnable verification", () => {
    const block = Identity.render({ name: "Ada" }, time)
    // ADR-0008.5: the prose-verification defect burned two dev rounds in the
    // corpus; the stance names the requirement where the model writes it.
    expect(block).toContain("verification as one exact command line the loop runs verbatim")
    expect(block).toContain("belong in constraints, not verification")
    expect(block).toContain("stop_when")
    expect(block).toContain("never authorize yourself")
  })

  test("narrates the loop once, and names the multi-repo workspace", () => {
    const block = Identity.render({ name: "Ada" }, time)
    // The dev should not argue with its own harness: gates, QA, judge.
    expect(block).toContain("the gates run your verification")
    expect(block).toContain("a fresh-context reviewer (QA) attacks the artifact")
    expect(block).toContain("Nobody here signs their own work")
    // ADR-0009's shape, announced before the snapshot work lands.
    expect(block).toContain("The workspace may hold several repositories")
  })

  test("is stable for the same input — no clock read inside", () => {
    expect(Identity.render({ name: "Ada" }, time)).toBe(Identity.render({ name: "Ada" }, time))
  })
})
