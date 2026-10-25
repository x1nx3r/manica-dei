import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

/**
 * Fork: archives are uploads, not model attachments.
 *
 * A zip or rar is not something a model reads; it is a container the agent
 * inspects with the shell. The prompt part arrives as a base64 data URL, and
 * this module writes it to the session's upload store and returns the path the
 * call site announces. The path is outside the workspace, so an upload never
 * enters a snapshot, a diff, or a review.
 */

export const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar",
  "application/x-rar-compressed",
])

export const ARCHIVE_EXTENSIONS = new Set(["zip", "rar"])

/** The cap before a base64 upload becomes a memory problem. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export function archiveExtension(filename: string | undefined): "zip" | "rar" | undefined {
  const base = filename?.replaceAll("\\", "/").split("/").pop() ?? ""
  const index = base.lastIndexOf(".")
  if (index <= 0) return
  const suffix = base.slice(index + 1).toLowerCase()
  return suffix === "zip" || suffix === "rar" ? suffix : undefined
}

export function isArchive(mime: string | undefined, filename?: string): boolean {
  if (mime && ARCHIVE_MIMES.has(mime)) return true
  return archiveExtension(filename) !== undefined
}

/** A filename that cannot escape the upload directory. */
export function safeName(filename: string | undefined): string {
  const base = (filename ?? "").replaceAll("\\", "/").split("/").pop() ?? ""
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") return "archive"
  return cleaned
}

/** A base64 data URL's bytes, or nothing when it is not one. */
export function decodeDataUrl(url: string): { mime?: string; bytes: Buffer } | undefined {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(url)
  if (!match) return
  return { ...(match[1] ? { mime: match[1] } : {}), bytes: Buffer.from(match[2] ?? "", "base64") }
}

export type Saved = { ok: true; path: string; size: number } | { ok: false; error: string }

export const save = Effect.fn("Uploads.save")(function* (input: {
  sessionID: string
  messageID: string
  filename?: string
  url: string
  root?: string
  limit?: number
}) {
  const decoded = decodeDataUrl(input.url)
  if (!decoded) return { ok: false, error: "the attachment is not a base64 data URL" } as const
  if (decoded.bytes.length > (input.limit ?? MAX_UPLOAD_BYTES)) {
    return {
      ok: false,
      error: `the archive exceeds ${Math.ceil((input.limit ?? MAX_UPLOAD_BYTES) / (1024 * 1024))} MB`,
    } as const
  }

  const fsys = yield* FSUtil.Service
  const root = input.root ?? path.join(Global.Path.data, "uploads")
  const dir = path.join(root, input.sessionID, input.messageID)
  let name = safeName(input.filename)
  let target = path.join(dir, name)

  // The same part is resolved again on every step of the run. Reuse the file
  // when the bytes match; suffix a name when a second upload collides.
  for (let index = 0; index < 100; index++) {
    const size = yield* fsys.stat(target).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => undefined),
    )
    if (size === undefined) break
    if (size === decoded.bytes.length) return { ok: true, path: target, size: decoded.bytes.length } as const
    const extension = path.extname(name)
    name = `${name.slice(0, name.length - extension.length)}-${index + 1}${extension}`
    target = path.join(dir, name)
  }

  const written = yield* fsys.writeWithDirs(target, decoded.bytes).pipe(
    Effect.map(() => true),
    Effect.catch((error) => Effect.succeed(error instanceof Error ? error.message : String(error))),
  )
  if (written !== true) return { ok: false, error: written } as const
  return { ok: true, path: target, size: decoded.bytes.length } as const
})
