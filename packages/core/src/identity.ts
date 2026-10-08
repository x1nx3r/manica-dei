export * as Identity from "./identity"

/**
 * The person a session works with, injected at summon as `MANUS_USER_*`.
 *
 * This is the fork's one product-side coupling to manus-dei, and it is an env
 * seam, not a code one: three strings in, a system-prompt block out. The fork
 * never imports anything from manus-dei.
 */
export interface Identity {
  readonly name: string
  readonly github?: string
  readonly role?: string
}

const NAME = "MANUS_USER_NAME"
const GITHUB = "MANUS_USER_GITHUB"
const ROLE = "MANUS_USER_ROLE"

/**
 * Reads the injected fields. Undefined when no name is present, so a session
 * summoned outside manus-dei is untouched: no block, no stance.
 */
export function fromEnv(env: Record<string, string | undefined>): Identity | undefined {
  const name = env[NAME]?.trim()
  if (!name) return undefined
  const github = env[GITHUB]?.trim()
  const role = env[ROLE]?.trim()
  return { name, ...(github ? { github } : {}), ...(role ? { role } : {}) }
}

/**
 * The model-visible block: who the person is, the time, and the stance.
 *
 * Pure, with the clock injected, so the whole feature is testable without a
 * model, a session, or a renderer.
 */
export function render(identity: Identity, time: Date): string {
  return [
    "<identity>",
    "The person you are working with:",
    `  Name: ${identity.name}`,
    ...(identity.github ? [`  GitHub: ${identity.github}`] : []),
    ...(identity.role ? [`  Role: ${identity.role}`] : []),
    `  Time: ${time.toDateString()}`,
    "</identity>",
    "",
    `Greet ${identity.name} by name. Read this repository's own standards — AGENTS.md, opencode.json, and .opencode/ — before acting. Ask what to work on before diving in. Hold this stance for the whole session, not only the first turn.`,
  ].join("\n")
}
