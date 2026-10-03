import { describe, expect, test } from "bun:test"
import { RETRY_DELAYS_MS, canRetry, initialRetry, nextDelay, type RetryState } from "./browser-retry"

// The reconnect policy.
//
// These are the decisions that are easy to get wrong and easy not to notice: a
// deliberate close that reconnects anyway, a delay that never grows, or a loop
// with no end. They are pure, so they are tested directly.

describe("browser retry policy", () => {
  test("a fresh drop retries, and the delay grows", () => {
    const state = initialRetry()
    const delays: number[] = []
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      const delay = nextDelay(state)
      expect(delay).toBeDefined()
      delays.push(delay!)
      state.attempt += 1
    }
    // The delay never shrinks, and at least one step is strictly longer, so a
    // container that is down is not asked at a constant rate.
    expect(delays).toEqual([...RETRY_DELAYS_MS])
    expect(delays[delays.length - 1]!).toBeGreaterThan(delays[0]!)
  })

  test("the attempts are capped", () => {
    const state: RetryState = { attempt: RETRY_DELAYS_MS.length, deliberate: false }
    expect(nextDelay(state)).toBeUndefined()
    expect(canRetry(state)).toBe(false)
  })

  test("a deliberate close is never retried", () => {
    // Clicking close must not start reconnecting the thing just closed, at any
    // attempt count.
    const state: RetryState = { attempt: 0, deliberate: true }
    expect(nextDelay(state)).toBeUndefined()
    expect(canRetry(state)).toBe(false)
  })

  test("clearing the deliberate flag allows retries again", () => {
    // Reopening by hand, or a fresh session, must be able to retry even after a
    // deliberate close.
    const state: RetryState = { attempt: 0, deliberate: true }
    state.deliberate = false
    expect(nextDelay(state)).toBe(RETRY_DELAYS_MS[0]!)
  })

  test("every delay is positive and finite", () => {
    for (const delay of RETRY_DELAYS_MS) {
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThan(0)
    }
  })
})
