# meta

The meta-agent is the **outer** session. It is both the simulated user and the
grader: it drives the inner session, stays in character, then scores the run.

- `../.opencode/agent/meta.md` — the agent: system prompt, tools, model.
- `../.opencode/tool/drive.ts` — its hands: the `drive` tool.
- `personas.md` — the three users.
- `rubric.md` — the scores.

The runner (`../run.ts`) loads a case (`../cases/`), a persona, and the rubric,
starts the server with this directory as the workspace, and opens the meta
session with the brief. The inner session is a real opencode session running
the goal loop against `../fixtures/hris/`, reached over the documented HTTP API
with the `x-opencode-directory` header.

## Running it

```
MANUS_INTEGRATION=1 bun evals/goal-loop/run.ts --case medium --persona senior
```

The models are configurable: `EVAL_META_MODEL` (default
`opencode-go/glm-5.3-flash`) and `EVAL_INNER_MODEL` (default
`opencode-go/deepseek-v4.1-flash`).
