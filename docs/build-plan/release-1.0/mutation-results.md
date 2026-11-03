# Tablets v1.0: focused mutation results (decision 0027 V3)

3 November 2026, on `dyn/v1-plan`, in the session container (PostgreSQL 16, 4 cores). Scope fixed before the first
run: the dynamic library's guard code. The owner's triage (3 November): critical, high and medium survivors are fixed
with tests; low ones are listed here.

## SQL: group `library-blocks` (18 functions: recipe-core 1800, 1810, 1820, 1840; tablets 1803)

| Run | Mutants | Detected | Survived | Score | Target |
|---|---|---|---|---|---|
| Before | 130 | 63 | 67 | 48.5 % | 90 % |
| After | 130 | 130 | 0 | 100.0 % | 90 % |

Cause of the gap: the existing tests called the problem functions with crafted JSON, so the triggers' own refusals
were never reached, and the routes refused bad input before the database guard. New:
`apps/tablets-server/test/mutation/library-blocks.test.ts` (20 tests: library rows written past the writer functions,
each malformed draft, approval and retirement on its own, real `UPDATE`s of `recipe.execution_state` through the limit
and smart-field triggers, the snapshot checks at issue and on the real approval path). No equivalent recorded; no guard
defective.

## TypeScript: Stryker on the changed ranges

Ranges: `packages/recipe-core/src/library/block-version.ts` 238-263 and 278-511 (statistics, the run-time judgement),
`check-use.ts`, `check-definition.ts` 360-382, `apps/tablets-server/src/features/execution/issue-expectations.ts`,
`apps/tablets-server/src/features/designer/from-formula.ts` 78-126. Scores on logic mutants (message text, control-id
lists and object literals left out as low):

| File | Before | After |
|---|---|---|
| block-version.ts | 69.2 % | 88.5 % |
| check-use.ts | 74.1 % | 98.0 % |
| issue-expectations.ts | 65.7 % | 92.9 % |
| check-definition.ts | 73.8 % | 91.8 % |
| from-formula.ts | 87.2 % | 87.2 % |
| **All** | **71.0 %** (766 of 1,079) | **91.8 %** (990 of 1,079) |

Including message text: 61.2 % before, 79.3 % after. New: `packages/recipe-core/test/library/limits-kill.test.ts`
(the handler driven through a fake view: every limit, tier, loop exit, profile, IPC interval, timer and smart-field
path), assertions added to the existing tests of `library.test.ts` (twin-family rule) plus one test, and one test in
`issue-expectations.test.ts`.

### The 89 remaining survivors (all low)

- **Unreachable:** `passes()` is only called for UNTIL_PASS sections; a timer stop of an unknown or unstarted timer
  (the entry schema and the start rule refuse it first); a non-DECIMAL calculation (the evaluator types it DECIMAL);
  configs `checkConfig` already refuses (optional chaining on `bomLines`, `equipmentClasses`, `counts`, `intervals`,
  `points`); a hidden field's value.
- **Equivalent:** `x !== undefined` → `true` on slot lookups (a missing key yields `undefined`, and the comparison is
  false either way); kind and type checks whose other branch has no field or slot; a regrouped `||` that reads
  `limits['undefined']`; `Dec.isValid` already refuses what a dropped `typeof` would let through; an array walked as an
  object in the same order; input ids always from `mbr.inputs`.
- **Message wording only:** six mutants that change a problem's text but not its code or outcome.
- **from-formula.ts (5):** error paths where one refusal becomes another, a parse of content the code built itself.

Noted, not a defect: a batch size smaller than one unit mass gives an expected tablet count of 0 (pinned by a test;
no real master has it).
