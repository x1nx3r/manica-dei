# AGENTS.md

Conventions for this repository.

- Bun + TypeScript. Tests with `bun:test`; run `bun test`.
- Pure domain logic in `src/domain/`, no I/O. I/O lives in `src/db/` and `src/api/`.
- Dates are ISO `YYYY-MM-DD` strings. Do not use `Date` in the domain.
- Days and money are `number`, rounded to 2 places with `round2`.
- Every rule change needs a test in `test/`.
