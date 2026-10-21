export * as GoalVerification from "./goal-verification"

/**
 * Fork ADR-0006 live-fire finding (corpus, the wallpaper run): the dev wrote
 * its contract's `verification` as prose — "…npm run build, plus browser
 * screenshots of the picker open in dark and light mode". The loop runs that
 * string verbatim as a shell command, so the gate failed twice and burned two
 * dev rounds; the judge later named the swallowed screenshot clause as a
 * finding. The tool text now demands one exact command line; this refusal is
 * the parser-level backstop for a model that means well and writes a sentence.
 *
 * The rules catch prose markers, not command content: a real command may
 * contain any word, but the shapes below are how a sentence joins clauses.
 */
const PROSE: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\n/, reason: "a command line is one line; the verification spans several" },
  {
    pattern: /,\s*(?:plus|and|then|also)\b/i,
    reason: "a comma joins a clause to the command — move the clause to constraints",
  },
  {
    pattern: /\bplus\b/i,
    reason: "'plus' joins a clause to the command — move the clause to constraints",
  },
  { pattern: /\band then\b/i, reason: "'and then' describes work instead of running it" },
  {
    pattern: /\b(?:screenshots?|browser check|manual check|make sure|verify that|ensure that)\b/i,
    reason: "naming a check instead of running it makes the gate unrunnable",
  },
  {
    pattern: /\.\s+[A-Z]/,
    reason: "a sentence boundary inside the verification makes it unrunnable",
  },
]

/** The reason a verification is prose rather than one runnable command, if any. */
export function proseReason(verification: string): string | undefined {
  for (const rule of PROSE) {
    if (rule.pattern.test(verification)) return rule.reason
  }
  return undefined
}

/** The refusal the goal tool returns; it names the fix, not just the fault. */
export function refuse(verification: string): { title: string; output: string } {
  return {
    title: "The verification must be one exact shell command",
    output: [
      `The verification reads as prose: "${verification}".`,
      "The loop runs it verbatim as a shell command before every judge, so it must be one runnable command line.",
      "Move the descriptive clauses — screenshots, browser checks, 'plus …' — into the contract's constraints, and keep verification to the command that proves the outcome.",
    ].join(" "),
  }
}
