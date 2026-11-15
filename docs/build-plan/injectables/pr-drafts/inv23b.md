## What changed

On every market, a master with a filling step and no terminal-sterilisation step is an aseptic fill. Such a master must have a step that monitors the environment during the operation and a step after the fill that enters the counts. The binding clause is 21 CFR 211.42(c)(10)(iv), the monitoring system of an aseptic processing area. This follows the lead rulings of 14 November 2026.

A terminally sterilised master is not refused, because the clause binds aseptic processing only. Schedule M 4.8's facility-level monitoring is the room logbook the owner deferred.

- **Roles:** FILLING, TERMINAL_STERILISATION, EM_IN_OPERATION and EM_COUNTS, in `library/model.ts` and `flow/blocks.ts`.
  - The catalogue blocks get them as v1 edits in place, approved by the lead: INJ-FILL, INJ-TERMINAL-STERILISE, INJ-EM and INJ-EM-COUNTS.
  - Each block keeps the role it had. A definition without roles defaults to PARAMETER_RECORD (`library/integration.ts`), so INJ-FILL becomes `['PARAMETER_RECORD', 'FILLING']`.
  - These edits are listed in the fresh-install residual in PROGRESS.md.
- **Validator rule INJ-ASEPTIC-EM** (`validator/rules-content.ts`): it reads roles, never block codes, so a firm's own blocks count. The counts must come after the fill on every path.
- **Database, editions/injectables/sql 3080:**
  - `injectables.aseptic_em_problem` checks the master.
  - A BEFORE INSERT trigger on `platform.state_history`, fired by mbr_version APPROVE, refuses QA's approval with **EBMR-RCP-439**. It is modelled on recipe-core 1871.
  - A master with no FILLING block is never examined. A procedure the database cannot read is refused, the strict side.
  - The database asks that the counts be reachable after the fill (recipe.flow_reaches). The validator asks for every path.

**Existing aseptic test masters given an INJ-EM step** (lead: they are aseptic fills, so the rule applies to them; INJ-EM-COUNTS alone does not count):
- `aseptic-gate`, `aps-failure` and `unit-account-gate`.
- **GB-I-01, the owner's golden batch, rebaselined.** It had INJ-EM-COUNTS but no INJ-EM, a real gap.
  - INJ-EM sits right after INJ-FILL in the filling stage, because monitoring during the operation is recorded alongside the fill (lead ruling).
  - The `expected.json` diff is only `signatures` 11 → 13 and the batch's `normalisedTrueCopySha256`. The packaging order's hash is unchanged.
  - The scenario receives the media lot on the golden clock. The README lists INJ-EM.

## Controls and invariants

**INV-23 (b).**
- **Validator** (`packages/recipe-core/test/validator/aseptic-em.test.ts`): 5 `[INV-23]` tests. The two refusal tests fail without the rule and pass with it.
- **Database** (`apps/tablets-server/test/injectables/aseptic-em-approval.test.ts`): 3 `[INV-23]` tests.
  - The bypass: approval with passing stub validator evidence is refused when the master has no EM step, and when the counts come before the fill.
  - An aseptic master with EM and counts is approved.
  - A terminally sterilised master is approved, with the catalogue block or with a firm's own block of the role.
  - Fail-first: the refusal test fails without 3080.
- **SQL mutation:** new group `inj-aseptic-em`, also added to mutation.yml. Score **100 % (11/11 detected)**. The first run scored 85.7 %. Survivor #6 sat in the coarse FILLING pre-filter, whose redundant `jsonb_typeof` test was removed (the loop reads roles only from an array). Survivor #15 (`p_inside` false → true in `recipe.flow_reaches`) is recorded as equivalent in `tools/sql-mutation/equivalent.json`: the anchor is always a phase, which has no children, so no path names it.

## Risk and validation impact

- Risk class: medium (master approval)
- Touches the compliance kernel, site services, `compliance/` or database migrations: yes (editions/injectables/sql 3080)
- Validation impact: regenerate trace matrix. The golden batch GB-I-01 is rebaselined (see above).

## Checks

- [ ] `pnpm run ci` passes locally. Not the full run: typecheck, lint on the changed files, the recipe-core validator and library tests, the injectables server tests (7 files, 36 tests) and GB-I-01 (9/9, twice, once with EBMR_GOLDEN_LATER_DAYS=3) ran and pass.
- [x] New or changed behaviour has tests tagged with the control IDs it proves
- [x] No `Date.now()` or JavaScript `number` for GMP values in domain code

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01PybpFuJqP4hQevvyU4YWWS
