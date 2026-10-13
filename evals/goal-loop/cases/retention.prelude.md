# goal

Retention for cdn-server — prune uploads older than `RETENTION_DAYS` (default 30;
`0` disables) and count them in `uploads_deleted_total`.

# size

medium. The window and the counter are documented; the sweep's home and how an
age is read are mine to choose.

# assumptions

- Age is the file's mtime. `SaveFile` sets it, so a fresh upload cannot be pruned.
- `RETENTION_DAYS=0` disables: return before the sweep and remove nothing.
- The sweep lives in `internal/storage`, because filesystem work goes through
  `storage.Storage` and nowhere else.
- Per-request decisions stay per-request. No batch, no config schema.

# decisions

- `RunRetention` sweeps once at startup and then on the ticker.
- Declare `uploads_deleted_total` in `main.go` so `/metrics` shows it at zero
  before the first prune. A counter that stays at zero is an answer too.
- The smoke already seeds an old file, so the check can fail; disabling the sweep
  turns it red.

# open

Remaining risk is cosmetic: the sweep logs nothing, so an operator cannot see a
prune after the fact. Out of scope for this change — note it and move on.
