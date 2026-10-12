# meta

The meta-agent is the **outer** session. It is both the simulated user and the
grader: it drives the inner session, stays in character, then scores the run.

- `../.opencode/agent/meta.md` — the agent: system prompt, tools, model.
- `../.opencode/tool/drive.ts` — its hands: the `drive` tool.
- `personas.md` — the three users.
- `rubric.md` — the scores.

The runner (`../run.ts`) loads a case (`../cases/`), a persona, and the rubric.
It starts **two** servers: the **meta** server in this directory (the `meta`
agent plus the `drive` tool), and the **inner** server in a scratch copy of
the fixture, summoned for the persona — `MANUS_USER_NAME` and friends — so the
goal loop's stance reaches the agent. `drive` reaches the inner over the
documented HTTP API with the `x-opencode-directory` header.

## Running it

```
MANUS_INTEGRATION=1 bun evals/goal-loop/run.ts --case medium --persona senior
```

The models are configurable: `EVAL_META_MODEL` (default
`opencode-go/glm-5.3-flash`) and `EVAL_INNER_MODEL` (default
`opencode-go/deepseek-v4.1-flash`).
