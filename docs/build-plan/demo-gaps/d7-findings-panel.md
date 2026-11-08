# D-7: the findings panel at 1400 px (owner's MGL-SR-BL report, item 12)

The report: at 1400 px the sticky findings panel covers the steps' "⋯" buttons in the designer; only the keyboard works.

## Cause

`.workspace` is a grid of `minmax(0, 1fr)` and a 380 px column holding the sticky `.side` panel. A table wider than the
document column overflows it and runs on into the panel's column, under the panel, which paints over it. Measured at
1400 x 900 on the dc-mini template: the document column is 832 px wide and one of its tables 1122 px, running 290 px
into the panel's column. The bilayer master's procedure table overflowed the same way, so the panel covered its last
column, the "⋯" buttons.

## Change (CSS only; lead-approved 8 November 2026)

`.document` gets `overflow-x: auto`: a table wider than the column scrolls inside the column. The panel stays where it
is. No other screen changes.

## Test

`tools/e2e/specs/designer/designer.spec.ts` (group `rest`), `[PR-03] at 1400 px no document table runs under the findings
panel, and every step's actions button takes a click`, at a 1400 x 900 viewport:
- the template's table that is wider than the column is not hit at a point beside the column;
- every step's actions button takes a real click (Playwright refuses a click another element would receive) and opens
  its menu.

The first form of the test (the buttons only) passed without the change, because the template's procedure table fits.
The table check fails without the change: it was run first without it.
