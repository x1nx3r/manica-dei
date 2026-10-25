/**
 * Whether the page may take focus without a user gesture.
 *
 * A cross-origin iframe cannot autofocus: Chrome blocks the focus and logs
 * "Blocked autofocusing on a <input> element in a cross-origin subframe". The
 * fleet embeds every session in exactly that frame (ADR-018), so automatic
 * focus is skipped there and the human clicks when they want the field.
 *
 * Comparing `window.self` with `window.top` is allowed across origins; an
 * opaque or hardened context can still throw, and the failure is a "do not
 * focus" rather than a crash.
 */
export function autoFocusAllowed(self: unknown, top: unknown): boolean {
  return self === top
}

export function canAutoFocus(): boolean {
  // `globalThis` rather than `window`: this module lives in a package without
  // the DOM lib, and a Node import must still answer "no" rather than throw.
  const window = (globalThis as { window?: { readonly self: unknown; readonly top: unknown } }).window
  if (!window) return false
  try {
    return autoFocusAllowed(window.self, window.top)
  } catch {
    return false
  }
}
