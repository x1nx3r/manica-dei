/**
 * The file types a prompt accepts, and the archive helpers the composers and
 * the server share.
 *
 * The legacy composer and the v2 composer each kept their own list. The archive
 * types were added to one and missed in the other, so a zip was accepted by the
 * legacy composer and silently refused by v2 (issue #36). One list, one MIME
 * fallback, both pickers.
 */

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

export const ARCHIVE_MIME_TYPES = [
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-rar",
] as const

export const ARCHIVE_EXTENSIONS = ["zip", "rar"] as const

export const ACCEPTED_FILE_TYPES = [
  ...IMAGE_MIME_TYPES,
  "application/pdf",
  ...ARCHIVE_MIME_TYPES,
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
  ".zip",
  ".rar",
]

const MIME_EXT = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
  ["application/zip", "zip"],
  ["application/x-zip", "zip"],
  ["application/x-zip-compressed", "zip"],
  ["application/vnd.rar", "rar"],
  ["application/x-rar-compressed", "rar"],
  ["application/x-rar", "rar"],
  ["application/json", "json"],
  ["application/ld+json", "jsonld"],
  ["application/toml", "toml"],
  ["application/x-toml", "toml"],
  ["application/x-yaml", "yaml"],
  ["application/xml", "xml"],
  ["application/yaml", "yaml"],
])

const TEXT_EXT = ["txt", "text", "md", "markdown", "log", "csv"]

export const ACCEPTED_FILE_EXTENSIONS = Array.from(
  new Set(
    ACCEPTED_FILE_TYPES.flatMap((item) => {
      if (item.startsWith(".")) return [item.slice(1)]
      if (item === "text/*") return TEXT_EXT
      const out = MIME_EXT.get(item)
      return out ? [out] : []
    }),
  ),
).sort()

const ARCHIVE_MIMES = new Set<string>(ARCHIVE_MIME_TYPES)

export function isArchiveMime(mime: string | undefined): boolean {
  if (!mime) return false
  return ARCHIVE_MIMES.has(mime)
}

export function archiveExtension(filename: string | undefined): "zip" | "rar" | undefined {
  const base = filename?.replaceAll("\\", "/").split("/").pop() ?? ""
  const index = base.lastIndexOf(".")
  if (index <= 0) return
  const suffix = base.slice(index + 1).toLowerCase()
  return suffix === "zip" || suffix === "rar" ? suffix : undefined
}

/** The canonical MIME for an archive extension, for a browser with no type. */
export function archiveMime(filename: string | undefined): string | undefined {
  const extension = archiveExtension(filename)
  if (extension === "zip") return "application/zip"
  if (extension === "rar") return "application/vnd.rar"
}
