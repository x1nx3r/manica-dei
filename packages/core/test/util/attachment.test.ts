import { describe, expect, test } from "bun:test"
import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  archiveMime,
  isArchiveMime,
} from "@opencode-ai/core/util/attachment"

// Issue #36: the legacy composer and the v2 composer kept separate lists, and
// archives were added to only one. This module is the one list both use.
describe("attachment types", () => {
  test("the shared list includes both archive families", () => {
    for (const type of [
      "application/zip",
      "application/x-zip-compressed",
      "application/vnd.rar",
      "application/x-rar-compressed",
      "application/x-rar",
    ]) {
      expect(ACCEPTED_FILE_TYPES).toContain(type)
    }
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("zip")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("rar")
  })

  test("an archive resolves from its extension when the browser has no type", () => {
    expect(archiveMime("project.ZIP")).toBe("application/zip")
    expect(archiveMime("assets.rar")).toBe("application/vnd.rar")
    expect(archiveMime("C:\\Users\\me\\project.zip")).toBe("application/zip")
    expect(archiveMime("notes.txt")).toBeUndefined()
    expect(archiveMime(undefined)).toBeUndefined()
  })

  test("archive MIME detection is exact", () => {
    expect(isArchiveMime("application/zip")).toBe(true)
    expect(isArchiveMime("application/vnd.rar")).toBe(true)
    expect(isArchiveMime("application/pdf")).toBe(false)
    expect(isArchiveMime(undefined)).toBe(false)
  })
})
