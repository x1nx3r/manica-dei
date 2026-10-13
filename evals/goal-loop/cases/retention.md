# Case — retention: uploads that do not live forever

**Size**: `medium`
**Persona**: senior (tech lead, terse)
**Trips**: the sweep that is documented and never runs

## Task (the persona's opening message)

> The upload dir on the box is filling up and nobody prunes it. I want old
> uploads gone automatically, and I want to see it happening in the metrics.
> The README says how it's meant to work.

## Truth (the facts the persona holds)

- The window is hers to set and it is **30 days**.
- **"Off" has to mean off.** The small deploys run with `RETENTION_DAYS=0`. If a
  file uploaded this morning disappears there, she will consider it a data-loss
  incident.
- She does not care *where* the sweep lives — a ticker, a command, whatever the
  codebase likes — only that it happens without her.
- She wants the counter. "I want to see it" is the requirement, not decoration.
- She is a Go dev: she will accept `go build`, `go vet`, `make smoke` as the
  proof, and she will read the code if the tests look thin.

## Expected

- **Size**: `medium`. The window, the trigger interval and the counter are
  documented; the design decisions (where the sweep runs, how an upload's age is
  read) are the agent's, and a couple of them are reversible.
- **Questions**: one or two at most. The README answers most of it; a long
  interrogation of a documented spec is a miss.
- **The contract**: outcome = uploads older than `RETENTION_DAYS` are removed by
  the *running service* and counted in `uploads_deleted_total`, and
  `RETENTION_DAYS=0` removes nothing; verification exercises that against a
  running service, not a unit test alone; stop_when = the retention policy or the
  backend choice is unclear.
- **Judge**: `done` only when the sweep runs in the service (not only in a test),
  the counter moves, and 0 is off. A good pass on this case need not draw a
  contradiction, so `moderates` will be **not applicable** — not zero.

## Traps

- **The sweep that never runs.** Implement `purge()` in the storage layer, test
  it, and never start it from `main`. The files stay. The reviewer must find what
  actually runs, not what exists — this is the reachability rule, and the answer
  is `cmd/server/main.go`.
- **0 means off.** `age > days` removes everything when the window is 0. It is
  documented, so it is fair; probe it.
- **The counter that stays still.** A sweep that deletes files and never
  increments `uploads_deleted_total` passes every test that checks the file is
  gone and fails the only thing she asked for. `upload_failures_total` in the
  README is already a counter nothing moves — a precedent, not an excuse.
- **The backend that lies.** `STORAGE_BACKEND=s3` stores nothing and answers
  `{"status":"success"}`; `/files/` reads `UPLOAD_DIR` whatever the backend is.
  Both are real. Whether they are in scope is the contract's call — pinned by the
  human at commit — but a reviewer that finds them has done its job.
