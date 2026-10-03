// The reconnect policy for the shared browser.
//
// Kept apart from the provider so it can be tested without a renderer or a
// socket. The policy is small but it is the part that decides whether a dropped
// stream recovers or hammers a container that is gone, and both mistakes are
// easy to make and hard to notice.
//
// The rules:
//
// - A drop is retried, because it is usually a container restart or a Chromium
//   crash, and both come back.
// - A deliberate close is never retried. Clicking the close button must not
//   start reconnecting the thing that was just closed.
// - The delay grows, so a container that is down is not asked every second.
// - The attempts are capped, so a stream that cannot come back becomes a
//   terminal failure with a reason and a control, not a silent spin.

/**
 * How long to wait before each attempt. The length caps the attempts.
 *
 * Five attempts summing to about seven seconds: long enough that a container
 * mid-restart is given time, short enough that a person is not left waiting on
 * something that is gone.
 */
export const RETRY_DELAYS_MS: readonly number[] = [300, 600, 1_200, 2_400, 4_800]

export type RetryState = {
  /** Attempts already made for the current drop. */
  attempt: number
  /** True when the teardown was asked for, so nothing should reconnect. */
  deliberate: boolean
}

/** The initial state: nothing tried, nothing closed on purpose. */
export function initialRetry(): RetryState {
  return { attempt: 0, deliberate: false }
}

/**
 * The delay before the next attempt, or undefined when there is none left.
 *
 * The attempt count is left to the caller; this only answers what the policy
 * says, so it stays a question about policy rather than about a timer.
 */
export function nextDelay(state: RetryState): number | undefined {
  if (state.deliberate) return undefined
  return RETRY_DELAYS_MS[state.attempt]
}

/** Whether another attempt remains, without consuming it. */
export function canRetry(state: RetryState): boolean {
  return nextDelay(state) !== undefined
}
