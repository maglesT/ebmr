# GB-T-03 worksheet, "connected" (Phase 6 slice 6j-b; D-P6-7, D-S6-7)

GB-T-03 is the third Tablets golden batch: GB-T-02's **invented** direct-compression product (Exemplafen tablets
100 mg, 1,00,000 tablets of 200 mg, HDPE bottles of 30), made, packed and released for **India and the US** at a site
whose own systems feed the eBMR through its adapters, then recalled in a mock recall from its API lot. The quantities and
yields are GB-T-02's hand worksheet (`../gb-t-02/README.md`), with two changes: the cellulose is weighed from the
identity-tested lot GBT2-MCC-001 (a batch for the US needs an identity result; IN-24), and the cartons are serialised
for the US. Every quantity, yield and serial count below was fixed before the first run and copied into
`expected.json`; the states, exceptions, signature counts, what each adapter landed and the hashes of the normalised true
copies and of the normalised mock recall are taken from the first reviewed run (D-S6-7).

## The connected site (`connected.ts`, `opcua.ts`)

Each system is its simulator (`apps/simulators`), started as its own process; the server's adapter workers (the 6a
framework) pull its feed as the system's registered INTEGRATION identity (DI-20). The driver runs each worker's cycle at
fixed points of the scenario (`sync`) instead of the server's 5 s timer, so the number and order of synchronisations do
not depend on the machine's speed. The data classes go live as MIRROR under a configuration change record the steward
raises, QA approves with its signature and the process owner applies (DI-09).

| System | What it sends | Where it is used |
|---|---|---|
| ERP | the production and packaging orders; after the release, the two shipments of the finished lot | the batch and the order are planned against them; the mock recall reaches their consignees |
| WMS | the status of the 8 lots the batch and the order use | the lot-status mirror |
| LMS | the product training (SOP-GBT03-PROD) of operator1, operator2 and supervisor1 | a performer's signature on the product needs it (a requirement on STEP.SIGN_PERFORMED) |
| CMMS | the calibrations of 5 instruments (the 3 room balances, the packing balance, the torque tester) and the preventive maintenance of the blender and the press | the equipment-use guard (no logbook calibration at this site: EBMR-PLANT-025) |
| L3/L4 | the US serial pool (3,214 serials), the 32 aggregations of 100 packs to the shippers' SSCCs, the report | the printed-materials step closes on the report; the US release item reads the L3 mirror |
| OPC UA press | through the site gateway: the endpoint's session, the native series of PRESS-01, a reject-burst alarm | the batch's alarm log, the series in the batch's context |

## Bottle order and serials (PK-30, US serialised)

As GB-T-02: 3,200 bottles, labels and cartons issued 3,250 each, nothing unexplained, 32 shippers of 100 cartons,
packaging yield 98.46 %. The serial pool covers every coded carton: 3,200 used + 10 coded and destroyed + 4 specimens
= **3,214** serials, commissioned in the L3 system; the 10 destroyed and the 4 specimens leave COMMISSIONED there; the
L4 aggregates 100 packs to each of the 32 shippers; the L3 report closes the pool on the printed-materials step.

## The release, the stale mirror and the mock recall

- The L3 mirror fails closed: an hour and a minute after its last synchronisation (its bound is an hour) the US item
  E.RECONCILIATION_SERIAL is RED with the stale mirror named; the next synchronisation turns it GREEN. This is done before
  QA's review.
- QA reviews both records; the AP releases the lot for India (G-REL green). The US quality-control unit then evaluates
  G-REL for the US, acknowledges each item marked "since review" (the manufacturer release locked the records, which
  moves their evidence epoch; see Residuals) and releases for the US.
- The ERP posts two shipments of the lot: 1,600 packs to CUST-IN-PUNE and 1,596 to CUST-US-NJ (3,200 posted, 4 kept as
  reserve samples).
- QA runs a mock recall from the API lot GBT2-EXF-001: it reaches the batch, the order, the finished lot and both
  consignees, reproduces, and the AP signs it off.

## Time (D-S6-6)

As GB-T-01's: the database clock is frozen at the next midnight UTC (or `EBMR_GOLDEN_LATER_DAYS` days later) and the
driver only moves it forward. The simulators and the gateway preload the golden clock library on the same file
(`EBMR_GOLDEN_CLOCK_LIB`), so the times they stamp are the database's. The OPC UA press needs increasing source times:
during the compression run the clock runs on at real speed from where it stood (`runFromFrozen`) while the gateway
connects, the alarm is raised and cleared and a chunk of every press tag lands, and is then frozen again exactly ten
minutes after that instant; those ten minutes are taken from the twenty before the run's first weight check. What
depends on the machine's speed (sample and chunk counts, source times) is never compared.

## Residuals (for the owner)

- After the manufacturer release locks the records (recipe-core 0870, FIRST_DISPOSITION), every G-REL item resting on
  them shows "since review" for the next market's signer, although no evidence changed; the US signer acknowledges 8
  items. Fail-safe, but noise for the signer; reported to the 6j-c review.
- The press alarm in GB-T-03 is the press's Alarms-and-Conditions occurrence (REJECT_BURST) through the gateway's OPC UA
  feed. A limit excursion of a tag travels the gateway's process path to the server (its uplink session), which GB-T-03
  does not start; the alarm log and the acknowledgment are the same for both.
- Set-up acts without a route are taken through the database as the right person, as in GB-T-01 and GB-T-02 (the
  product, the LMS training requirement, the employee numbers, the endpoint's registration and enrolment, the process
  owner's mode settings, the serial pool's coder calls).

Handbook: [06-testing-and-debugging.md](../../../../../docs/handbook/06-testing-and-debugging.md)
