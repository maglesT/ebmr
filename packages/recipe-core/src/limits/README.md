# Limit model (`recipe-core/src/limits`)

CPP, IPC, calculation and yield limits (PR-08; outline 5.2.4, 6.4). Pure; all rounding goes through
the expression language (`ExpressionService.compareToBound`), which keeps full precision and rounds
only at comparison.

## Model (`model.ts`)

`LimitSpec { unit, ranges: LimitRange[], actionBreach? }`, one `LimitRange` per tier:
REGISTERED and VALIDATED (outer peers), INTERNAL_ACTION inside both, ALERT inside INTERNAL_ACTION.
Each range: optional low/high `LimitBound {value: decimal string as written, inclusive}`, its own
rounding rule (`USP_HALF_UP_AT_LIMIT_DECIMALS` or `PH_EUR_SIG_FIGS`), its source (registration,
validation report, pharmacopoeia, ...) and, for compendial limits, the pharmacopoeia and edition.

## API

- `checkLimitSpec(spec)`: shape and exact nesting (inclusive/exclusive respected).
- `checkNestingAfterRounding(spec, expr)`: no inner tier accepts, after its own rounding, a value an
  outer tier rejects (e.g. an internal limit "95" against a registered "95.0").
- `evaluateLimits(spec, value | undefined, expr) -> LimitEvaluation`: every tier's result with the
  rounded value compared, the tiers breached, the most severe one and what it requires:
  ALERT -> `REGISTER_ITEM`; INTERNAL_ACTION -> `STOP_UNTIL_DEVIATION` (the MBR may let the current step
  continue with the deviation); REGISTERED / VALIDATED -> `REGISTRATION_RELEVANT_DEVIATION`
  (QA-only disposition, stage sign-off blocked until QA classifies it; it must also show on every
  release screen, which comes with Phase 4, see phase-2-open-questions F13.1);
  missing -> `MISSING_VALUE_EXCEPTION`. The evaluation has no flag an operator could clear: the engine
  refuses an operator's or supervisor's disposition (ENG-ROLE, engine/exceptions.test.ts) and the
  database accepts a disposition only from a person with a QA permission. Values captured in
  another unit are converted exactly first. `TIER_REQUIREMENTS` is the tier table as data.
- ALL_APPLY (`all-apply.ts`): `samplingUnion(scheme)`, `samplingShortfalls(scheme, plan)`,
  `evaluateAllApply(scheme, statistics, expr)`: each criterion on its own statistic, unit, rounding
  and sampling; passes only if every criterion passes; each result keeps its governing markets.

## Controls

PR-08 (limit model and tier behaviour; tests `test/limits/*.test.ts`; `readme.test.ts` keeps this
README's names true). The deviation record and its QA disposition belong to the engine and the
execution store, the release-screen flag to the release screen (Phase 4) and the QMS (later
phases); this module states exactly what each breach requires.
