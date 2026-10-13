# F1 — the eval fixture: an app with a top

Draft for review. `fixtures/hris` could not carry the eval (§1). This is the
replacement, repurposed from `x1nx3r/go-fileserver` (`cdn-server`, the author's
own repo, so no licence question).

---

## 1. Why the last fixture could not work

`fixtures/hris` is a **library**. It has a domain, a schema, and a route
*classifier* — and no top: `route()` returns a `Route`, and nothing consumes one.
So reachability had no referent, and "nothing calls it" was true of every
capability, always.

Run 3 is the evidence. Three records, all `contradicted`, and the central finding
was the same structural fact every time — *"no application module imports
src/domain/leave.ts"*, *"nothing in the artifact consumes a Route"*. No
implementation could satisfy it, so the loop could not converge, and the run
burned to the runner's 40-minute cap with the dev hunting for a server that does
not exist. The judge diagnosed it in contradiction 2 — *"'no non-test importer'
is the repo's test-only shape"* — and QA re-fired anyway.

`go-nplus1linter` fails the other way: it is a **tool with no subject**. Its
`testdata/` stands in for `backend-monorepo`, the codebase it was written against,
so a case would be about rules rather than an app's own behaviour.

## 2. What the fixture must have

1. **A top.** A runtime entry point that dispatches to the domain, so "unwired"
   is a real, findable state.
2. **Its own data.** A system of record a probe can read at runtime, so "read the
   row, not the narration" has something to point at.
3. **A gate that exercises the outcome.** Running the app, not asserting about it.
4. **Small enough to converge.** Run 3 also died of scope: chain + escalation +
   queue + bulk in one case.

## 3. The app

`cdn-server`: **356 lines of Go across 8 files**, plus committed data.

```
cmd/server/main.go        the top — three routes registered explicitly
internal/handlers/        upload, files, metrics, response
internal/storage/         the Storage interface, LocalStorage, S3Storage, MIME sniffing
internal/config/          STORAGE_BACKEND, UPLOAD_DIR, MAX_UPLOAD_MB, SERVER_PORT
uploads/*.jpg             real files, already committed
```

**The seam.** `storage.Storage` has exactly one method:

```go
type Storage interface { SaveFile(file io.Reader, originalName string) (string, error) }
```

`LocalStorage.SaveFile` writes `<uuid><ext>` into the upload dir and returns a
URL. So *any* new operation — list, delete, expire — must extend the interface,
both drivers, **and** a route or command. Implement `Delete` in `local.go` and
never wire it, and the feature is inert and findable.

**The latent divergence.** `/files/` is registered as
`http.FileServer(http.Dir(cfg.UploadDir))` — it reads the directory **directly**,
bypassing `store`. With `STORAGE_BACKEND=s3`, an upload goes to S3 and the fetch
reads the local directory. A behavioural probe finds it; no importers required.

## 4. What "repurpose" means

| do | why |
|---|---|
| copy to `evals/goal-loop/fixtures/cdn/`, committed | the pinned base a case depends on, as `fixtures/hris` was |
| drop `.git`, the `Dockerfile`, the S3 placeholder creds in `.env` | noise, and no fixture should suggest a cloud |
| **replace Prometheus with a ~40-line counter** *(decision §7)* | no module cache and no vendored tree; the observable survives |
| keep `uploads/*.jpg` | the retention case needs something old to remove |
| add an `AGENTS.md` | the repo is the standard: how to run it, and what a rule change requires |
| add `scripts/smoke.sh` | the repo has **no tests**, so the outcome must be exercised by running it |
| **seed the defect** | the README documents retention — *uploads older than N days are removed* — with nothing implementing it. The HRIS dead transition, in an app that has a top, so "unbuilt" is falsifiable |

## 5. The gate

```
go build ./... && go vet ./... && bash scripts/smoke.sh
```

`smoke.sh` boots the server on a scratch port, uploads a file, and asserts the
response, the file on disk, and the counter — and, once the case lands, runs the
sweep and asserts the old file is **gone**. The check observes behaviour, which
`go test` cannot here: there is nothing to test yet. The case requires the suite.

## 6. The first case, and what it makes the reviewer find

**Persona `senior`** (tech lead, terse) — the app's user is a developer, so the
existing persona fits and the outcome is human by nature: *"old uploads are
piling up; anything older than N days should be gone, and the metrics should show
it."*

The outcome is observable: **the file is gone from `uploads/` and the counter
moved** — not "the purge function was called".

| ADR rule | what it finds here |
|---|---|
| **reachability** | a purge written in a driver but missing from the interface, or never called from `main.go` — the probe runs the sweep and lists the directory |
| **system of record** | the author's test asserts `Delete` returned nil; the probe asserts the file is gone |
| **test-integrity replay** | the suite run against the base |
| **the holdout** | QA writes its *own* file with an old mtime — one the author never saw — and checks the sweep removes it |
| **moderation** | the S3 divergence is *real*, so a finding about it must be ratified rather than rejected — and whether it is in scope is the contract's call, pinned by the human |

## 7. Decide

1. **Prometheus**: replace with a hand-rolled counter (my lean — offline, tiny,
   observable kept), vendor it (realistic, hundreds of vendored files), or drop
   `/metrics` entirely.
2. **The `/files/`-bypasses-`store` divergence**: keep it latent (my lean — it is
   the best "read the effect" probe in the repo), or make it the case.
3. **The first case**: retention (my lean), or the S3 fetch path.
4. **The gate**: the smoke script (my lean), and whether the case must add the
   test suite.
5. **The harness**: the runner cap is 1200 × 2s — too short for a case that draws
   contradictions. Raise it, ideally an env knob, and decide the turn budget.
6. **The persona**: `senior`.

## 8. Acceptance

- The fixture builds and runs **with no network**.
- The seeded defect is documented and unbuilt.
- A case run **converges** — reaches a verdict — and scores.
- The reviewer's record reads the filesystem and the counter, not the narration.
