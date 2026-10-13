# GB-T-02 worksheet (Phase 4 slice 7b; D-P4-15, D-S6-7)

GB-T-02 is the second Tablets golden batch: an **invented** direct-compression product (decision 0006 part 3),
Exemplafen tablets 100 mg, 1,00,000 uncoated tablets of 200 mg, packed in HDPE bottles of 30 tablets, made for India,
and then the negative of outline 9.1: the US added after an India-only vendor-history excipient lot was consumed is
INELIGIBLE (the identity test had to precede use). Every quantity and yield below was computed by hand before the first
run and copied into `expected.json`; only the states, exceptions, signature counts and the hashes of the normalised true
copies are taken from the first reviewed run (D-S6-7). The masters are `src/cli/golden-gb-t-02.ts`: the processing master
is GB-T-01's template with the granulation, the reprocessing addition, the coating and the inspection taken out; the
bottle master is built like GB-T-01's blister master.

## Formula (per tablet; 1,00,000 tablets; BS-100K, 20.000 kg)

| Material | Code | mg per tablet | Batch (kg) | Lot |
|---|---|---|---|---|
| Exemplafen (invented active) | MAT-EXF | 100 | 10.000 | GBT2-EXF-001 (identity tested) |
| Microcrystalline cellulose PH 102 | MAT-MCC-102 | 84 | 8.400 | **GBT2-MCC-V01, released on the vendor-history route** (no identity result) |
| Croscarmellose sodium | MAT-CCS | 10 | 1.000 | GBT2-CCS-001 |
| Colloidal silicon dioxide | MAT-SIO2 | 2 | 0.200 | GBT2-SIO-001 |
| Magnesium stearate | MAT-MGST | 4 | 0.400 | GBT2-MGS-001 |

The vendor-history route serves India-only batches (site services 0710, IN-24 (c)); QA enabled it for MAT-MCC-102 with a
signed statistical justification in the GMP seed.

## Stages

| Stage | Input | Output | Yield |
|---|---|---|---|
| Dispensing (G-07, each material on the dispensing balance) | standard (100 + 84 + 10 + 2 + 4) mg x 1,00,000 = 20.000 kg | 20.000 kg | 100.00 % |
| Blending and lubrication (blend 10 min, lubrication 3 min) | 20.000 kg | 19.880 kg | 99.40 % |
| Compression, left and right weight checks (20 tablets: 4,000 mg) | T = 20.000 kg | A = 19.500 kg good (six bulk containers of 3.250 kg), B = 0.150 kg residue, 0.200 kg rejects | A/T 97.50 %; (A + B)/T 98.25 %; accountability (19.500 + 0.150 + 0.200) / 19.880 = 99.85 % |

QA releases the bulk for packing at H-PACK, after the compression yield.

## Bottle order (PK-30: 3,200 bottles of 30 tablets, 96,000 tablets)

| What | Quantity |
|---|---|
| Bulk issued | the six compression containers, 19.500 kg = 97,500 tablets of 200 mg |
| Bottles | issued by weight, 40.000 kg (12.5 g a bottle); 3,200 good |
| Roll labels | issued 3,250 (3,200 + 2 % = 3,264 at most) = 3,200 used + 20 coded destroyed + 26 returned uncoded + 4 specimens; unexplained 0 |
| Cartons | issued 3,250 = 3,200 used + 10 coded destroyed + 36 returned uncoded + 4 specimens; unexplained 0 |
| Shippers | 32 of 100 cartons (SSCCs issued by the database); finished lot posted 3,200 packs |
| Packaging yield | 96,000 / 97,500 = 98.4615 %, shown 98.46 % (limits 97.0 to 100.0) |
| Finished lot | ASSAY 99.6 %, DISSOLUTION 93 %, approved by the head of QC; 4 reserve packs |

## The release and the negative

The finished lot is released for India: G-REL green from signed records, the AP's MANUFACTURER_RELEASE. QA then adds the
US to the released lot under the master's change record (RELEASE_ACT MARKET_ADD, signed with the market-add evaluation):
MA.MBR_AUTHORISATION MET (both masters authorised for the US), MA.IDENTITY_ROUTE UNMET_FINAL (GBT2-MCC-V01 was consumed
with no identity result), MA.RELEASE_TESTS and MA.RESERVE_SAMPLES MET; the US disposition is INELIGIBLE and the US
quality-control unit's release is refused (EBMR-DSP-032).

## Time

As GB-T-01's (D-S6-6): the database clock is frozen at the next midnight UTC (or `EBMR_GOLDEN_LATER_DAYS` whole days
later) and the driver only moves it forward. The plant is cleaned on the frozen clock before each batch and order.
