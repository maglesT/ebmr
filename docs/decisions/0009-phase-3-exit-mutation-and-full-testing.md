# Decision record 0009: Phase 3 exit adds a mutation run and full testing of Phases 1 to 3

- **Date:** 10 October 2026
- **Decided by:** project owner (maglesT), in the Phase 3 session: "after phase 3 mutation testing with opus and full
  testing of phase 1,2,3 have to be there but same thing dont focus much on small issues work on major issues and dont
  keep re testing if things which are important are there ... and also the compliance relieving which i had said".
- **Amends:** decision 0008, section 1 (the Phase 3 exit row). Everything else in 0008 stands, including section 2
  (database enforcement for the regulation-required core only; the relaxations beyond it).

## Phase 3 exit

1. **Mutation testing, run by the top model:** Stryker on the TypeScript guard, limit, rounding, signing, access and
   state code, and the SQL mutation harness on the database guards, across Phases 1 to 3. Surviving mutants that show
   a missing test for a real behaviour are fixed; equivalent mutants are recorded, not argued.
2. **Full testing of Phases 1, 2 and 3:** the whole test suite, the browser (E2E) suite, the trace gate for every due
   control, and GB-T-01 matching its expected outputs exactly.
3. **Focus on major issues:** critical and high findings are fixed; medium and low go to the backlog. At most 2 fix
   rounds per finding (0008).
4. **No re-testing loops:** once the major defects are fixed and the important checks pass, the exit is done; no
   further rounds to re-confirm.
5. **Compliance relief stays as in 0008:** full depth only for the regulation-required core.

The Phase 4 exit (0008) is unchanged.
