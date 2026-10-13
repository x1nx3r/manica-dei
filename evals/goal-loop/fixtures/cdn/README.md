# cdn-server

A small file CDN: upload a file, get a URL, serve it back. Storage sits behind an
interface so the same service can run against the local disk or an object store.

```
go run ./cmd/server
```

## Configuration

Environment variables, or a `.env` beside the binary.

| variable | default | meaning |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` or `object` |
| `UPLOAD_DIR` | `./uploads` | where the local backend writes |
| `OBJECT_DIR` | `./objects` | where the object backend writes |
| `MAX_UPLOAD_MB` | `10` | upload size ceiling |
| `SERVER_PORT` | `8080` | listen port |
| `RETENTION_DAYS` | `30` | how old an upload must be before retention removes it. **`0` disables retention — nothing is ever removed.** |
| `SWEEP_INTERVAL_MINUTES` | `60` | how often the retention sweep runs |

`STORAGE_BACKEND=object` selects the object store, which writes to `OBJECT_DIR`.
It stands in for a remote store — the same interface, the same returned URL, no
network and no client library — so a deployment can be driven the same way
whether uploads land on the box or somewhere else.

## Endpoints

| route | what it does |
|---|---|
| `POST /upload` | multipart upload (`file`); returns the public URL |
| `GET /files/<name>` | serves a stored file, immutable |
| `GET /metrics` | counters, exposition format |

## Retention

Uploads do not live forever. A sweep runs every `SWEEP_INTERVAL_MINUTES`, removes
every file in the store older than `RETENTION_DAYS`, and counts what it removed as
`uploads_deleted_total`. Setting `RETENTION_DAYS=0` turns the sweep off.

Retention is configured per deployment; the window is a policy decision, not a
code decision, which is why it lives here rather than in the handlers.

## Metrics

```
http_requests_total{handler,method,code}
upload_mime_total{mime}
upload_bytes_total
upload_failures_total{reason}
uploads_deleted_total
```

Every `/metrics` name is meant to move. A counter that stays at zero is an
answer too.

## Conventions

See `AGENTS.md`. Run `make smoke` before pushing.
