# cases

Each case is one task the meta-agent hands the inner session, with the persona
that hands it and the facts that persona holds.

| case | size | persona | trips |
|---|---|---|---|
| `small.md` | small | HR manager | — |
| `medium.md` | medium | senior engineer | the stale cap |
| `big.md` | large | HR manager | the dead escalation |

Any case can run against any persona; the persona changes how much the agent
should ask versus infer. The three personas are in `../meta/personas.md`.

A case is a **brief for the meta-agent**, not a test fixture. The meta-agent
speaks the task in character and answers from **Truth**. It volunteers nothing
the agent has not asked for.
