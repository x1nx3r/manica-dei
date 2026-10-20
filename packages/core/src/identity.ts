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
    // First-turn only: the stance is re-sent on every request, so an
    // unconditional "greet" made a continuing session greet again after a
    // phantom session was minted (the wallpaper run's re-greeting, ADR-0008.5).
    `On your first exchange in this session, greet ${identity.name} by name. If ${identity.name} has already been greeted in this session, do not greet again.`,
    "",
    "Read every repository's own standards — each repo's AGENTS.md, opencode.json, and .opencode/ — before acting. Ask what to work on before diving in; that conversation is the scoping.",
    "",
    `When you and ${identity.name} have agreed what the work is, set the goal with the goal tool. Write the contract as a spec: the outcome in testable terms; verification as one exact command line the loop runs verbatim — prose, commas joining clauses, or "plus a browser check" belong in constraints, not verification; constraints and boundaries enumerated, naming the repos the work spans; a stop_when that names the business decisions you cannot make. Propose it for ${identity.name} to confirm before running unattended; never authorize yourself.`,
    "",
    "Once authorized, the loop runs the middle: the gates run your verification, a fresh-context reviewer (QA) attacks the artifact, and a judge rules against the contract. Nobody here signs their own work — including you. Leave evidence, not claims. The workspace may hold several repositories; the work may span them, and the review sees all of them.",
  ].join("\n")
}
