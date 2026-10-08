export * as Scratchpad from "./scratchpad"

import fs from "fs/promises"
import path from "path"

// Fork ADR-0006: the agent's working memory for one goal. A markdown file
// rather than a message, for three reasons: compaction cannot touch it, it is
// cheap to re-read, and it is the surface the judge and the human read. The
// plan file's content folds into the Subgoals section.
//
// The sections are stable, so every reader — the agent, the judge, a person —
// knows where to look.

export const SECTIONS = [
  "Goal",
  "Size",
  "Contract",
  "Assumptions",
  "Subgoals",
  "Open questions",
  "Decisions",
] as const
export type Section = (typeof SECTIONS)[number]

const heading = (section: Section) => `## ${section}\n`

/** The empty scratchpad. Every section is present, so a reader always finds one. */
export function init(): string {
  return `# Scratchpad\n\n${SECTIONS.map((section) => `${heading(section)}\n`).join("")}`
}

/**
 * Replaces one section's body. Every sibling is left byte-identical: the edit
 * is a splice, not a re-render.
 */
export function upsertSection(content: string, section: Section, body: string): string {
  const at = content.indexOf(heading(section))
  if (at === -1) throw new Error(`Unknown scratchpad section: ${section}`)
  const start = at + heading(section).length
  const next = content.indexOf("\n## ", start)
  const end = next === -1 ? content.length : next + 1
  return content.slice(0, start) + (body.length === 0 ? "\n" : `${body}\n\n`) + content.slice(end)
}

/** One section's body, without the blank line that separates it from the next. */
export function readSection(content: string, section: Section): string | undefined {
  const at = content.indexOf(heading(section))
  if (at === -1) return undefined
  const start = at + heading(section).length
  const next = content.indexOf("\n## ", start)
  const end = next === -1 ? content.length : next + 1
  return content.slice(start, end).replace(/\n+$/, "")
}

/** Every section at once, for the judge and the human. */
export function sections(content: string): Record<Section, string> {
  return Object.fromEntries(SECTIONS.map((section) => [section, readSection(content, section) ?? ""])) as Record<
    Section,
    string
  >
}

/** Reads the file, or an empty scratchpad when it does not exist yet. */
export async function read(file: string): Promise<string> {
  return fs.readFile(file, "utf8").catch(() => init())
}

/** Writes the file, creating its directory. The one writer. */
export async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf8")
}
