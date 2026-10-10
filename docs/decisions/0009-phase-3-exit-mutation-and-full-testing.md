# Decision record 0009: Phase 3 exit adds a mutation run and full testing of Phases 1 to 3

- **Date:** 10 October 2026
- **Decided by:** project owner (maglesT), in the Phase 3 session: "after phase 3 mutation testing with opus and full
  testing of phase 1,2,3 have to be there but same thing dont focus much on small issues work on major issues and dont
  keep re testing if things which are important are there ... and also the compliance relieving which i had said".
- **Approved:** by the owner on 10 October 2026, with four changes (recorded in the plan below).
- **Amends:** decision 0008, section 1 (the Phase 3 exit row). Everything else in 0008 stands, including section 2
  (database enforcement for the regulation-required core only; the relaxations beyond it).

## Phase 3 exit

Approved by the owner on 10 October 2026 with four changes to the first draft (items 1, 2, 4 and the fix-test rule in 3).

1. **Mutation testing, run by the top model (Opus):** fully on the Phase 3 code (TypeScript with Stryker, database
   guards with the SQL mutation harness). On Phases 1 and 2, only on code changed since their own exit runs. Surviving
   mutants that show a missing test for a real behaviour are fixed; equivalent mutants are recorded, not argued.
2. **One review pass by Opus:** design and serious defects only.
3. **Fixes:** critical and high findings from the mutation run and the review are fixed, each with its own test that
   fails without the fix. Medium and low go to the backlog. At most 2 fix rounds per finding (0008).
4. **One final run** after the fixes: the whole test suite, the browser (E2E) suite, the trace gate for every due
   control, and GB-T-01 matching its expected outputs exactly. No further re-test loops once this run is green.
5. **Compliance relief stays as in 0008:** full depth only for the regulation-required core.

The Phase 4 exit (0008) is unchanged.
