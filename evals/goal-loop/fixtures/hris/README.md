# Meridian HRIS

Leave management for Meridian Group — a ~200-person company across two regions
(ID and SG).

## Getting started

```sh
bun install
bun run seed        # loads the demo dataset into hris.db
bun test
```

## Modules

- `src/domain/` — the leave rules (accrual, carry-over, day counting, approval).
- `src/db/` — the schema and the demo seed.
- `src/api/` — the HTTP surface.

## Notes

Balances accrue **annually**, on 1 January, at the full entitlement for every
employee. Unused leave carries over in full. See `docs/FSD.md` for the
authoritative behaviour.
