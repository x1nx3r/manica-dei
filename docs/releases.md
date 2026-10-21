# Releases

A release is a tag push: `v*`. `.github/workflows/release.yml` builds the
linux-x64 server binary with the web UI embedded, smoke-tests it, and
publishes three assets:

| asset | contents |
| --- | --- |
| `manica-dei-linux-x64.tar.gz` | the server binary, UI embedded |
| `manica-dei-web-ui.zip` | the raw web bundle |
| `release.json` | the manifest that describes the tarball |

## `release.json`

```json
{
  "version": "0.4.5",
  "kind": "agent-only",
  "tarball": "manica-dei-linux-x64.tar.gz",
  "sha256": "…"
}
```

- `version` — the bare version, without the tag's `v`.
- `kind` — `agent-only` or `environment-change` (manus-dei ADR-019).
- `tarball` — the asset the checksum covers.
- `sha256` — the checksum of that tarball, taken from the uploaded bytes.

`kind: agent-only` means the server binary and its embedded UI are the only
changes; a supervisor may replace the binary in a running container.
`kind: environment-change` means the image carries the change (Chromium,
Xvnc, agent-browser, toolchains, the entrypoint); the container must be
rebuilt and the session re-created.

A consumer verifies `sha256` before it installs anything, and refuses a
manifest with no `kind`. It must not guess the delivery path.

## Declaring the kind

`.github/release.json` in the tagged commit holds the declaration:

```json
{ "kind": "agent-only" }
```

Set it in the release commit. The workflow reads it, rejects any value that
is not one of the two kinds, and writes the release manifest with it. It is
a human statement, not an inference from the diff.

A tag push reads the file from the tagged commit. A manual `workflow_dispatch`
re-runs a release from `main`, so it reads the kind from `main`.

## Verification

After publishing, the workflow downloads `release.json` and the tarball from
the release and checks `version`, `kind`, `tarball`, and `sha256` against
the published bytes. A release that fails this check is not a release.
