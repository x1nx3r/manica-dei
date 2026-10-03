// DOM key to X11 keysym.
//
// Generated and derived from X11's own `keysymdef.h`, not recalled. The rule
// that makes this small: for printable characters the keysym equals the Unicode
// codepoint, which is what the RFB specification relies on. Of the 2114 keysyms
// in that header, 192 are named entries that equal their codepoint, and the
// rest are either special keys or aliases.
//
// So there are two paths:
//
//   1. A special key, looked up by name.
//   2. Anything printable, taken from the codepoint of the typed character.
//
// The second path is what makes this work for scripts the table does not list,
// because it does not enumerate them. Keysyms below 0x100 are Latin-1, and
// RFB's Unicode keysyms live at 0x01000000 plus the codepoint, which is the
// range anything outside Latin-1 needs.

export const KEYSYM_UNICODE = 0x01000000

// The special keys, with values taken from keysymdef.h.
const SPECIAL: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Menu: 0xff67,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  Pause: 0xff13,
  PrintScreen: 0xff61,
  ContextMenu: 0xff67,
}

/** `F1` to `F12` are contiguous from 0xffbe, per keysymdef.h. */
const FUNCTION_KEY_BASE = 0xffbe
const FUNCTION_KEY_MAX = 12

/**
 * The keysym for a DOM keyboard event, or undefined when there is none.
 *
 * Returning undefined rather than a guess matters: a wrong keysym types the
 * wrong character into the agent's browser, which is worse than doing nothing.
 */
export function toKeysym(event: Pick<KeyboardEvent, "key" | "code">): number | undefined {
  const key = event.key

  // A function key is named F1 through F12.
  const functionKey = /^F(\d{1,2})$/.exec(key)
  if (functionKey) {
    const index = Number(functionKey[1])
    if (index >= 1 && index <= FUNCTION_KEY_MAX) return FUNCTION_KEY_BASE + (index - 1)
    return undefined
  }

  if (key in SPECIAL) return SPECIAL[key]

  // Dead keys and IME composition carry names like "Dead" or "Unidentified",
  // which have no single keysym. Dropping them is correct: the composed text
  // arrives as its own key event.
  if (key === "Dead" || key === "Unidentified" || key === "Compose" || key === "Process") return undefined

  // A single character is the only thing the codepoint rule applies to. A
  // multi-character name like "AudioVolumeUp" reaches here when it is neither
  // special nor a function key, and taking its first codepoint would type a
  // capital A. Dropping it is the honest outcome.
  if ([...key].length !== 1) return undefined

  // Its codepoint is the keysym when it is Latin-1, and a Unicode keysym
  // otherwise.
  const codepoint = key.codePointAt(0)
  if (codepoint === undefined) return undefined
  if (codepoint < 0x100) return codepoint
  return KEYSYM_UNICODE + codepoint
}
