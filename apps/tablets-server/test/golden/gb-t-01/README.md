# GB-T-01 worksheet (Phase 3 slice 6c; D-S6-5, D-S6-6, D-S6-7)

GB-T-01 is the Tablets golden batch of outline 9.1: an **invented** formula (no real or patented product; decision 0006
part 3) shaped like the user's sample BMR (`docs/design/sample-bmr-analysis.md`). Every quantity and yield below was
computed by hand before any run, with exact fractions (`worksheet.py`, independent of the TypeScript and SQL code), and is
copied into `expected.json`. Only the SHA-256 of the normalised true copy is taken from the first reviewed run.

## Formula (per tablet; 2,00,000 tablets; batch size BS-200K)

| Material | Code | Role | mg per tablet | Batch (kg) |
|---|---|---|---|---|
| Exemplazine sodium (invented API; MW form 322.33, base 300.35) | MAT-EXZ-NA | active, stated as base (salt to base) | 250 (base) | 50.000 base |
| Microcrystalline cellulose PH 101 | MAT-MCC-101 | compensating excipient (range 6.000 to 10.000) | 40 | 8.000 standard |
| Lactose monohydrate | MAT-LAC-MH | diluent | 70 | 14.000 |
| Povidone K30 | MAT-PVP-K30 | binder (in solution) | 12 | 2.400 |
| Purified water, isopropyl alcohol | MAT-WATER, MAT-IPA | binder solvents, lost in processing | - | 9.600, 2.400 (+ up to 0.480 IPA on the extra-IPA branch) |
| Croscarmellose sodium | MAT-CCS | disintegrant, extragranular | 12 | 2.400 |
| Colloidal silicon dioxide | MAT-SIO2 | glidant, extragranular | 2 | 0.400 |
| Magnesium stearate | MAT-MGST | lubricant, extragranular | 4 | 0.800 |
| Film-coating system, white | MAT-FCS-W | coating, 3.0 % weight gain | - | 2.428 theoretical solids |

## Dispensing (TB-01, C-01 to C-04)

- Salt factor f = 322.33 / 300.35 = 1.0731813... (shown 1.073181).
- API lot GBT-API-001: assay 99.20 % on the anhydrous basis, water 0.80 %: as-is assay = 99.20 x (100 - 0.80) / 100 = 98.4064 %.
- Standard quantity of the form: 50.000 x f = 53.659064 kg (shown).
- Adjusted quantity: 50.000 x f x 100 / 98.4064 = 54.528023 kg; target rounded UP to the 0.001 kg readability: **54.529 kg**.
- Compensating MCC: 8.000 - (54.528023... - 53.659064...) = 7.131041 kg; target to the nearest 0.001 kg: **7.131 kg**.
- Adjustment 1.619407 % (inside the MBR's 5 % cap).

## Stages (scripted entries and their yields)

| Stage | Input (kg) | Output (kg) | Yield |
|---|---|---|---|
| Split granulation, 2 sub-lots (replicate section), FBD with LOD loop | 78.060 intragranular solids | 38.600 + 38.550 = 77.150 dried granules | 98.83 % |
| Recovery addition, case 2 (L-28): milled cores of GBT-REC-01, same product, 41 days old | cap 3 % of 81.660 = 2.450 | 2.000 added (2.45 %) | - |
| Blending and lubrication | 77.150 + 3.600 + 2.000 = 82.750 | 82.310 | 99.47 % |
| Compression (left/right IPC) | theoretical T = 81.660 + 2.000 = 83.660 | A = 80.920 good cores, B = 0.620 reusable residue, 0.390 rejects | A/T 96.72 %; (A + B)/T 97.47 %; accountability 99.54 % of the blend |
| Film coating, 3.0 % weight gain | 80.920 cores | 83.290 coated | gain 2.93 % |
| Inspection (TB-20), witnessed destruction (G-23) | 83.290 | 83.110 accepted | 0.180 destroyed |

The (A + B)/T yield is shown beside the good-output yield (outline 9.1, sample data problem).

## Variants (to the "release for packing" gate)

- **Source batch** (PO-GBT01-0003, posted through the ERP route): run to inspection, where 4.520 kg of milled cores are
  kept as reusable residue (TB-20) and reserved by the QC unit (RESERVE_RESIDUE); the clock then moves 41 days on.
- **Happy** (PO-GBT01-0001): every check in limits; the QC unit authorises the case-2 addition of 2.000 kg (TB-08,
  REPROCESSING_ACT AUTHORISE_ADDITION) before blending; the "approved for coating" (H-COAT) and "release for packing"
  (H-PACK) QA gates signed. The only exceptions are ALERTs the design itself raises, each dispositioned NO_IMPACT by QA at
  the stage sign-off: the manual-entry fallbacks (the driver keys the press, coater and balance values by hand: there is
  no HTTP path from a gateway reading to an entry in Phase 3) and the QC decision on extra testing that a reprocessing
  addition always needs (PR-47; the QC approver decides NONE_REQUIRED).
- **Exception-rich** (PO-GBT01-0002): as the happy variant, plus the extra-IPA branch (0.300 kg, within its 0.480 kg
  maximum); an LOD loop of two iterations on sub-lot 2 (4.1 % then 2.9 %); a failing right-side weight IPC at
  compression (8480.0 mg for 20 tablets) that holds the right-side container made since the last passing check
  (IPC_CHECK_FAILED, ACTION; a deviation raised by QA, linked by the supervisor, dispositioned DEVIATION_RAISED; QA
  releases the container after the investigation); inspection rejects destroyed with a witness (G-23).
- **Negatives (9.1)**, each refused or flagged on the master (designer validate route) or on the batch: hardness in the
  legacy alias kg/cm² (as kgf/kp) accepted with a DATA-UNITS warning, kg/cm2 and kPa refused (DATA-UNITS errors); a
  trihydrate label on the anhydrous molar mass flagged (TB01-HYDRATE-MASS); the addition step without its declared case
  refused; an addition without the QC unit's approval refused; the (A + B)/T yield recorded beside A/T (compYieldAB,
  compYield); an operator choosing the supervisor's extra-IPA branch refused (EBMR-IAM-040); ending a loop iteration
  from a step outside any loop refused (ENG-UNKNOWN-CONSTRUCT); the MBR approval refused before its check
  (EBMR-ESIG-039), to its author (ESIG_PREVIEW_NOT_ALLOWED) and on a stale revision (DESIGNER_STALE). A correction of
  the LOD of 4.1 % to 3.0 % without evidence is recorded as **accepted**: see the review below.

## Review of the first run (slice 6d)

Every worksheet quantity and yield matched on both variants; the states, exception counts, genealogy, signature
counts (happy 131, exception-rich 136) and hashes in `expected.json` are this run's. Findings for the owner:

- **Correction of an out-of-limits loop endpoint (INV-41, DI-24).** The LOD of 4.1 % that made the drying loop iterate is
  a loop-endpoint reading in progress; the engine does not mark it failed (by design: the signing content shows
  `failed: null` for loop endpoints), so the fail-to-pass rule (engine ENG-CORRECT-FAIL-TO-PASS, database guard [175])
  does not apply and a QA-approved correction to 3.0 % without evidence is accepted. CORRECT_ENTRY has no HTTP intent in
  Phase 3, so this is not reachable today; the failing weight IPC is a block entry, which is never corrected at all.
  Whether an endpoint reading outside its limits counts as failing for corrections is the owner's decision.
- The refusal TB08-NOT-AUTHORISED states its code and controls twice in its "why" text.

## How the run is driven

`gb-t-01.test.ts` builds a GMP installation on the golden cluster (`world.ts`: the 6a formula and `createFamily` with
it, the life-cycle signatures through the signable action MBR_TRANSITION), the plant (`plant.ts`), and runs the three
batches through `/api/batches/*` as the seeded personas (`driver.ts`, `stages.ts`, `scenario.ts`). Each batch's outputs
are read back by `results.ts` and compared with `expected.json`: states, exceptions, the decimal values and yields, the
dispensing calculation, genealogy, the number of batch-record signatures and the SHA-256 of the normalised true copy.

## Time (D-S6-6)

The golden test's PostgreSQL runs under libfaketime with a timestamp file the driver only moves forward
(`FAKETIME_TIMESTAMP_FILE`, `FAKETIME_NO_CACHE=1`); nothing in the GMP code reads a test clock. GB-T-01 freezes the
clock at the next midnight UTC and ticks it one second before each act, so every time and duration the server measures
is the same on each run (blend 601 s, lubrication 181 s). The hash's normalisation (`results.ts`) turns the run's
instants into minutes from the batch's issue, and an expiry month and the year in a deviation number
(DEV-SITE-1-&lt;year&gt;-00001) into placeholders; the seeded lots' fixed retest and expiry dates (2027 to 2029, after the
run) stay as they are. Until 12 October 2026 those lot dates were taken for the run's instants and became offsets from
the issue, so the hashes changed with the day of the run (and the exception-rich one with the year).
`EBMR_GOLDEN_LATER_DAYS=<n>` starts the clock n days after the next midnight, to check that the hashes do not depend on
the day; keep n under about 45, since the personas' passwords are set at the real time and age out after 90 days
(DI-19), and the variants run 41 days after the start. CI runs it in the `golden` job on its own cluster, one file at a
time (`.github/workflows/ci.yml`); a run takes about 20 minutes.

Hashes re-recorded on 12 October 2026 (Phase 4 slice 1): the driver now has a second person verify each typed container
net (DI-30, recipe-core 0740) and, before QA releases the held compression containers, the investigator records a finding
and a second QA person concludes the deviation (recipe-core 0741). These acts sit outside the batch's record head; the
normalised true copies differ from the previous recording only in instants one minute later (happy 47, exception-rich 34 values),
since the extra one-second ticks cross a minute boundary. No key was added or removed, and every other value of
`expected.json` (signatures 131 and 136 included) is unchanged.

## Residuals (Phase 3; for the owner)

Steps the driver takes through the database as the right persona because no route exists yet: the change record, risk
assessment, draft attributes, sandbox-run evidence and verification record of the MBR; the market authorisation and the
batch-number rule; lot reservations; equipment and instrument uses, area occupancy, output containers and the tooling
register; the reprocessing authorisation proposal; the release of a held container (signed by the kernel ceremony
directly). Also: no HTTP path from gateway readings to G-06 entries (simulators unused; values keyed under the manual
fallback); CORRECT_ENTRY has no HTTP intent (the negative asks the engine directly); a refusal text says "test run" on a
GMP batch.

Fixed after the first review (coordinator): the coating pan load is refused while a compression output container of the
batch is on hold (tablets 1092, EBMR-TAB-390); a GMP G-07 weighing of a lot is consumed from the batch's reservation in
its command and the database refuses one without it (tablets 1093, EBMR-TAB-391), so the dispenser now weighs the other
materials too and the driver no longer consumes them itself.
