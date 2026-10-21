export * as ProcessGuard from "./process-guard"

/**
 * Fork ADR-0006 live-fire finding (the wallpaper run, corpus round 1): QA's
 * `pkill -9 -f 'next'` matched **its own shell's command line** — the whole
 * command string is in the argv of the `bash -c` that runs it — killed the
 * shell, and with it the entire QA pass. A reviewer died by its own hygiene
 * instruction. The guard refuses the pattern families that can do this, where
 * the command is about to run, instead of trusting the prompt to remember.
 *
 * Refused:
 * - `pkill -f <pattern>` — matches command lines, including this tool's shell.
 * - `killall -r <pattern>` — the regex form has the same blast radius.
 * - `pgrep -f …` piped into `kill`/`xargs kill` — the same match, laundered.
 *
 * Allowed: names and PIDs (`pkill -x next`, `kill <pid>`, `killall next`),
 * which cannot match the shell that runs them.
 */
export function broadKill(command: string): string | undefined {
  const flat = command.replace(/\s+/g, " ")
  if (/\bpkill\b[^|;&]*\s-f(?:\s|$)/.test(flat)) {
    return "pkill -f matches full command lines — including the shell that is running this command"
  }
  if (/\bkillall\b[^|;&]*\s-r(?:\s|$)/.test(flat)) {
    return "killall -r matches by pattern — the same blast radius as pkill -f"
  }
  if (/\bpgrep\b[^|;&]*\s-f(?:\s|$)/.test(flat) && /\bkill\b/.test(flat)) {
    return "pgrep -f piped into kill matches command lines — including this tool's own shell"
  }
  return undefined
}

/** The refusal text a tool surfaces to the model. */
export function refuse(reason: string): string {
  return [
    `Refused: ${reason}.`,
    "Target processes by PID instead: `pgrep -x <exact-name>` (or `pgrep -f` alone to inspect), then `kill <pid>`. `pkill -x <exact-name>` is also allowed.",
  ].join(" ")
}
