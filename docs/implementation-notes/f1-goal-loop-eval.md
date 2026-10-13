# F1 — the goal loop, measured

An eval report. Read it with `docs/adr/0006-goal-loop.md`; the harness it
describes is `evals/goal-loop/`.

Round one is 2026-10-12, on `fixtures/hris`. Round two is 2026-10-13, on
`fixtures/cdn`. The first round's raw session transcript is in
`f1-goal-loop-eval-first-run.md`, unchanged.

The scores in a run are one model's opinion of another. **The transcript is the
evidence.** Every claim below quotes a run.

---

## 1. What is under test

The goal loop runs one goal to a verdict:

```
dev  →  gate  →  QA  →  judge
 |                |        |
artifact      record    verdict
```

Nobody signs what they made. The dev makes the artifact and QA signs it. QA
makes the record and the judge signs it. The judge makes the verdict and the
human signs it, at the two ends only — at the commit, and at the handoff.

A unit test can prove that the parser reads `blocked`. It cannot prove that a
judge *recognises* a blocked run, that a reviewer *derives* a probe of its own,
or that a diet *holds* when the author's prose is one file away. That is what
this harness measures.

## 2. The harness

Two servers, two sessions.

- The **meta** session simulates the user and grades the run. It runs on
  `opencode-go/glm-5.3-flash`.
- The **inner** session is the loop under test, in a scratch copy of a fixture.
  It runs on `opencode-go/deepseek-v4.1-flash`.

The meta agent talks to the inner session through the documented HTTP API and
nothing else. `evals/goal-loop/.opencode/tool/drive.ts` is its hands: `start`,
`prompt`, `read`, `answer`, `review`, `stop`.

### Run a case

1. Set `MANUS_INTEGRATION=1`. The run spends real model calls.
2. Run the runner with a case, a fixture, and a persona:

```
bun evals/goal-loop/run.ts --case retention --fixture cdn --persona senior
```

3. Read the scorecard and the cost line in the log.
4. Read the run: `evals/goal-loop/runs/<case>-<persona>/`.

`runs/` holds the workspace the agent left, both databases, and a rendered
`TRANSCRIPT.md`. It is gitignored. If a run must be kept for the record, quote it
into a note — the directory will be overwritten by the next run of the same case.

## 3. The fixtures: a library, then an app

**`hris` is a library.** It has a domain, a schema, a route *classifier* — and no
top. `route()` returns a `Route`, and nothing consumes one. It seeds a dead
transition: `docs/FSD.md` documents `pending ──▶ escalated`, and no code
implements it.

That fixture produced the most expensive lesson in round two. A reviewer applying
the reachability rule reported, correctly, that nothing calls the new function.
The rule has no referent in a repo with no top, so **every** capability is
unreachable, and no implementation can satisfy the criterion. Three records in a
row said the same thing. The judge diagnosed it — *"'no non-test importer' is the
repo's test-only shape rather than proof the transition is inert"* — and the
reviewer re-fired anyway, because the contract asked for it.

**`cdn` is an app with a top.** It has a dispatch point
(`cmd/server/main.go`), its own data (`uploads/`), one storage interface with a
single method, and no external services — `uuid` and `godotenv`, nothing else. It
builds and runs offline.

It seeds two things. Retention is documented in the README and absent from the
Go code. And the fetch path ignores the storage backend: `/files/` reads the
upload directory whatever `STORAGE_BACKEND` says, so an upload to the object
store returns a URL that 404s.

The rule the two fixtures leave: **a fixture needs a top, its own data, and a
gate that runs it.** Without a top, reachability cannot be judged. Without data,
"read the effect, not the narration" has nothing to read. Without a runnable
gate, the check cannot exercise the outcome.

## 4. The runs

| # | fixture × case × persona | outcome | the line that matters |
|---|---|---|---|
| 1 | hris × medium × senior | judge caught **invented semantics**, ruled blocked | *"the agent admits it invented the undefined semantics of `unused`"* |
| 2 | hris × big × hr | reviewer never ran | *"no child sessions — the reviewer never ran"* |
| 3 | hris × big × hr | 1 contradiction, then `done`, gate pass | *"git diff --stat shows src/db/seed.ts unchanged"* |
| 4 | hris × big × hr | 3 contradictions, no convergence | *"The finding does not hold as stated"* |
| 5 | cdn × retention × senior | clean, `done`, gate pass | *"Author's smoke check can actually fail (not hollow)"* |
| 6 | cdn × object-store × senior | clean, `done`, gate pass | *"Confirmed the defect… the URL 404s"* |
| 7 | cdn × retention × senior, seeded note | clean, `done`, gate pass | *"The stale scratchpad claims … — it does not"* |

Run 2 was not a test of the loop. The fixture had no git repository, so the
round had no snapshot, so the loop refused — *"stops rather than pass
unaudited"* — before the gate or the reviewer. The harness graded its own bug.

## 5. What holds

**The aim beats the instruction.** In run 5 the reviewer read the author's scratchpad — a
denied input, and reachable, because it is a file in the worktree — and its
probes stayed adversarial. The diet did not hold because it was forbidden. It
held because that role is pointed at breaking things. The mirror case is the
dev: on run 7 it found a prior session's note claiming the smoke seeded an old
file, checked, and named it a lie — *"The stale scratchpad claims … — it does
not"*.

**The record over the claim.** The runner now reads cost from the databases.
Against that, the grader's own estimates were off by 34× (run 5: `$1.9` claimed,
`$0.0559` recorded) and 16× (run 7: `$1.6` claimed, `$0.0994` recorded).

**The gate is not the outcome.** In run 4, QA found a self-approval bug
(`manages()` tested equality before the cycle guard, so a self-manager row let an
employee approve their own request), an off-by-one, and a boundary violation — on
a suite that was 41 pass, 0 fail. In run 3, the author's 31 tests were green
while a file named in the contract's own boundaries sat untouched.

**Reachability, once it has a referent.** On run 5 the dev wired the sweep into
`main.go`, and QA confirmed it — *"Reachability: every added symbol has a
non-test caller"* — with the grep that shows the caller.

**The prose is withheld from the reviewer, structurally.** Across run 3's passes,
21 probe commands existed in the records and **0** appeared in the dev's
transcript. The judge is never shown a probe's command, so it cannot relay one.

**The refusals work.** No workspace state → *"stops rather than pass unaudited."*
A clean record with no derived probe → abstention, judge never consulted. A
`done` off a contradicted record → refused, whatever the judge says.

**The judge moderates.** Run 4 is the only case we have seen, and it is the one
we wanted: the reviewer asserted that the absence of importers proved the feature
inert, and the judge refused the finding **as stated**, leaving the specific open
question standing. The reviewer sharpened it, and the sharpened version held.

## 6. What broke, and the rule each failure left

**Two criteria that could not be satisfied.** `hris`'s reachability (no top to
call from) and the rubric's `moderates` row (it asked the judge to ratify or
reject a finding on a clean pass, when there was no finding). Both scored runs 0
for not doing a thing that could not happen. **Rule: every criterion names the
situation it scores.** If it cannot be satisfied in the run in front of you, that
is a defect in the criterion.

**A grader that misread its own record.** On run 5 it scored `finds: 1`, saying
nothing probed whether the sweep starts from `main.go` — while probe 12 in the
record is exactly that grep. It also said the sweep cadence was not in the README,
where it is, at `README.md:22`. **Rule: check the claim against the transcript
before you believe the score.** The eval's own doctrine cuts at the eval first.

**A fixture graded as a loop.** Run 2. **Rule: when a run reports a structural
failure, check the harness before the code.**

**The scratchpad's denial was never enforceable.** The ADR said QA did not read
it. In run 5 the reviewer read it. A prose prohibition lost to a structural fact: the file is in the
worktree and the reviewer has `read`. The decision taken: the scratchpad is **not
handed** to QA, and it is **reachable**; the aim is what keeps the review honest.
The filter stays, so prose must be sought, and the seeking is visible.

**The reviewer writes into the artifact to do the replay.** Run 5's reviewer
performed the test-integrity replay properly — it disabled the sweep, watched the
smoke fail, restored the file, and checked `git status` was clean. It is not an
isolated case: run 6 patched the fetch path back to the shortcut to watch the
smoke fail, and run 7 built the base binary to prove the change by contrast. That
is the strongest probe available, and it requires a write. **The rule to decide: forbid
the write and forbid the replay, or give the reviewer a scratch surface to break
and formalise write-and-restore.**

**And the negative result.** The experiment in run 7 was meant to test whether
confident author prose steers the dev. It did not, and the design was at fault:
the seeded file was named `…-earlier-attempt.md`, so the dev classified it as
someone else's note — a claim to check — rather than its own memory. The hazard
the ADR describes needs a note that reads as *this* session's own, which is what
compaction produces. **The lesson for the next case: a trap that one `read`
settles is a dev trap, and it dies before the judge. Only an *ambiguity in the
contract* survives to be adjudicated** — which is what run 4's refusal was.

## 7. Open items

Closed, from the first round's list:

- **Cost is not surfaced.** Closed. The runner reads tokens and dollars from both
  databases and prints them after the scorecard.
- **One case, one persona.** Closed for cases: seven runs, two fixtures, three
  cases. The `intern` and `hr` personas remain unrun.

Answered:

- **`blocked` appears terminal.** It is, by design: the phase machine makes `done`
  and `blocked` terminal. The first round's worry — that a later acceptance goes
  unrecorded — was the thing to correct. A goal that needs one human decision
  dies at that decision unless the human answers through `question` before it.

Still open:

- **A GLM 5.3 flash tool-argument defect.** It folds an argument into `action` as
  `<arg_key>…</arg_key><arg_value>…`. The `drive` tool survives on a `normalize`
  step. Unknown whether the fault is the model or the adapter; the inner model is
  unaffected.
- **A `moderates` case that can be scored.** The row needs a contradiction that
  survives to the judge. Build it from an **ambiguity in the contract**, not from
  a defect.
- **Scratchpad identity.** Name a scratchpad to the session that wrote it, and
  tell the dev that a note it did not write this session is a claim, not its
  memory. Otherwise a fresh session inherits a dead one's confident plan.
- **Nothing here is licensed across model families.** This run ran one inner
  model and one outer model. Renew the licence when either changes.

## 8. What this licenses, and what it does not

**Licensed, for these two models:** the loop's internal honesty. Probes that were
executed and could fail. Effects read from the system of record. A withheld
command. A record that is weighed, not relayed. Refusals that say which rule they
refused under. A dev that does not trust its own prior note, and a reviewer that
does not trust the author's.

**Not licensed:** that the loop is better than a human reviewer — nothing here
measures that. That QA cannot fabricate a finding — the rejection has been seen
once, the fabrication never. That a clean pass is a true pass — the judge has no
tools and can only weigh the record it is given.

## 9. Evidence

- `f1-goal-loop-eval-first-run.md` — round one's raw session transcript.
- `f1-goal-loop-eval-plan.md` — the plan, and round one's failures recorded.
- `f1-goal-loop-fixture.md` — why `cdn` replaced `hris`, and what it seeds.
- `f1-goal-loop-qa.md`, `f1-goal-loop-relay.md` — the two halves of the loop.
- `evals/goal-loop/README.md` — the harness, and how its parts fit.
- `evals/goal-loop/runs/<case>-<persona>/TRANSCRIPT.md` — each run, rendered from
  its databases. Local, and overwritten by the next run of the same case.
