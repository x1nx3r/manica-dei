# Upstream finding: the shell-state-across-virtualization test cannot pass with the current overscan

|                  |                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**       | `packages/app/e2e/performance/timeline-stability/adverse.spec.ts` ("preserves an explicit shell state across virtualization"), against `packages/app/src/pages/session/timeline/message-timeline.tsx`'s virtualizer.  |
| **Found**        | 2026-10-15, on `feat/goal-loop`, running `bun run test:stability` for the F1 benchmark baseline.                                                                                                                      |
| **Pre-existing** | Yes — it failed on the clean tree (`bench-baseline4.log`), before any of the goal-loop branch's work. Both upstream commits involved (`3b811bd01`, `3cf71808c`) are inherited, and the fork has touched neither file. |

## What actually happens

`overscan: 50` (`message-timeline.tsx:445`) was raised by "make session timelines
much faster AND without flicker or scroll jumps" (#32331) — deliberately: it is
the anti-mark/anti-blank buffer that the layout-continuity oracle wants. The
continuity spec arrived two weeks later (#34533) and its second test asks the
opposite thing: after scrolling to the bottom, the shell row must be
**unmounted** (`toHaveCount(0)`), so that disclosure state can be checked
surviving an unmount/remount cycle.

The list is 72 rows (~1 user, ~1 assistant, `history(35, 10)` = 70), so at the
bottom a row near index 2 is ~70 items from the visible range — beyond `overscan:
50`, and beyond `renderOverscan()` (20). It _should_ unmount. It does not: the row
stays in the DOM (`Received: 1`), deterministically — isolated it runs alone and
fails identically. The page snapshot at failure shows the expanded shell row
pinned while history responses 36–44 are visible.

So one of these holds and deserves instrumentation to name:

1. the expanded row is kept **pinned** by the resize path
   (`virtualizer.resizeItem`'s `resizePinnedIndexes`, which renders elements
   intersecting the viewport — the shell's output region is `data-scrollable`, so
   its re-measure may be landing in the pinned set);
2. or the virtualizer's range never reflects the offset
   (`observeElementOffsetReconnectAware` delivers, but `scrollOffset === null`
   handling in the reconnect check and the `initialOffset()` bottom-anchor path
   can interact with the fixture's `scrollTop = scrollHeight` jump);
3. or `timelineCache` (`measurements` restored across sessions) is serving stale
   heights that keep the range wrong.

## Why it is written down and not patched

- The suite is **manual** (`e2e/performance/README.md`: excluded from normal and
  CI Playwright discovery), so nothing is gating on it; the repo's committed
  smoke and regression tests own correctness.
- Instrumenting to name the pin means touching product code (trace logging
  around `resizeItem`/`rangeExtractor`) — the kind of change the app's
  `AGENTS.md` wants measured, not waved through, and the measurement window here
  is the one that just got a baseline.
- The oracle's own design goal (no blank interval while a surface replaces
  another) is _served_ by high overscan; the fix must not be "lower overscan so
  the test passes".

## Candidate routes, in order

1. **Instrument to name the cause** — temporary logging in
   `rangeExtractor`/`resizeItem` during the isolated run of this one test, then
   revert.
2. **Make the fixture robust against pinning** — if the pin is
   intersect-based, a long enough list does not help; if it is overscan-based,
   growing `history(35, 10)` to > 100 rows makes index 2 unreachable by any
   legitimate window and the test becomes satisfiable with a one-line fixture
   change and no product change.
3. **Rewrite the assertion** to address state through the reducer's own store
   rather than DOM absence — weaker evidence, last resort.
