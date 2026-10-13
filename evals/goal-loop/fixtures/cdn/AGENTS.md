# AGENTS.md

Conventions for this repository.

- Go, standard library first. **No new dependencies** without asking.
- Handlers stay thin: parse, validate, delegate. Storage work goes through the
  `storage.Storage` interface, never through `os` directly.
- `internal/domain`-style rules do not exist here; the rules are the storage and
  retention behaviour, and they belong in `internal/storage`.
- Every rule change needs a test in the same package. `go test ./...`.
- Configuration is read in `internal/config` only. A setting that exists in the
  README and not in `config.go` is a bug in one of the two.
- Run `make smoke` before pushing: it boots the service, uploads a file, fetches
  it back, and checks the counters. Unit tests cannot see a service that is up
  but broken.
- Dates and ages are computed from file metadata or explicit timestamps — never
  from wall-clock inside a request handler.
