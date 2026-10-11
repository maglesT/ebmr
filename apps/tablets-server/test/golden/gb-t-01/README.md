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

- **Happy:** every check in limits; the "approved for coating" and "release for packing" QA gates signed; no exception.
- **Exception-rich:** the extra-IPA branch taken (within its maximum); a failing right-side weight IPC at compression
  that holds the containers overlapping it (IPC_CHECK_FAILED, a deviation linked, QA disposition); an LOD loop of two
  iterations; inspection rejects destroyed with a witness; the recovery addition with its case and its approval.
- **Sample-data negatives (9.1):** hardness in kg/cm² only through the declared legacy alias with a warning, a genuine
  pressure unit refused; a trihydrate label on an anhydrous molar mass flagged; an addition without its case and its
  approval refused.

## Time (D-S6-6)

The golden test's PostgreSQL runs under libfaketime with an offset file the driver only moves forward
(`FAKETIME_TIMESTAMP_FILE`, `FAKETIME_NO_CACHE=1`); nothing in the GMP code reads a test clock. The simulators read time
from the database. CI runs it in the `golden` job on its own cluster (`.github/workflows/ci.yml`).

## Status

Formula, worksheet and expected quantities: done before the run. The MBR template (`gb-t-01.mbr.json`), the HTTP
driver over `/api/batches/*` and the normalised hash wait for builder 6a's routes (slice 6 plan, order of work).
