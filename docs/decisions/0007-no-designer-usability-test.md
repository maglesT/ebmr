# Decision record 0007: no designer usability test with QA and production authors

- **Date:** 3 October 2026
- **Decided by:** project owner (maglesT): "qa test is not needed".
- **Context:** the approved outline (v0.2) made a usability test a Phase 2 exit criterion: three QA and production
  authors build the GB-T-01 master record in the designer (outline section 11, Phase 2 exit, and the "Usability" row of
  section 9). It is the only Phase 2 exit criterion that needs people outside this build.

## Decision

The designer usability test with three authors is removed. Phase 2 exits on its tested criteria: INV-01, 02, 04, 17-20,
25, 34 (generic part), DI-04, DI-05, DI-33, DI-34, PR-01 to PR-08 and IN-02, with the exit review's fixes, the SQL
mutation run on the Phase 2 database guards and the trace gate at phase 2.

## What changes

| Item | Before | Now |
|---|---|---|
| Phase 2 exit (outline section 11) | "...tests pass; designer usability test with 3 authors passed" | The tests pass; no usability test |
| Outline section 9, "Usability" row | Designer build of GB-T-01 by 3 authors (Phase 2 exit) | That part is removed |

## What does not change

- The designer's behaviour stays covered by its automated tests: the screen tests and the end-to-end designer path
  (author a master from the template, find and fix, justify, save, simulate, send to the sandbox).
- A site that adopts the system still validates it with its own users, through its user acceptance and performance
  qualification. That is the site's validation work, not this build's.
- The rest of the outline's "Usability" row is not part of this decision: the signature budget and task times per
  golden batch, and the gowned shop-floor tests with pilot customers in later phases. Those stay as planned unless the
  owner removes them too.
