# D-7: the findings panel at 1400 px (owner's MGL-SR-BL report, item 12)

The report: at 1400 px the sticky findings panel covers the steps' "⋯" buttons in the designer; only the keyboard works.

## Cause

`.workspace` is a grid of `minmax(0, 1fr)` and a 380 px column holding the sticky `.side` panel. The procedure table is
wider than the document column at that width and overflows it, so its last column (the "⋯" buttons) runs under the
panel, which paints over it.

## Change (CSS only; lead-approved 8 November 2026)

`.document` gets `overflow-x: auto`: a procedure wider than its column scrolls inside the column. The panel stays where
it is. No other screen changes.

## Test

`tools/e2e/specs/designer/designer.spec.ts` (group `rest`), `[PR-03] at 1400 px every step's actions button is reachable
by the mouse, never under the findings panel`: at a 1400 x 900 viewport, every step's actions button takes a real click
(Playwright refuses a click another element would receive) and opens its menu. It was run first without the change, to
see it fail.
