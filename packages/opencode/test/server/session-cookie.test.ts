import { describe, expect, test } from "bun:test"
import { parseCookies, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookieHeader, signSession, verifySession } from "@opencode-ai/server/shared/session-cookie"

describe("session cookie", () => {
  test("signs and verifies a cookie bound to the password", () => {
    const cookie = signSession("secret", 1_000_000)
    expect(verifySession(cookie, "secret", 1_000_001)).toBe(true)
  })

  test("rejects a cookie signed with a different password", () => {
    const cookie = signSession("secret", 1_000_000)
    expect(verifySession(cookie, "other", 1_000_001)).toBe(false)
  })

  test("rejects an expired cookie", () => {
    const cookie = signSession("secret", 1_000_000)
    expect(verifySession(cookie, "secret", 1_000_000 + SESSION_TTL_SECONDS + 1)).toBe(false)
  })

  test("rejects a forged cookie", () => {
    expect(verifySession("9999999999.forgedsignature", "secret", 1_000_000)).toBe(false)
  })

  test("rejects malformed cookies", () => {
    expect(verifySession("", "secret", 1_000_000)).toBe(false)
    expect(verifySession("no-separator", "secret", 1_000_000)).toBe(false)
    expect(verifySession("notanumber.abc", "secret", 1_000_000)).toBe(false)
  })

  test("cookie header carries browser-safe attributes", () => {
    const header = sessionCookieHeader(signSession("secret", 1_000_000))
    expect(header).toContain(`${SESSION_COOKIE}=`)
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Path=/")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`)
  })

  test("parses cookies from a header", () => {
    const cookies = parseCookies(`${SESSION_COOKIE}=abc; other=value; bare`)
    expect(cookies.get(SESSION_COOKIE)).toBe("abc")
    expect(cookies.get("other")).toBe("value")
    expect(cookies.has("bare")).toBe(false)
  })

  test("parses an empty or missing header", () => {
    expect(parseCookies(undefined).size).toBe(0)
    expect(parseCookies("").size).toBe(0)
  })
})
