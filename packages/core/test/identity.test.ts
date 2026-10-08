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
    expect(block).toContain("Greet Ada by name")
    expect(block).toContain("Read this repository's own standards")
    expect(block).toContain("Ask what to work on before diving in")
  })

  test("is stable for the same input — no clock read inside", () => {
    expect(Identity.render({ name: "Ada" }, time)).toBe(Identity.render({ name: "Ada" }, time))
  })
})
