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
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `UPLOAD_DIR` | `./uploads` | where the local backend writes |
| `MAX_UPLOAD_MB` | `10` | upload size ceiling |
| `SERVER_PORT` | `8080` | listen port |
| `RETENTION_DAYS` | `30` | how old an upload must be before retention removes it. **`0` disables retention — nothing is ever removed.** |
| `SWEEP_INTERVAL_MINUTES` | `60` | how often the retention sweep runs |

S3 is selected with `STORAGE_BACKEND=s3`; the service reads
`S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`.

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
