# goal-loop evals

M7. The abstract half of the goal loop — the size rubric, the ask rubric, and
the judge's judgement — is prompt-level and cannot be unit-tested. A unit test
can prove the parser handles `blocked`; it cannot prove the judge *recognises*
a blocked run. This tree measures that.

## Shape

A **meta-agent** — a user simulator *and* a grader — drives a real session
against a real codebase, then scores both halves: the agent's scoping and the
judge's verdicts.

- **Outer** — an opencode session on GLM 5.3 flash, given a persona, a task,
  and a rubric, with a `drive` tool that wraps the inner session's API.
- **Inner** — a real opencode session on DeepSeek v4.1 flash, running the goal
  loop against `fixtures/hris/`. It carries the persona's identity
  (`MANUS_USER_*`), which is what puts the goal loop's stance in front of the
  agent.

Two servers, so the identity reaches the inner agent and not the meta-agent.

The personas decide how much the agent asks versus infers: a senior engineer
gives terse answers, an intern does not know, an HR manager describes the
outcome and not the mechanism.

## Layout

```
meta/            the meta-agent prompt, the personas, and the grading rubric
cases/           the task cases (small / medium / big)
fixtures/hris/   the codebase under test
run.ts           the runner
```

Only `fixtures/hris/` exists today.

## Why it is scored, not asserted

Two stochastic layers — a simulated user and an agent — make any threshold a
flake generator. The runner reports per-case scores **and the transcript**: the
number is the signal, the transcript is the evidence.

## Guard

`MANUS_INTEGRATION=1` and a real model. This is a guarded integration run, not
a CI job.
