# GB-I-01 worksheet (Injectables I-6)

GB-I-01 is the first Injectables golden batch: an **invented** aseptically filled vial (decision 0006 part 3), Demoinj
aseptic 10 mg/2 mL vials (product GBI01-VIAL), made for India from the Injectables catalogue's blocks, from its approved
master to a RELEASED finished lot. Every quantity below was set by hand before the first run and copied into
`expected.json`; only the states, exceptions, signature counts, the G-REL items and the hashes of the normalised true
copies are taken from the first reviewed run (D-S6-7). The run is on the frozen golden clock (`../clock.ts`); a second
run three days later (`EBMR_GOLDEN_LATER_DAYS=3`) gave the same hashes.

All data here are DEMO-ONLY: the product, the methods, the limits, the samples and the results are invented.

## Masters (scenario.ts)

| Record | Stage | Blocks |
|---|---|---|
| Processing (V{YY}{SEQ:5}) | S-FILL, aseptic filling | INJ-FILL (line VIAL-LINE-GBI01, room ROOM-C-GBI01), INJ-STERILITY-SAMPLE |
| | S-EM, after incubation | INJ-EM-COUNTS |
| | S-RELEASE | H-PACK (QA's release for packing) |
| Packaging ({PARENT}/P{SEQ:2}) | S-PACK | INJ-PACK-EXAM (closes an injectables packaging record) |

The plant units, the masters' plant-free shape, the ERP orders (PO-GBI01-001, PO-GBI01-002) and the numbering rules are
arranged as in the injectables chain tests (`../../injectables/vial-chain.test.ts`, `aseptic-gate.test.ts`).

## Quantities and waits

| What | Quantity |
|---|---|
| Filled loads, closed into output containers (stage FILLED) and verified | 4,900 + 4,820 = 9,720 vials |
| Bulk taken by the packaging order | both loads |
| Finished lot posted by the stores | 9,600 vials |
| Reserve sample | 66 vials = twice the full test plan, 2 x (20 + 3 + 10) (PR-44, IN-32) |
| EM plates' incubation, before their counts | 7 days |
| Rapid sterility method's read, after the lot is posted | 7 days |

## Finished product specification (QC drafts, the head of QC approves)

| Test | Method (from the specification) | Limit | Sample | Result |
|---|---|---|---|---|
| STERILITY | Validated rapid microbial method (the firm's entry) | at most 0 containers with growth | 20 | 0, PASS |
| ENDOTOXIN | STP-GBI01-BET-01 (IP 2022) | at most 0.50 [EU]/mL | 3 | 0.10, PASS |
| PARTICULATE_MATTER | STP-GBI01-PM-01 (IP 2022) | at most 6000 | 10 | 850, PASS |

QC records each result with its test, purpose and value only; the method, unit and limits are the specification's
(site 0841; IN-33). A STERILITY result sent with another method is refused (EBMR-SITE-412). The head of QC, another
person, approves each result. The lot's results screen shows each result's method, read-only (`LotResultView.methodReference`).

## Release

Production approves both records; QA concludes their registers, reviews their audit trails and signs the QA review; G-REL
for India is GREEN or NA on every item (none RED; `expected.json`, `fromTheRun.release.ready`), and the authorised person
signs the manufacturer's release: the lot is RELEASED for India.

Handbook: [06-testing-and-debugging.md](../../../../../docs/handbook/06-testing-and-debugging.md)
