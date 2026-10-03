import { describe, expect, test } from "bun:test"
import { KEYSYM_UNICODE, toKeysym } from "./keysym"

// Keysyms, derived from X11's keysymdef.h rather than recalled.
//
// The values in the special table are taken from that header and pinned here,
// because a wrong keysym types the wrong character into the agent's browser,
// which is worse than dropping the key.

const key = (value: string) => ({ key: value, code: "" })

describe("special keys", () => {
  test("matches the values in keysymdef.h", () => {
    expect(toKeysym(key("Backspace"))).toBe(0xff08)
    expect(toKeysym(key("Tab"))).toBe(0xff09)
    expect(toKeysym(key("Enter"))).toBe(0xff0d)
    expect(toKeysym(key("Escape"))).toBe(0xff1b)
    expect(toKeysym(key("Delete"))).toBe(0xffff)
    expect(toKeysym(key("Insert"))).toBe(0xff63)
    expect(toKeysym(key("Home"))).toBe(0xff50)
    expect(toKeysym(key("End"))).toBe(0xff57)
    expect(toKeysym(key("PageUp"))).toBe(0xff55)
    expect(toKeysym(key("PageDown"))).toBe(0xff56)
    expect(toKeysym(key("ArrowLeft"))).toBe(0xff51)
    expect(toKeysym(key("ArrowUp"))).toBe(0xff52)
    expect(toKeysym(key("ArrowRight"))).toBe(0xff53)
    expect(toKeysym(key("ArrowDown"))).toBe(0xff54)
    expect(toKeysym(key("Shift"))).toBe(0xffe1)
    expect(toKeysym(key("Control"))).toBe(0xffe3)
    expect(toKeysym(key("Alt"))).toBe(0xffe9)
    expect(toKeysym(key("Meta"))).toBe(0xffeb)
  })

  test("function keys run from F1", () => {
    expect(toKeysym(key("F1"))).toBe(0xffbe)
    expect(toKeysym(key("F2"))).toBe(0xffbf)
    expect(toKeysym(key("F12"))).toBe(0xffc9)
  })

  test("F13 and beyond are dropped rather than guessed", () => {
    expect(toKeysym(key("F13"))).toBeUndefined()
  })
})

describe("printable characters", () => {
  test("Latin-1 is its own codepoint", () => {
    expect(toKeysym(key(" "))).toBe(0x20)
    expect(toKeysym(key("a"))).toBe(0x61)
    expect(toKeysym(key("A"))).toBe(0x41)
    expect(toKeysym(key("0"))).toBe(0x30)
    expect(toKeysym(key("!"))).toBe(0x21)
    expect(toKeysym(key("~"))).toBe(0x7e)
    // The upper end of Latin-1, which is the last range that is its own value.
    expect(toKeysym(key("ÿ"))).toBe(0xff)
  })

  test("outside Latin-1 uses the Unicode keysym range", () => {
    // RFB puts Unicode keysyms at 0x01000000 plus the codepoint, which is how
    // this works for scripts the table does not enumerate.
    expect(toKeysym(key("€"))).toBe(KEYSYM_UNICODE + 0x20ac)
    expect(toKeysym(key("日"))).toBe(KEYSYM_UNICODE + 0x65e5)
    expect(toKeysym(key("😀"))).toBe(KEYSYM_UNICODE + 0x1f600)
  })

  test("the boundary is exactly 0x100", () => {
    // 0xffff and 0x100 are the two sides of the rule.
    expect(toKeysym(key("\u00ff"))).toBe(0xff)
    expect(toKeysym(key("\u0100"))).toBe(KEYSYM_UNICODE + 0x100)
  })
})

describe("keys with no keysym", () => {
  test("composition markers are dropped", () => {
    // The composed text arrives as its own event, so a keysym here would type
    // the wrong thing.
    expect(toKeysym(key("Dead"))).toBeUndefined()
    expect(toKeysym(key("Compose"))).toBeUndefined()
    expect(toKeysym(key("Process"))).toBeUndefined()
    expect(toKeysym(key("Unidentified"))).toBeUndefined()
  })

  test("the empty key is dropped", () => {
    expect(toKeysym(key(""))).toBeUndefined()
  })

  test("multi-character names that are not function keys are dropped", () => {
    // "AudioVolumeUp" and friends have no plain keysym, and guessing one would
    // press something else.
    expect(toKeysym(key("AudioVolumeUp"))).toBeUndefined()
    expect(toKeysym(key("LaunchMail"))).toBeUndefined()
  })
})
