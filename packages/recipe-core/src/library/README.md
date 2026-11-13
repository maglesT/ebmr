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

A CONTAINER field (`action` REGISTER or CONSUME) records the identifier the person reads off the container, and nothing
more: it registers and consumes no container and makes no genealogy link (G7, lead's ruling of 8 November 2026, option
1; no migration). The genealogy is recorded by the master's guarded steps: a G-22 output step registers what a phase
produces (the coating suspension, each layer blend) and a G-08 charge step consumes it, with G-08's checks, before the
step that uses it (the coater, the bilayer or trilayer press). So the step screen and the record name the field as a
reference only (`containerFieldLabel`: "Blend container ID (reference; genealogy is recorded at the charge step)").

## What is checked

The software checks the form and the limits. It does not judge the process: that is the preparer's and QA's
responsibility (decision 0026 point 3).

| Check | Code | Controls |
|---|---|---|
| Code, version, title, category; at least one field, unless the block is an INSTRUCTION or SIGN_OFF whose PERFORMED signature is the record (R-flow) | LIB-CODE, LIB-VERSION, LIB-TITLE, LIB-CATEGORY, LIB-NO-FIELDS | PR-03, PR-05 |
| Every field typed: known type, label, a valid UCUM unit; a weighing in mass, a timer in time | LIB-FIELD-* | PR-03 |
| Every critical field (CPP, IPC) has a limit slot; a test judges at least one statistic | LIB-CRITICAL-NO-LIMIT, LIB-TEST-NO-LIMIT | PR-03, PR-08, PR-29 |
| A calculation checks against the fields declared before it (so no cycles), in its declared unit, and reads no field of another optional section; `required: false` on it is ignored with a warning | LIB-CALC-EXPRESSION, LIB-CALC-CONDITIONAL, LIB-CALC-REQUIRED | DI-33, INV-25 |
| An UNTIL_PASS repeat waits on a field with limits or an expected answer; with no maximum it is a warning | LIB-REPEAT-UNTIL, LIB-REPEAT-NO-MAX | INV-20 |
| An optional event section (`required: false`) names its event in `when`, repeats ONCE or PER_CONTAINER and holds no judged value (critical, limited or a test result); at least one required section records a field (21 CFR 211.188(b)) | LIB-SECTION-OPTIONAL | PR-03, PR-08 |
| Unique field ids and slot names; choices with two distinct options and one allowed answer | LIB-FIELD-ID, LIB-SLOT-*, LIB-CHOICE-* | PR-03 |
| A PERFORMED signature, each meaning once, each with a role | LIB-SIGNATURE-* | PR-14, DI-35 |
| Reference limits name a limit slot, carry a note, are in order and in a compatible unit | LIB-REFERENCE-* | PR-08, IN-33 |
| A use: required slots filled, no unknown slot, whole-number counts, positive time intervals | LIB-USE-* | PR-03, PR-29 |
| A use's limits: well-formed nested tiers (`limits/checkLimitSpec`), a unit that converts to the field's, a target inside its limits, time points each with limits | LIB-USE-LIMIT-*, LIB-USE-TARGET, LIB-USE-POINTS | PR-08 |
| A limit looser than the reference limit: a warning that a written reason clears | LIB-USE-LOOSER-THAN-REFERENCE | PR-08, IN-33 |
| Inputs from outside the step (formula line, batch size, lot assay, earlier step's value): known kind, unit; a lot assay names a lot or weighing field; a use names the line and the step | LIB-INPUT-*, LIB-USE-BOM-LINE, LIB-USE-STEP-VALUE | DI-33 |
| Conditional fields: shown when an earlier yes/no or choice field has one of its answers; a calculation reads one only under the same condition; a repeat never waits on one | LIB-SHOW-WHEN, LIB-CALC-CONDITIONAL, LIB-REPEAT-UNTIL | DI-33, INV-20 |
| A media-fill reading (role APS_READING) marks exactly one NUMBER field, in whole units (decimals 0), as the count of contaminated units (`contaminatedCount`); the mark is refused on a block without the role (the database reads the count by it, tablets 1912) | LIB-APS-READING | ST-33 |
| A gas overlay's filter test (role GAS_FILTER_INTEGRITY) marks exactly one critical NUMBER field with a limit slot as its post-use result (`postUseIntegrity`), refused on a block without the role; an applied overlay is marked `gasOverlayApplied` on a choice field (one of its options) or a yes/no field (`true`) | LIB-GAS-FILTER, LIB-GAS-OVERLAY | ST-28 |
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
  inputs: since S10 a formula line is the master's BOM line scaled exactly to the batch's issued size (the BOM is
  written for the first listed size) and the batch size is that size (`scaling.ts`); lot assay and earlier-step inputs
  are read from the phase's targets (`view.target(id)`).
- Each value with a limit is evaluated against the formulation's tiered limit and a breach raises
  `LIB_LIMIT_BREACH` with the consequences the engine gives that tier (PR-08). A yes/no other than expected raises `LIB_UNEXPECTED_ANSWER` (with
  `unexpectedCritical`, as a critical exception: QA only, the step and those after it wait for a deviation, release
  blocked; IN-48); a not-allowed choice `LIB_NOT_ALLOWED_CHOICE`.
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

Smart fields (slice S6):
- **Material lot:** the server reads the lot from the lot register (`lotForEngine`, as a G-07 weighing has it), and the
  browser never sends those facts. The handler applies G-07's own lot checks (`lotProblems`): released, not expired or
  past retest, identity-tested for export markets, and the material of the BOM line the field's `bomLineSlot` names.
- **Equipment:** the server reads the unit from the plant register. It must be of the class the formulation names and
  fit for use (`plant.equipment_fitness` QUALIFIED or CALIBRATION_DUE_SOON).
- **Weighing:** keyed by hand, so the step needs two-person verification (DI-30, PR-14).
- **Database:** `tablets sql/1803` compares the facts with the registers, re-runs the lot check and checks the
  verification (EBMR-TAB-480).
- **Not yet:** booking a unit (start or end of use), container registration and balance readings are not yet part of
  library fields. Process-unit cleanliness stays with the clearance and equipment-status steps.

## Storage and approval (slice S3)

`sql/1800_library_blocks.sql` stores versions of a definition in `recipe.library_block`. The table is insert-only and
audited. The row's code, version, title and category must match the definition, and `content_hash` is
`recipe.json_hash(definition)`, the same canonical hash as `definitionHash`.

- `recipe.draft_library_block(definition)` needs MBR.AUTHOR and only accepts the next version number.
- `recipe.approve_library_block(id, signature)` needs MBR.APPROVE and a LIBRARY_BLOCK_APPROVED signature, never by the
  author. The meaning excludes performers, and the command checks it too.
- `recipe.retire_library_block(id, reason)` needs MBR.APPROVE and retires an approved version with a reason.

The server feature `apps/tablets-server/src/features/library` runs `checkBlockDefinition` before storing. Errors
refuse; warnings are returned. Its routes are in `ns/library.ts`, and the approval is the signable action
`LIBRARY_ACT` (`tablets-server sql/1802` lets QA read and sign a `library_block`). The screen is `/mbr/library`.

## Masters and batches (`integration.ts`, slice S4)

A master carries a snapshot of each library definition its phases name, in `MbrContent.blockDefinitions`. A phase names
it as block `LIB-<code>@<version>`, with the product's values as its configuration (and the pinned `hash`).
`defineOptionsFor(mbr, options)` extends the registry and the catalogue with the master's own snapshots before
`engine.defineBatch`. The batch therefore never depends on the library's current state: approving or retiring a block
later changes no issued batch and no registry fingerprint. A master without library blocks keeps exactly the registry
it had. A snapshot that is not well made, or one carried twice, refuses the batch (`ENG-DEF-LIBRARY-BLOCK`).

- `catalogWithLibrary` makes the validator accept a carried library block (FLOW-BLOCKS). A block with a CHECKED or
  VERIFIED signature is significant, so its phase needs a checker who is not the performer. The block's validator
  `roles` come from a safe list, for example CLEARANCE for a line clearance block, or default from its category.
- A library limit is written in its field's unit (`LIB-USE-LIMIT-UNIT`), so the database compares in one unit.
- A breach raises `LIB_LIMIT_BREACH` with the consequences the engine gives that tier. The engine's `LIMIT_BREACH`
  stays the verdict of an MBR parameter (EBMR-EXE-044).
- Over HTTP, an entry is a `LIBRARY_ENTRY` whose kind is a section id, or `TIMER_START` / `TIMER_STOP`. The server
  refuses one for a step that is not a library block (`EBMR-API-LIBRARY-ENTRY`).

`sql/1810_library_execution.sql` covers the database side:
- Library entries are held to the snapshot's schema: an unknown section or field, or a typed calculated field, is
  refused (`entry_schema_problem` re-created).
- Every number, weighing, calculated value or timer duration outside the formulation's limit must carry its
  `LIB_LIMIT_BREACH` in the same row (EBMR-LIB-020). Owner decision O-9 (b): the figure is the server's, and the
  database does not recompute it.
- The snapshots must be approved library versions with the same content hash, and a master's phases must name only
  carried snapshots. This is checked when a master version is approved (not retired, EBMR-LIB-021) and when a GMP
  batch is issued (a retired version still serves masters approved on it, EBMR-LIB-022).

## Screens (slice S5)

The step view carries a library step's definition and the product's values (`StepScreenView.library`). One generic
renderer draws every library block: `apps/tablets-web/src/features/floor/renderers/Library.tsx`.
- Fields appear by type. Limits are shown beside them, and a breach is flagged while typing (display only).
- Conditional fields appear only when their condition holds. Calculated fields are never offered; they show once saved.
- Timers are started and stopped on the server's clock. Test readings follow the planned count, per time point for a
  profile.
- A section stays open while the definition allows another entry.

`entrySummariesOf` gives each entry its plain sentence (fields with units, calculated values marked, timer durations).
The step screens, the review reads and the whole batch record use it.

## Formulation builder (slice S9)

An author builds a formulation from library blocks in the designer, using `library.libraryPhase` and
`library.withSnapshot`:
- **Add:** "Add a library block after this step" lists the approved versions and inserts one. That single undoable
  change (ADD_LIBRARY_BLOCK) adds the step, pins the version's content hash in it and adds the snapshot to the master;
  another content under the same version is refused.
- **Product values:** the step's values are typed in a form built from the block's slots (`LibraryBlocks.tsx`), with
  the formulation checks shown live:
  - limits as the registered range, with a target and the reason for a limit looser than the reference;
  - equipment classes, counts and intervals;
  - the BOM line, chosen from the master's bill of materials;
  - an earlier step's value;
  - the time points of a profile test.
- **Document view:** the read-only document lists the library blocks carried, with their content hashes.
- **Market rules (O-5):** a limit slot can be bound to a market rule (`marketRules`). The validator then refuses a
  limit looser than the registered value, as it does for an MBR parameter (rules-market). There is no screen control
  for this binding yet.
- **Approval:** the life cycle and its screens, as for any master. The database checks the snapshots
  (EBMR-LIB-021).
- **Evidence (O-2):** the evidence is the validator report, the simulation and the test vectors. A sandbox run is
  optional; one recorded that did not pass keeps the evidence incomplete (recipe-core 1830).

## Ready-made catalogue (`seed/`, slices S7 and S8)

The catalogue has 79 blocks, shipped as data:
- process (25): dispensing, potency-adjusted and liquid dispensing, sifting, milling, mixing, binder, RMG and fluid bed
  granulation, fluid bed and tray drying with an LOD loop, sizing, roller compaction, blending, lubrication, geometric
  dilution, single, bilayer and trilayer compression, de-dusting and metal detection, printing, rework, hold, transfer;
- controls (12): line clearance at start and end, room status, equipment status, balance check, sampling, yield,
  material and printed-packaging reconciliation, stage sign-off, deviation reference, QA verification;
- packaging (10);
- coating (8): suspension, seal, film, enteric, top, sugar phases, polishing, inspection;
- IPC tests (14);
- release tests (11), including dissolution single-point, profile and two-stage. The profile replaces the paused slice
  D (R12).

Each item carries example product values. `test/library/seed.test.ts` proves that every item is well made, that its
example values pass the formulation checks, and that a nominal batch completes it with no exception.

An author loads the catalogue into the library as drafts (`library.loadCatalogue`, the screen's "Load the ready-made
catalogue as drafts"; recipe-core 1820 checks MBR.AUTHOR first). Codes the library already holds are left alone, and
nothing is used until QA approves it.

Gaps the catalogue met (follow-ups):
- the unit catalogue has no electrical units (A, W, kW) and no torque;
- staged dissolution acceptance (S1/S2/S3, L1/L2/L3) and content-uniformity second stages cannot be expressed;
- uniformity of weight is limited in absolute mg rather than as % of the measured mean;
- a choice cannot select a set of limits;
- a container cannot be moved, and equipment cannot be booked, from a library field.

Test results' statistics are judged by the engine; their database re-check comes with the test catalogue (S8).

Tests: `packages/recipe-core/test/library/library.test.ts`, `block-version.test.ts`, `integration.test.ts`;
`apps/tablets-server/test/library/library-batch-gmp.test.ts`;
`apps/tablets-server/test/library/library-routes.test.ts`; `apps/tablets-web/test/library/library-page.test.tsx` (examples in `examples.ts`: friability, fluid bed drying
with an LOD loop, a dissolution profile).
