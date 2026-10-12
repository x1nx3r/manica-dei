# meta

The meta-agent is the **outer** session. It is both the simulated user and the
grader: it drives the inner session, stays in character, then scores the run.

- `prompt.md` — the system prompt.
- `personas.md` — the three users.
- `rubric.md` — the scores.

The runner (`../run.ts`) loads a case (`../cases/`), a persona, and the rubric,
and starts the meta-agent with them. The inner session is a real opencode
session running the goal loop against `../fixtures/hris/`.
