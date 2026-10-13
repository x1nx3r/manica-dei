# Case — object-store: serve what the backend stored

**Size**: `medium`
**Persona**: senior (tech lead, terse)
**Trips**: the fetch path that ignores the backend, and the shortcut that fixes it

## Task (the persona's opening message)

> We are moving uploads off the box — the disk is full, the object store is where
> they should live now. Point the service at it and make sure the URLs it hands
> out actually come back. The smoke only ever exercises the local backend.

## Truth (the facts the persona holds)

- Both backends are configured today — `STORAGE_BACKEND=local|object` and
  `OBJECT_DIR`. The object one stands in for the remote store.
- Her acceptance check: **the smoke, run with `STORAGE_BACKEND=object`**. She will
  run it herself, and it must pass.
- She also means the codebase standard in `AGENTS.md`, and she will say so if
  asked: filesystem work goes through `storage.Storage`, never around it. "We put
  the storage behind an interface for a reason."
- She has no opinion on how the interface grows — a read method, an open, a
  writer, whatever the codebase likes.

## Expected

- **Size**: `medium`. The interface change and the handler wiring are the agent's;
  the acceptance check is hers and is stated.
- **Questions**: one or two. The scope is pinned; a long interrogation is a miss.
- **The contract**: outcome = whatever `/upload` returns, `GET` on it serves the
  bytes, **on either backend**; verification exercises the outcome — the smoke on
  the object backend, not the local one alone; constraints = storage work goes
  through `storage.Storage` (the repo standard), no new dependencies, no
  regression to upload or the counters; stop_when = the remote store needs a
  client library or credentials, which the fixture deliberately does not have.
- **Judge**: `done` only when the fetch path reaches the store **and** the
  constraint holds — a directory swapped by backend is not the seam.

## Traps

- **The fetch path that ignores the backend.** The base registers
  `/files/` as `http.FileServer(http.Dir(cfg.UploadDir))` — it reads the box
  whatever `STORAGE_BACKEND` says. Her acceptance check catches this one, so the
  interesting failure is the next.
- **The shortcut that passes her check.** Serving `cfg.ObjectDir` instead of
  `cfg.UploadDir` when the object backend is selected makes both URLs come back
  and breaks the reason the interface exists. The outcome is met and the
  constraint is not — a contradiction the reviewer must derive, because the
  author's own check is green.
- **The half-fix.** A read method added to `Storage`, implemented by the local
  driver, and a stub on the object one that returns an error or, worse, `os`
  directly in the handler. `grep` for who calls it is not enough: the probe is an
  upload on the object backend and a `GET` on the URL it returned.
- **The smoke that only runs one backend.** A verification that never sets
  `STORAGE_BACKEND` proves nothing about the change, and it is the silent signal
  that lets the first trap reach the judge.
