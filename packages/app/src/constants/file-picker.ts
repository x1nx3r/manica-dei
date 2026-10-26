import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  ARCHIVE_MIME_TYPES,
  IMAGE_MIME_TYPES,
} from "@opencode-ai/core/util/attachment"

// The lists live in `@opencode-ai/core/util/attachment` so the legacy and v2
// composers cannot drift apart (issue #36).
export const ACCEPTED_IMAGE_TYPES = IMAGE_MIME_TYPES
export const ACCEPTED_ARCHIVE_TYPES = ARCHIVE_MIME_TYPES
export { ACCEPTED_FILE_TYPES, ACCEPTED_FILE_EXTENSIONS }

export function filePickerFilters(name: string, ext?: string[]) {
  if (!ext || ext.length === 0) return undefined
  return [{ name, extensions: ext }]
}
