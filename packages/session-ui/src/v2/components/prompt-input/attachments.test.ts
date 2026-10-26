import { describe, expect, test } from "bun:test"
import { ACCEPTED_ATTACHMENT_TYPES, attachmentMime } from "./attachments"

// Issue #36: the v2 composer had its own accepted list and its own MIME
// detection, and archives were missing from both. The picker accepts the shared
// list; drop and paste both go through `attachmentMime`.
describe("v2 prompt attachments", () => {
  test("the picker accepts zip and rar", () => {
    for (const type of ["application/zip", "application/vnd.rar", "application/x-rar-compressed", ".zip", ".rar"]) {
      expect(ACCEPTED_ATTACHMENT_TYPES).toContain(type)
    }
  })

  test("an archive resolves by its MIME", async () => {
    expect(await attachmentMime(new File(["PK\u0003\u0004"], "project.zip", { type: "application/zip" }))).toBe(
      "application/zip",
    )
    expect(
      await attachmentMime(new File(["Rar!\u001a\u0007"], "assets.rar", { type: "application/x-rar-compressed" })),
    ).toBe("application/x-rar-compressed")
  })

  test("an archive resolves by its extension when the browser has no type", async () => {
    expect(await attachmentMime(new File(["PK\u0003\u0004"], "project.zip", { type: "" }))).toBe("application/zip")
    expect(
      await attachmentMime(new File(["PK\u0003\u0004"], "project.zip", { type: "application/octet-stream" })),
    ).toBe("application/zip")
    expect(await attachmentMime(new File(["Rar!\u001a\u0007"], "assets.rar", { type: "" }))).toBe("application/vnd.rar")
  })

  test("a binary that is not an archive is still refused", async () => {
    expect(
      await attachmentMime(new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })),
    ).toBeUndefined()
  })
})
