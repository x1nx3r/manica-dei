# F1 · A release publishes `release.json`

Implements: manica-dei issue #20
Read with: manus-dei `docs/adr/019-release-delivery.md` (v1)
Shipped: v0.4.5 — PR #21 (`87df0586c`), `chore(release): 0.4.5` (`5be5505d5`)

## Why

ADR-019 splits releases by what they change. `agent-only` means the server
binary and its embedded UI; a supervisor may replace the binary inside a
running container. `environment-change` means the image carries the change;
the container must be rebuilt and the session re-created. **A delivery path that
guesses half-upgrades a container**, so every release states which it is.

The consumer needs a trust anchor beside the artifacts: deusd will not copy a
binary into a container that it did not hash-check against the release.

## The manifest

```json
{
  "version": "0.4.5",
  "kind": "agent-only",
  "tarball": "manica-dei-linux-x64.tar.gz",
  "sha256": "16f155dcfce79cc160c4d6eb5ec8bf12f7a3425fab145edbae418d14e63ef593"
}
```

| field | meaning |
| --- | --- |
| `version` | bare version, without the tag's `v` |
| `kind` | `agent-only` or `environment-change` |
| `tarball` | the asset the checksum covers |
| `sha256` | checksum of the uploaded tarball |

A consumer verifies the checksum before it installs, and refuses a manifest
with no `kind` rather than guess.

## Producer steps

`.github/workflows/release.yml`, in order:

1. **Resolve the release kind** — reads `.github/release.json` from the tagged
   tree and fails on a missing or unknown value. Runs before the build, so a
   bad declaration costs seconds.
2. **Write the release manifest** — after packaging, takes the sha256 of the
   exact tarball that will be uploaded and writes `release.json`.
3. **Publish release** — uploads the tarball, the web UI zip, and the manifest;
   the generated notes carry a one-line field description and point at
   `docs/releases.md`.
4. **Verify the published manifest** — downloads the release's own
   `release.json` and tarball and checks `version`, `kind`, `tarball`, and
   `sha256` against the published bytes.

`.github/release.json` is the declaration:

```json
{ "kind": "agent-only" }
```

`docs/releases.md` is the durable description for the daemon side.

## Decisions

- **The kind is a file in the tagged commit, not an inference from the diff,
  and not text parsed out of the tag.** It is a human statement, reviewed with
  the release commit. `agent-only` is the ordinary case; flipping it to
  `environment-change` is a deliberate act.
- **The checksum is taken from the uploaded bytes.** No rebuild, no
  re-compression: the manifest and the asset are the same file.
- **Verification runs against the published release.** A local check proves the
  manifest is well-formed; only downloading it proves the release carries the
  pair a consumer will see.
- **Producer failure is loud.** The workflow does not default a missing kind;
  it exits. That mirrors the consumer's refusal.
- **The declaration is read at the tag.** Tag pushes run the workflow file
  frozen at the tag, so the first release that could publish a manifest is the
  first tag cut after this change. It was `v0.4.5`.

## Evidence

Release `v0.4.5`, run `39621499573`, green through **Resolve the release kind**,
**Write the release manifest**, **Publish release**, and **Verify the published
manifest**.

Downloaded after the run:

```
manica-dei-linux-x64.tar.gz   61,307,701
manica-dei-web-ui.zip         21,250,312
release.json                        173

sha256(manica-dei-linux-x64.tar.gz) = 16f155dc…ef593
release.json .sha256               = 16f155dc…ef593
```

## The CI flake that blocked the first merge attempt

The PR's first CI run (`39613994963`) failed the `opencode — test suite` job on
two subprocess tests:

```
(fail) … unknown stream finish preserves partial output and continues [30326.95ms]
(fail) … --format json records an unknown stream finish and continuation [30326.42ms]
Expected: 0
Received: -1
```

`-1` is the harness's timeout sentinel (`packages/opencode/test/lib/cli-process.ts:235`,
`exitCode: err.exitCode ?? -1` after `appProc.run(…, Duration.millis(timeoutMs))`).
Both tests pass `timeoutMs: 30_000` while their bun budget is `60_000`. The
subprocess was killed at the harness's wall-clock bound; the output assertion
never ran.

The same tree had passed all jobs in the run 50 minutes earlier
(`39606802954`), and the branch carried only `.github/release.json`, the
workflow, and `docs/releases.md`. A rerun of the failed job was green, and the post-merge CI
run (`39621480450`) passed the opencode suite in 7m53s.

This is the class `963159ff5` already treated once ("ci: serialize jobs and
widen the run-process prompt bound"): wall-clock bounds that lose to a loaded
runner. That commit widened the *unknown model* test; these two kept 30 s.

**Follow-up, not shipped:** raise those two `timeoutMs` to ~50 s, under the
60 s test budget. It does not weaken the assertion — a true continuation hang
still fails, just later.

## Open

- The consumer is manus-dei (deusd). This repo only produces the manifest.
- `v0.4.4` has no manifest. Decision: no backfill; the manus side bumps to
  0.4.4 on its own, and `v0.4.5` is the first manifest-bearing release.
- Activation is not part of this repo. As of this writing the live `udinus`
  container has 0.4.5 on disk but still runs the deleted 0.4.4 inode — see
  `f1-live-run-udinus.md`. The manifest was publishable; the restart leg is
  the supervisor's.
