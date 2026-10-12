# F1 — the goal loop, live: Wordle

A live exercise of the loop (ADR-0006) on a small, well-known spec, driven
interactively with a real model. The point is not the Wordle. The point is to
watch the loop scope, commit, work, and judge — and to see what the scoping
catches before a line is written.

This is the run the milestone notes call M6b, kept in full because the loop's
value is in the transcript, not in a green check.

## The setup

- **The spec.** `README.md` in a fresh git repo: `score(guess, answer)` returns
  one tile per letter — `correct`, `present`, or `absent`. `wordle.test.ts`
  held four obvious cases.
- **Held back.** The duplicate-letter edge cases — the real difficulty of
  Wordle scoring — were **not** in the public tests. The human holds them and
  reveals them only if the agent asks.
- **The model.** `opencode-go/deepseek-v4.1-flash`, the branch build, the real
  auth.
- **The human.** Ada, played turn by turn: one opening goal, answers to the
  agent's questions, the commit approval.

## What happened

### Scope — the loop's whole reason

The agent read the repo standards first. Its opening line is the F1.8 stance
working:

> Hey Ada. Let me read the repo standards and the spec before I ask you
> anything.

Then it found a **contradiction in the supplied tests** — a real bug, mine:

> `wordle.test.ts:20` expects `score("PLANE", "APPLE")` →
> `["correct","present","present","present","correct"]`. That can't be right
> under the README's rule: `guess[0]="P"` vs `answer[0]="A"` cannot be
> `correct`, and `guess[3]="N"` is not in `APPLE`. … it is provably impossible
> for line 20 to hold alongside line 16 (`LEMON` pins the argument order).

It did not stop at flagging it. It asked three questions and offered the right
answer to each:

1. **The duplicate-letter rule** — the untested edge case — offering the
   standard two-pass rule (greens first; yellows consume only the remaining
   unmatched answer letters).
2. **How to handle the broken `PLANE` test** — fix it, or work around it.
3. **Whether to validate input.**

### Commit

It wrote the goal, the size, the contract, and — the piece the ADR insists on —
a **stop condition** (see the record below), then asked for permission to run
unattended.

### Work

It wrote `score()`, fixed line 20, and added the duplicate tests. Mid-run it
caught **its own** error:

> Verifying my GEESE expectation — it's wrong; both E's in the answer are green,
> so the non-green E must be absent. Fixing that test.

### Judge

The gate `bun test` ran → exit 0, 8 pass. The judge returned `done`. The goal
was marked done after **one** turn.

## The outcome

`wordle.ts` uses two passes, and the greens consume the answer's copies first:

```ts
export function score(guess: string, answer: string): Tile[] {
  const tiles: Tile[] = Array(guess.length).fill("absent")
  const remaining = new Map<string, number>()
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === answer[i]) tiles[i] = "correct"
    else remaining.set(answer[i], (remaining.get(answer[i]) ?? 0) + 1)
  }
  for (let i = 0; i < guess.length; i++) {
    if (tiles[i] === "correct") continue
    const count = remaining.get(guess[i]) ?? 0
    if (count > 0) {
      tiles[i] = "present"
      remaining.set(guess[i], count - 1)
    }
  }
  return tiles
}
```

It passes the public tests **and** eight independently computed hidden edge
cases: `SPEED/ERASE`, `ALLEY/APPLE`, `HELLO/WORLD`, `ABBEY/BABES`,
`EERIE/SPEED`, `GEESE/EGRET`, `LEVEL/EAGLE`, `BANAL/ALLEY`.

## What it showed

- **SCOPE works.** The agent front-loaded its questions and found a real defect
  in the tests before writing code. That is the behaviour ADR-0006 predicts,
  and it is the behaviour that keeps mid-work questions rare.
- **The contract held.** The verification was a command (`bun test`), and the
  agent added the tests that make it meaningful — the duplicate cases it had
  just agreed to.
- **The stance carried.** The greeting, the repo-first read, and the `goal`
  tool all fired, from F1.8 through M5.
- **The judge is a reader; the gate is the teeth.** The judge saw a passing
  gate and said `done`. The hidden cases are the human's separate check, and
  they passed too.

## The judge record

From `session_goal` after the run:

```
goal:          Implement the Wordle scoring function in wordle.ts: score(guess,
               answer) returns a Tile[] of "correct" | "present" | "absent",
               using the standard two-pass rule (greens first, then yellows
               consume only remaining unmatched answer letters). Fix the
               contradictory expectation at wordle.test.ts:20 to the
               spec-correct value, and add tests covering the duplicate-letter
               edge cases.
size:          small — "One pure function; the spec, argument order, and the one
               real edge case (duplicates) are now all settled. Only decision
               left was the test fix, already agreed."
contract:
  outcome:     wordle.ts exports score() and the Tile type with correct two-pass
               scoring; bun test passes cleanly including new duplicate-letter
               tests.
  verification: bun test
  constraints: Follow README semantics; score() is pure and assumes valid 5
               uppercase letters (no validation). Do not change the argument
               order or the LEMON/STORM/APPLE expectations. Do not touch
               package.json or README.md.
  boundaries:  wordle.ts (new) and wordle.test.ts (fix line 20, add tests).
  stop_when:   If bun test still fails and the cause is a spec ambiguity rather
               than a code bug, or if fixing requires changing agreed tests
               beyond line 20, stop and ask.
gate:          bun test → exit 0
authorized:    true
turns_used:    1
last_verdict:  done
status:        done
```

The judge's own calls are model calls beside the session, not session messages,
so they are not in the transcript below; the verdict above is what it returned.

## Full transcript

Everything the session recorded — the user, the agent's text and reasoning, and
every tool call and result, in order.


### user

We are building Wordle. I need the scoring function — the part that turns a guess into the green/yellow/gray tiles. The spec is in README.md. Before you dive in, scope it with me: ask me anything that is not nailed down. Then set a goal and build it.


### assistant

> *reasoning:* Let me start by reading the repo standards and the README. The user explicitly asked me to scope first, so I should read the files then ask questions. Let me greet Ada by name.
> 
> Let me read AGENTS.md, opencode.json, .opencode/, and README.md.

Hey Ada. Let me read the repo standards and the spec before I ask you anything.


**tool: `bash`** — completed
```json
{
  "command": "ls -la /tmp/opencode/wordle && echo \"---GIT---\" && git -C /tmp/opencode/wordle log --oneline -5 2>/dev/null; git -C /tmp/opencode/wordle status --short"
}
```
```
total 12
drwxr-xr-x 3 x1nx3r x1nx3r 120 Oct 12 09:55 .
drwxr-xr-x 4 x1nx3r x1nx3r 620 Oct 12 09:56 ..
drwxr-xr-x 7 x1nx3r x1nx3r 260 Oct 12 09:56 .git
-rw-r--r-- 1 x1nx3r x1nx3r  99 Oct 12 09:55 package.json
-rw-r--r-- 1 x1nx3r x1nx3r 617 Oct 12 09:55 README.md
-rw-r--r-- 1 x1nx3r x1nx3r 805 Oct 12 09:55 wordle.test.ts
---GIT---
586d0ae the wordle spec and its public tests

```

**tool: `glob`** — completed
```json
{
  "pattern": "**/{AGENTS.md,opencode.json,opencode.jsonc,README.md}"
}
```
```
/tmp/opencode/wordle/README.md
```

**tool: `glob`** — completed
```json
{
  "pattern": ".opencode/**/*"
}
```
```
No files found
```

### assistant

> *reasoning:* No AGENTS.md, no opencode.json, no .opencode/. Let me read README, package.json, and the test file.

No AGENTS.md, opencode.json, or .opencode/ in the repo. Reading the spec, tests, and package manifest.


**tool: `read`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/README.md"
}
```
```
<path>/tmp/opencode/wordle/README.md</path>
<type>file</type>
<content>
1: # Wordle — the scoring function
2: 
3: Build the scoring function at the heart of a Wordle game.
4: 
5: `score(guess, answer)` returns one tile per letter of the guess, in order:
6: 
7: - `correct` — the letter is in the answer, at this position.
8: - `present` — the letter is in the answer, at a different position.
9: - `absent`  — the letter is not in the answer.
10: 
11: Both `guess` and `answer` are five uppercase letters.
12: 
13: ## Deliverable
14: 
15: - `wordle.ts`, exporting `score(guess: string, answer: string): Tile[]` and the
16:   `Tile` type (`"correct" | "present" | "absent"`).
17: - Tests for the behaviour.
18: 
19: ## Done when
20: 
21: `bun test` passes.

(End of file - total 21 lines)
</content>
```

**tool: `read`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/wordle.test.ts"
}
```
```
<path>/tmp/opencode/wordle/wordle.test.ts</path>
<type>file</type>
<content>
1: import { describe, expect, test } from "bun:test"
2: import { score } from "./wordle"
3: 
4: // The obvious cases. The edge cases are the player's to know.
5: 
6: describe("score", () => {
7:   test("every letter correct", () => {
8:     expect(score("APPLE", "APPLE")).toEqual(["correct", "correct", "correct", "correct", "correct"])
9:   })
10: 
11:   test("every letter absent", () => {
12:     expect(score("STORM", "APPLE")).toEqual(["absent", "absent", "absent", "absent", "absent"])
13:   })
14: 
15:   test("a letter in the answer, elsewhere, is present", () => {
16:     expect(score("LEMON", "APPLE")).toEqual(["present", "present", "absent", "absent", "absent"])
17:   })
18: 
19:   test("position matters: a correct letter is not present", () => {
20:     expect(score("PLANE", "APPLE")).toEqual(["correct", "present", "present", "present", "correct"])
21:   })
22: })

(End of file - total 22 lines)
</content>
```

**tool: `read`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/package.json"
}
```
```
<path>/tmp/opencode/wordle/package.json</path>
<type>file</type>
<content>
1: {
2:   "name": "wordle",
3:   "type": "module",
4:   "private": true,
5:   "scripts": { "test": "bun test" }
6: }

(End of file - total 6 lines)
</content>
```

### assistant

> *reasoning:* Let me analyze the spec and tests.
> 
> `score(guess, answer)` returns one tile per letter.
> 
> Key edge case: duplicate letters. The classic Wordle rule: greens are assigned first, then yellows, and a letter can only be marked present as many times as it appears in the answer (accounting for greens already consuming occurrences).
> 
> Let me check the test "PLANE" vs "APPLE":
> - guess: P L A N E
> - answer: A P P L E
> - index0: P vs A -> not correct. P is in answer at positions 1,2. present.
> - index1: L vs P -> not correct. L in answer at pos 3. present.
> - index2: A vs P -> not correct. A in answer at pos0. present.
> - index3: N vs L -> N not in answer. absent.
> - index4: E vs E -> correct.
> Expected: ["corr
> … [truncated, 10501 chars]


**tool: `grep`** — completed
```json
{
  "pattern": "PLANE|APPLE|LEMON|STORM",
  "path": "/tmp/opencode/wordle",
  "include": "*.ts"
}
```
```
Found 4 matches
/tmp/opencode/wordle/wordle.test.ts:
  Line 8:     expect(score("APPLE", "APPLE")).toEqual(["correct", "correct", "correct", "correct", "correct"])

  Line 12:     expect(score("STORM", "APPLE")).toEqual(["absent", "absent", "absent", "absent", "absent"])

  Line 16:     expect(score("LEMON", "APPLE")).toEqual(["present", "present", "absent", "absent", "absent"])

  Line 20:     expect(score("PLANE", "APPLE")).toEqual(["correct", "present", "present", "present", "correct"])

```

**tool: `bash`** — completed
```json
{
  "command": "which bun && bun --version; ls -la /tmp/opencode/wordle"
}
```
```
/usr/bin/bun
1.4.2
total 12
drwxr-xr-x 3 x1nx3r x1nx3r 120 Oct 12 09:55 .
drwxr-xr-x 4 x1nx3r x1nx3r 620 Oct 12 09:56 ..
drwxr-xr-x 7 x1nx3r x1nx3r 260 Oct 12 09:56 .git
-rw-r--r-- 1 x1nx3r x1nx3r  99 Oct 12 09:55 package.json
-rw-r--r-- 1 x1nx3r x1nx3r 617 Oct 12 09:55 README.md
-rw-r--r-- 1 x1nx3r x1nx3r 805 Oct 12 09:55 wordle.test.ts

```

### assistant

> *reasoning:* Confirmed. Now let me lay out the discrepancy clearly.
> 
> The supplied test at wordle.test.ts:20 expects `score("PLANE", "APPLE")` = `["correct","present","present","present","correct"]`.
> 
> Under score(guess, answer) with Wordle rules, PLANE vs APPLE:
> - guess P L A N E, answer A P P L E
> - [present, present, present, absent, correct]
> 
> The "correct" at index 0 is impossible: P ≠ A. And "present" at index 3 is impossible: N is not in APPLE.
> 
> So the test line is internally inconsistent. It can't pass with any implementation that also satisfies line 16 (LEMON), which pins the argument order.
> 
> Also, "The edge cases are the player's to know" — duplicates not covered. Need to confirm the duplicate rule
> … [truncated, 6940 chars]

Spec and tests read. Two things are not nailed down — one of them is a real contradiction I want to flag before writing code.

**The contradiction.** `wordle.test.ts:20` expects `score("PLANE", "APPLE")` → `["correct","present","present","present","correct"]`. That can't be right under the README's rule with `score(guess, answer)`:
- `guess[0]="P"` vs `answer[0]="A"` → cannot be `correct`.
- `guess[3]="N"` is not in `APPLE` → cannot be `present`.

The spec-correct result is `["present","present","present","absent","correct"]`. And it's provably impossible for line 20 to hold alongside line 16 (`LEMON` → pins the argument order), since `APPLE`'s first letter is `A`, not `P`. So `bun test` cannot pass with any rule that also satisfies the rest of the file.

The other gap: the README says "The edge cases are the player's to know" — duplicate letters are untested, and that's the whole difficulty of Wordle scoring.


**tool: `question`** — completed
```json
{
  "questions": [
    {
      "header": "Duplicate letters",
      "question": "What duplicate-letter rule should score() use? (The untested edge case.)",
      "options": [
        {
          "label": "Standard Wordle two-pass (Recommended)",
          "description": "Greens first; then yellows consume only the remaining unmatched answer letters. A guess letter can be 'present' only if an unconsumed copy remains. E.g. score(\"SPEED\",\"ERASE\") -> present,absent,present,present,absent"
        },
        {
          "label": "Simple per-letter count",
          "description": "For each guess letter, if it occurs anywhere in the answer (ignoring position), mark present. Simpler, but wrong for repeats: marks every duplicate present."
        }
      ]
    },
    {
      "header": "Broken PLANE test",
      "question": "wordle.test.ts:20 contradicts the spec. How do you want it handled?"
… [truncated, 2048 chars]
```
```
User has answered your questions: "What duplicate-letter rule should score() use? (The untested edge case.)"="Standard Wordle two-pass (Recommended)", "wordle.test.ts:20 contradicts the spec. How do you want it handled?"="Fix line 20 to spec-correct expected (Recommended)", "Should score() validate its inputs?"="Assume valid 5 uppercase letters (Recommended)". You can now continue with the user's answers in mind.
```

### assistant

> *reasoning:* Now set the goal and build. The goal tool: commit=true to ask permission to run unattended. The user said "set a goal and build it." I'll set commit=true so it asks permission.
> 
> Goal: Implement score(guess, answer) with standard Wordle two-pass duplicate handling, export Tile type, fix the contradictory test line, add tests for duplicate edge cases; bun test passes.
> 
> Verification: `bun test`.
> 
> Boundaries: wordle.ts (new), wordle.test.ts (fix line 20, add tests). Don't touch package.json/README.
> 
> Constraints: README semantics; pure function, no input validation; don't regress other tests.
> 
> Stop_when: if a test still fails after due diligence / ambiguity about spec.
> 
> Size: small–medium. The ta
> … [truncated, 4334 chars]

Locked. Setting the goal, then building.


**tool: `goal`** — completed
```json
{
  "goal": "Implement the Wordle scoring function in wordle.ts: score(guess, answer) returns a Tile[] of \"correct\" | \"present\" | \"absent\", using the standard two-pass rule (greens first, then yellows consume only remaining unmatched answer letters). Fix the contradictory expectation at wordle.test.ts:20 to the spec-correct value, and add tests covering the duplicate-letter edge cases.",
  "size": "small",
  "size_reason": "One pure function; the spec, argument order, and the one real edge case (duplicates) are now all settled. Only decision left was the test fix, already agreed.",
  "contract": {
    "outcome": "wordle.ts exports score() and the Tile type with correct two-pass scoring; bun test passes cleanly including new duplicate-letter tests.",
    "verification": "bun test",
    "constraints": "Follow README semantics; score() is pure and assumes valid 5 uppercase letters (no
… [truncated, 1308 chars]
```
```
The goal is authorized. The loop will continue until the judge says the goal is met, the budget is spent, or a gate cannot pass.
```

**patch: `?`**
```diff

```

### assistant

> *reasoning:* Now build. Write wordle.ts, edit test file, run bun test.


**tool: `write`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/wordle.ts",
  "content": "export type Tile = \"correct\" | \"present\" | \"absent\"\n\nexport function score(guess: string, answer: string): Tile[] {\n  const tiles: Tile[] = Array(guess.length).fill(\"absent\")\n\n  const remaining = new Map<string, number>()\n  for (let i = 0; i < guess.length; i++) {\n    if (guess[i] === answer[i]) {\n      tiles[i] = \"correct\"\n    } else {\n      remaining.set(answer[i], (remaining.get(answer[i]) ?? 0) + 1)\n    }\n  }\n\n  for (let i = 0; i < guess.length; i++) {\n    if (tiles[i] === \"correct\") continue\n    const count = remaining.get(guess[i]) ?? 0\n    if (count > 0) {\n      tiles[i] = \"present\"\n      remaining.set(guess[i], count - 1)\n    }\n  }\n\n  return tiles\n}\n"
}
```
```
Wrote file successfully.
```

**patch: `?`**
```diff

```

### assistant


**tool: `edit`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/wordle.test.ts",
  "oldString": "    expect(score(\"PLANE\", \"APPLE\")).toEqual([\"correct\", \"present\", \"present\", \"present\", \"correct\"])",
  "newString": "    expect(score(\"PLANE\", \"APPLE\")).toEqual([\"present\", \"present\", \"present\", \"absent\", \"correct\"])"
}
```
```
Edit applied successfully.
```

**patch: `?`**
```diff

```

### assistant

> *reasoning:* Now add duplicate tests. Append a describe block. Edit the file: add after the last test's closing. The file ends:
> 
> ```
> 19:   test("position matters: a correct letter is not present", () => {
> 20:     expect(...)
> 21:   })
> 22: })
> ```
> 
> I'll add a new describe after line 22. Use edit with oldString being the final `})` plus context. Let me match the last test closing and final brace.


**tool: `edit`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/wordle.test.ts",
  "oldString": "  test(\"position matters: a correct letter is not present\", () => {\n    expect(score(\"PLANE\", \"APPLE\")).toEqual([\"present\", \"present\", \"present\", \"absent\", \"correct\"])\n  })\n})",
  "newString": "  test(\"position matters: a correct letter is not present\", () => {\n    expect(score(\"PLANE\", \"APPLE\")).toEqual([\"present\", \"present\", \"present\", \"absent\", \"correct\"])\n  })\n})\n\ndescribe(\"duplicate letters\", () => {\n  test(\"a green consumes one copy of the answer letter\", () => {\n    expect(score(\"PAPER\", \"APPLE\")).toEqual([\"present\", \"present\", \"correct\", \"present\", \"absent\"])\n  })\n\n  test(\"a repeated guess letter is present only as often as the answer holds it\", () => {\n    expect(score(\"SPEED\", \"ERASE\")).toEqual([\"present\", \"absent\", \"present\", \"pres
… [truncated, 1314 chars]
```
```
Edit applied successfully.
```

**patch: `?`**
```diff

```

### assistant

> *reasoning:* Let me verify the GEESE/SIEGE case.
> guess G E E S E; answer S I E G E.
> greens: idx0 G vs S no; idx1 E vs I no; idx2 E vs E correct; idx3 S vs G no; idx4 E vs E correct.
> remaining answer letters: idx0 S, idx1 I, idx3 G → S:1, I:1, G:1.
> pass2: idx0 G → G:1 present, G:0. idx1 E → remaining E:0 → absent! Oops. Expected present.
> 
> So my expected for GEESE/SIEGE is wrong. Let me recompute properly.
> guess G E E S E, answer S I E G E.
> - idx0 G vs S: no. 
> - idx1 E vs I: no.
> - idx2 E vs E: correct.
> - idx3 S vs G: no.
> - idx4 E vs E: correct.
> remaining: S(0), I(1), G(3) → S:1,I:1,G:1.
> pass2: idx0 G → present. idx1 E → no E remaining → absent. idx3 S → present.
> = [present, absent, correct, present, correc
> … [truncated, 3798 chars]

Verifying my GEESE expectation — it's wrong; both E's in the answer are green, so the non-green E must be absent. Fixing that test.


**tool: `edit`** — completed
```json
{
  "filePath": "/tmp/opencode/wordle/wordle.test.ts",
  "newString": "  test(\"greens use up the answer's copies, leaving a later guess absent\", () => {\n    expect(score(\"GEESE\", \"SIEGE\")).toEqual([\"present\", \"absent\", \"correct\", \"present\", \"correct\"])\n  })",
  "oldString": "  test(\"every copy present when the answer holds them all\", () => {\n    expect(score(\"GEESE\", \"SIEGE\")).toEqual([\"present\", \"correct\", \"correct\", \"correct\", \"correct\"])\n  })"
}
```
```
Edit applied successfully.
```

**patch: `?`**
```diff

```

### assistant


**tool: `bash`** — completed
```json
{
  "command": "bun test 2>&1",
  "workdir": "/tmp/opencode/wordle"
}
```
```
bun test v1.4.2 (744846f84)

 8 pass
 0 fail
 8 expect() calls
Ran 8 tests across 1 file. [5.00ms]

```

### assistant

> *reasoning:* All 8 tests pass. Let me also typecheck? There's no tsc configured. Bun test ran fine. The contract verification is `bun test` — passes. Done.
> 
> Let me give a concise summary. Reference file:line.

Done. `bun test` → 8 pass, 0 fail.

- `wordle.ts:3` — `score()` uses two passes: mark greens, then hand out `present` only while an unconsumed copy remains in the answer.
- `wordle.test.ts:20` — corrected to `["present","present","present","absent","correct"]`.
- Added four duplicate-letter tests (`wordle.test.ts:24`) covering green-consumes-a-copy, repeat-limited-to-answer-count, extra-copy-absent, and greens-exhausting-a-letter.
