# Library block definitions (`recipe-core/src/library`)

Handbook: [modules/recipe-core.md](../../../../docs/handbook/modules/recipe-core.md)

Decision 0026, slice S1. A library block is a digital form defined as data: sections of typed fields plus the
signatures the step needs. The field types are the only vendor code. A block made from them is data that QA approves
and versions (storage and approval arrive in S3). The product's own values fill the block's slots when the block is
used in a formulation.

```ts
import { library } from '@ebmr/recipe-core/pure';

library.checkBlockDefinition(def, expr); // problems with the form itself; [] means it may go to QA
library.slotsOf(def);                    // what the formulation must or may fill: LIMIT, EQUIPMENT_CLASS, COUNT, INTERVAL
library.checkBlockUse(def, use, expr);   // problems with the product's values for one use of the block
library.definitionHash(def);             // content hash the formulation pins with code@version
```

## Field types (`model.ts`)

NUMBER, TEXT, YES_NO, CHOICE, DATE_TIME, TIMER, WEIGHING, MATERIAL_LOT, EQUIPMENT, CONTAINER, SAMPLE, TEST_RESULT,
CALC; plus `signatures` (PERFORMED, CHECKED, VERIFIED, QA_APPROVED). A section repeats ONCE, a COUNT of times,
PER_CONTAINER, PER_INTERVAL (IPC rounds) or UNTIL_PASS (the LOD drying loop). A block may carry reference limits (for
example a common compendial value) that are shown to the author (owner decision O-5).

## What is checked

The software checks the form and the limits. It does not judge the process: that is the preparer's and QA's
responsibility (decision 0026 point 3).

| Check | Code | Controls |
|---|---|---|
| Code, version, title, category; at least one field | LIB-CODE, LIB-VERSION, LIB-TITLE, LIB-CATEGORY, LIB-NO-FIELDS | PR-03, PR-05 |
| Every field typed: known type, label, a valid UCUM unit; a weighing in mass, a timer in time | LIB-FIELD-* | PR-03 |
| Every critical field (CPP, IPC) has a limit slot; a test judges at least one statistic | LIB-CRITICAL-NO-LIMIT, LIB-TEST-NO-LIMIT | PR-03, PR-08, PR-29 |
| A calculation checks against the fields declared before it (so no cycles), in its declared unit; it is never optional | LIB-CALC-EXPRESSION, LIB-CALC-REQUIRED | DI-33, INV-25 |
| An UNTIL_PASS repeat waits on a field with limits or an expected answer; with no maximum it is a warning | LIB-REPEAT-UNTIL, LIB-REPEAT-NO-MAX | INV-20 |
| Unique field ids and slot names; choices with two distinct options and one allowed answer | LIB-FIELD-ID, LIB-SLOT-*, LIB-CHOICE-* | PR-03 |
| A PERFORMED signature, each meaning once, each with a role | LIB-SIGNATURE-* | DI-35, ST-33 |
| Reference limits name a limit slot, carry a note, are in order and in a compatible unit | LIB-REFERENCE-* | PR-08, IN-33 |
| A use: required slots filled, no unknown slot, whole-number counts, positive time intervals | LIB-USE-* | PR-03, PR-29 |
| A use's limits: well-formed nested tiers (`limits/checkLimitSpec`), a unit that converts to the field's, a target inside its limits, time points each with limits | LIB-USE-LIMIT-*, LIB-USE-TARGET, LIB-USE-POINTS | PR-08 |
| A limit looser than the reference limit: a warning that a written reason clears | LIB-USE-LOOSER-THAN-REFERENCE | PR-08, IN-33 |
| Inputs from outside the step (formula line, batch size, lot assay, earlier step's value): known kind, unit; a lot assay names a lot or weighing field; a use names the line and the step | LIB-INPUT-*, LIB-USE-BOM-LINE, LIB-USE-STEP-VALUE | DI-33 |
| Conditional fields: shown when an earlier yes/no or choice field has one of its answers; a calculation reads one only under the same condition; a repeat never waits on one | LIB-SHOW-WHEN, LIB-CALC-CONDITIONAL, LIB-REPEAT-UNTIL | DI-33, INV-20 |
| The content hash pinned at formulation approval matches the library version (`definitionHash`) | LIB-USE-HASH | PR-05, DI-10 |

## The generic handler (`block-version.ts`, slice S2)

`libraryBlockVersion(def, expr)` builds the registry block version `LIB-<code>@<version>` of a definition, so the
existing engine runs it with no code of its own:

- The phase configuration is the product's values (a `BlockUse` without `block`, plus the pinned `hash`); the batch
  definition runs `checkBlockUse` on it (errors refuse, warnings need a justification).
- One entry kind per section (the section id); `TIMER_START` and `TIMER_STOP` for timers, whose duration comes from the
  engine's trusted time and is checked against its limit when the timer stops (PR-30).
- A calculated field is never typed (the entry schema refuses it, INV-25). The server computes it and stores it with
  its evaluation record: expression, language version and the inputs it read (owner decision O-9 b; DI-33). External
  inputs are read from the phase's targets (`view.target(id)`); the formulation wires them in S9.
- Each value with a limit is evaluated against the formulation's tiered limit and a breach raises the engine's
  `LIMIT_BREACH` with its tier's consequences (PR-08). A yes/no other than expected raises `LIB_UNEXPECTED_ANSWER`; a
  not-allowed choice `LIB_NOT_ALLOWED_CHOICE`.
- Repeats: ONCE and COUNT sections refuse an extra entry. In an UNTIL_PASS loop, a value that does not pass is a repeat,
  not a breach, and the step cannot be signed until it passes. The last allowed repeat without a pass raises
  `LIB_REPEAT_LIMIT_REACHED`, which holds the following steps until a deviation is linked. A PER_INTERVAL round recorded
  late raises `LIB_IPC_INTERVAL_MISSED`.
- Test results need the planned number of readings, and each statistic is judged against its limit. A per-point result
  needs readings for exactly the formulation's points, each judged against that point's limits. `statistic` computes
  mean, min, max, range and the sample RSD in exact decimals.
- Conditional fields: a hidden field is refused, and a shown required field must be given.
- `nominalEntries` (the simulator model) gives a nominal execution: each section once (or its count), values at the
  target or inside the innermost range. The driver supplies the time.

Smart fields (weighing, lot, equipment, container, sample) record identifiers and quantities. Their checks against the
plant and the stores come in S6, and signature roles are mapped to steps in S4.

Tests: `packages/recipe-core/test/library/library.test.ts`, `block-version.test.ts` (examples in `examples.ts`: friability, fluid bed drying
with an LOD loop, a dissolution profile).
