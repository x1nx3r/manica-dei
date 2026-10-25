import { toKeysym } from "./keysym"

/**
 * The keys the human pane has pressed and not released.
 *
 * RFB is a stateful stream: a keysym goes down and comes up. The pane used to
 * forward `keyup` only while the canvas had focus, so a modifier held while
 * focus moved (to the composer, the terminal, another tab, or the OS) never got
 * its release. The remote kept Ctrl down, and the next click or keystroke was
 * modified (issue #31).
 *
 * Tracking the pressed set lets the pane release it on blur, teardown, a
 * connection drop, and a hidden tab, rather than trusting that a `keyup` will
 * arrive on the canvas.
 */
export type KeySender = (keysym: number, down: boolean) => void

export interface KeyReleaser {
  /** A key went down on the pane's canvas. */
  down(keysym: number): void
  /** A key came up on the pane's canvas. */
  up(keysym: number): void
  /** Release everything still held, exactly once. */
  release(): void
  /** How many keys the pane believes are held, for tests and diagnostics. */
  pressed(): number
}

export function createKeyReleaser(send: KeySender): KeyReleaser {
  const held = new Set<number>()
  return {
    down(keysym) {
      // Auto-repeat sends the same keydown again; the set stays one entry and
      // the remote still sees the repeat, as it did before.
      held.add(keysym)
      send(keysym, true)
    },
    up(keysym) {
      held.delete(keysym)
      // Send the up even when the pane did not see the down: a key held before
      // the canvas took focus must still be released, not left to the remote.
      send(keysym, false)
    },
    release() {
      if (held.size === 0) return
      for (const keysym of held) send(keysym, false)
      held.clear()
    },
    pressed() {
      return held.size
    },
  }
}

/**
 * The canvas handlers, split from the component so a DOM test can drive them.
 *
 * An unmapped key is dropped rather than guessed: a wrong keysym types the
 * wrong character into the agent's browser.
 */
export function keyHandlers(keys: KeyReleaser) {
  return {
    onKeyDown(event: KeyboardEvent) {
      const keysym = toKeysym(event)
      if (keysym === undefined) return
      event.preventDefault()
      keys.down(keysym)
    },
    onKeyUp(event: KeyboardEvent) {
      const keysym = toKeysym(event)
      if (keysym === undefined) return
      event.preventDefault()
      keys.up(keysym)
    },
  }
}
