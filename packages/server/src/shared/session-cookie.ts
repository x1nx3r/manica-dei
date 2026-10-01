import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "opencode_session"

// Seven days. Per-boot key rotation means a restart invalidates outstanding
// cookies; sessions are ephemeral and the token is re-presented.
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

// Generated once per process. No new secret to manage: the cookie proves
// knowledge of the configured server password, HMAC-signed with this key.
const signingKey = randomBytes(32)

export function signSession(password: string, now = Math.floor(Date.now() / 1000)) {
  const expiry = now + SESSION_TTL_SECONDS
  const hmac = createHmac("sha256", signingKey).update(`${expiry}.${password}`).digest("base64url")
  return `${expiry}.${hmac}`
}

export function verifySession(cookie: string, password: string, now = Math.floor(Date.now() / 1000)) {
  const separator = cookie.lastIndexOf(".")
  if (separator === -1) return false
  const expiry = Number(cookie.slice(0, separator))
  if (!Number.isFinite(expiry) || expiry < now) return false
  const expected = createHmac("sha256", signingKey).update(`${expiry}.${password}`).digest("base64url")
  const actual = cookie.slice(separator + 1)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

export function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()))
  }
  return cookies
}

export function sessionCookieHeader(value: string) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
}
