import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import * as Upload from "@/session/uploads"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

describe("uploads", () => {
  it.effect("recognises zip and rar by mime or by extension", () =>
    Effect.sync(() => {
      expect(Upload.isArchive("application/zip", "a.bin")).toBe(true)
      expect(Upload.isArchive("application/x-zip-compressed", undefined)).toBe(true)
      expect(Upload.isArchive("application/vnd.rar", undefined)).toBe(true)
      expect(Upload.isArchive(undefined, "project.ZIP")).toBe(true)
      expect(Upload.isArchive("application/octet-stream", "assets.rar")).toBe(true)
      expect(Upload.isArchive("application/pdf", "guide.pdf")).toBe(false)
      expect(Upload.isArchive("application/octet-stream", "blob.bin")).toBe(false)
    }),
  )

  it.effect("decodes only a base64 data URL", () =>
    Effect.sync(() => {
      const bytes = Buffer.from("PK\u0003\u0004zip")
      const decoded = Upload.decodeDataUrl(`data:application/zip;base64,${bytes.toString("base64")}`)
      expect(decoded?.mime).toBe("application/zip")
      expect(decoded?.bytes.equals(bytes)).toBe(true)
      expect(Upload.decodeDataUrl("data:application/zip,not-base64")).toBeUndefined()
      expect(Upload.decodeDataUrl("file:///tmp/a.zip")).toBeUndefined()
    }),
  )

  it.effect("saves under the session upload store, sanitizes, and reuses the same bytes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "upload-")))
      const bytes = Buffer.from("PK\u0003\u0004zip")
      const url = `data:application/zip;base64,${bytes.toString("base64")}`
      const input = { sessionID: "ses_1", messageID: "msg_1", filename: "../../evil.zip", url, root }

      const first = yield* Upload.save(input)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(path.basename(first.path)).toBe("evil.zip")
      expect(first.path.startsWith(root)).toBe(true)
      expect(yield* Effect.promise(() => readFile(first.path))).toEqual(bytes)

      const again = yield* Upload.save(input)
      expect(again).toMatchObject({ ok: true, path: first.path, size: bytes.length })

      const different = yield* Upload.save({
        ...input,
        url: `data:application/zip;base64,${Buffer.from("other").toString("base64")}`,
      })
      expect(different.ok).toBe(true)
      if (!different.ok) return
      expect(different.path).not.toBe(first.path)
      expect(path.basename(different.path)).toBe("evil-1.zip")

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }),
  )

  it.effect("refuses an oversized or non-data-url upload", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "upload-")))
      const bytes = Buffer.from("PK\u0003\u0004zip")
      const url = `data:application/zip;base64,${bytes.toString("base64")}`

      const large = yield* Upload.save({
        sessionID: "ses_1",
        messageID: "msg_1",
        filename: "big.zip",
        url,
        root,
        limit: 2,
      })
      expect(large.ok).toBe(false)
      if (!large.ok) expect(large.error).toContain("exceeds")

      const notData = yield* Upload.save({
        sessionID: "ses_1",
        messageID: "msg_1",
        filename: "big.zip",
        url: "file:///tmp/a.zip",
        root,
      })
      expect(notData.ok).toBe(false)
      if (!notData.ok) expect(notData.error).toContain("data URL")

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }),
  )
})
