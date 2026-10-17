# Phase 6 exit demo, record

Run 2026-10-17T05:43:09.515Z to 2026-10-17T06:00:13.206Z (UTC), commit fdfc549b, by `pnpm demo:phase6-exit` (tools/e2e/demo/run.ts). Written by the run; re-running replaces this file and the screenshots.

The stack is the real product: the GMP and sandbox servers, the sandbox site gateway with its scale simulator, a GMP site gateway holding the OPC UA press endpoint, the ERP, QMS, LMS, CMMS, L3/L4 and OPC UA simulators each as its own process, the adapters started by the servers themselves, and Chromium (tools/e2e/demo/global-setup.ts). Item 7 runs two further GMP servers on HTTP (vitest.demo.config.ts). DEMO-ONLY data and credentials; every name is unique per run, so ids, hashes and times differ between runs while the outcomes do not.

## Summary

| Item | What | Result |
|---|---|---|
| 1 | ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk | FAIL |
| 2 | A press excursion over OPC UA acknowledged with a comment in the batch's alarm log | FAIL |
| 3 | A serial query (L3) | PASS |
| 4 | A mock recall from an API lot to every consignee, signed off by the authorised person | PASS |
| 5 | Controlled dispensing under dual custody (IN-53 draft banner) | PASS |
| 6 | English step screens | FAIL |
| 7 | A lot transferred between two sites (two installations) and accepted by local QA | PASS |

Screenshots: 13 files, 873 KiB in exit-demo/.

## 1. ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk

Each system is its simulator process; each adapter is started by the sandbox server itself from its service-keys file (MIRROR mode) and pulls on its own 5 s timer. The demo only publishes on the simulators and switches their faults (POST /api/fault). The stale mirror is real time: the LMS mirror bound is set to its minimum (60 s, a change-controlled setting) and the LMS stops confirming its feed (STALE_MIRROR), so the adapter records no synchronisation. Arranged in the database as the 6j-b flows do: the training coordinator's product requirement, the employee numbers, the change record.

### Passed: [DI-31][DI-20] the ERP, QMS, LMS and CMMS exchange data under injected faults (malformed, duplicate, out of order, link cut): each refused or de-duplicated with an alarm, no partial value, the count reconciles @demo

Started 2026-10-17T05:56:41.939Z, 178.4 s.

- **ERP: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T05:56:43.379Z to 2026-10-17T05:56:44.950Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `ERP-JANDKX`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **ERP: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T05:56:44.951Z to 2026-10-17T05:56:50.019Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the erp.material_master v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `37c18b06-996e-4ec9-b065-52fbe5b9f1c9`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **ERP: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T05:56:50.019Z to 2026-10-17T05:57:00.083Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **ERP: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T05:57:00.084Z to 2026-10-17T05:57:04.636Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `f0cb097e-a896-42ba-b4f8-3c3b8d56ca9b`
- **ERP: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T05:57:04.636Z to 2026-10-17T05:57:24.683Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `MAT-DEMO-YZBFM-6`
  - payloadHash: `fd2f8f96850505911645a7805eeec5a79aed580ce1f43351e187b0d0a5b379aa`
- **ERP: reconciliation of the run (no silent loss)** (2026-10-17T05:57:24.684Z to 2026-10-17T05:57:24.693Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **QMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T05:57:24.696Z to 2026-10-17T05:57:29.740Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `QMS-LJUCHU`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **QMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T05:57:29.741Z to 2026-10-17T05:57:34.794Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the qms.capa v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `fa1e59df-ba81-41e3-bfa5-41b8d62b77cf`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **QMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T05:57:34.794Z to 2026-10-17T05:57:44.874Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **QMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T05:57:44.875Z to 2026-10-17T05:57:49.928Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `7ce0870b-ccef-461e-86f9-a10e35739834`
- **QMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T05:57:49.928Z to 2026-10-17T05:58:09.993Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `CAPA-DEMO-YZBFM-12`
  - payloadHash: `7966cdb0c1de0d3d75eb8f3b0ea380bf51edd3a380b45d2b9beaf7e56c14631d`
- **QMS: reconciliation of the run (no silent loss)** (2026-10-17T05:58:09.994Z to 2026-10-17T05:58:09.999Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **LMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T05:58:10.001Z to 2026-10-17T05:58:15.045Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `LMS-CJQJQX`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **LMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T05:58:15.045Z to 2026-10-17T05:58:20.092Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the lms.qualification v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `d7caee60-773c-4141-9bb5-19b774c7190e`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **LMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T05:58:20.097Z to 2026-10-17T05:58:29.685Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **LMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T05:58:29.686Z to 2026-10-17T05:58:34.758Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `0753ef9f-2e21-413a-bf96-303f9134165c`
- **LMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T05:58:34.759Z to 2026-10-17T05:58:54.826Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `EMP-YZBFM/SOP-DEMO-YZBFM-6`
  - payloadHash: `74247c60fc2114263d178b8fc33663e090df2299b5216439c8de4bf295efca5c`
- **LMS: reconciliation of the run (no silent loss)** (2026-10-17T05:58:54.826Z to 2026-10-17T05:58:54.841Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **CMMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T05:58:54.842Z to 2026-10-17T05:58:59.898Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `CMMS-OMLKYO`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **CMMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T05:58:59.899Z to 2026-10-17T05:59:04.952Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the cmms.maintenance v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `91b08d04-395e-4fc0-9c9a-50ee92f37678`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **CMMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T05:59:04.952Z to 2026-10-17T05:59:15.008Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **CMMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T05:59:15.009Z to 2026-10-17T05:59:20.049Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `758f8524-8ff5-4ece-88af-05f78b0b30ca`
- **CMMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T05:59:20.053Z to 2026-10-17T05:59:40.103Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `BAL-BLEND-01/WO-DEMO-YZBFM-24`
  - payloadHash: `fb30a0f6f50fd2cf4d1d10cd57b273f8355241c530494a702622debd2308dec1`
- **CMMS: reconciliation of the run (no silent loss)** (2026-10-17T05:59:40.103Z to 2026-10-17T05:59:40.112Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **The integration health page lists the four adapters and the integration alarms the faults raised** (2026-10-17T05:59:40.112Z to 2026-10-17T05:59:40.373Z)
  - Expected: Every adapter is listed with its worker; the alarms of the faults are shown
  - Actual: 6 of 6 assertions passed
  - ERP: `adapter ERP-JANDKX: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - QMS: `adapter QMS-LJUCHU: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - LMS: `adapter LMS-CJQJQX: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - CMMS: `adapter CMMS-OMLKYO: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - alarmsShown: `16`
  - Screenshot: [exit-demo/item1-1.jpeg](exit-demo/item1-1.jpeg)

### **FAILED**: [DI-31] a stale LMS mirror (no synchronisation for longer than its 60 s bound) refuses the operator's step signature at the kiosk, naming the stale qualification source; once the adapter synchronises again the same signature is accepted @demo

Started 2026-10-17T05:59:40.465Z, 1.4 s.

```text
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:36065/demo/devices
Call log:
  - navigating to "http://localhost:36065/demo/devices", waiting until "load"

```

**FAIL**

## 2. A press excursion over OPC UA acknowledged with a comment in the batch's alarm log

Path used: the press's Alarms-and-Conditions REJECT_BURST on the OPC UA feed (OPC UA simulator -> GMP site gateway, its own process, holding the enrolled endpoint -> the GMP server's OPCUA adapter). Not shown: a tag-limit excursion over the gateway's process uplink: the GMP installation has no gateway uplink listener (only the sandbox server has one) and GB-T-03 does not start that path either (D-P6j-b-3); the alarm log and the acknowledgment are the same for both. Arranged: the press in use for the DEMO-ONLY review batch (an open equipment use after its verified cleaning), so the alarm binds to that batch.

### **FAILED**: [DI-49][DI-31][INV-40] a press excursion over OPC UA (the press's REJECT_BURST through the site gateway) binds to the batch using the press and is acknowledged at the kiosk with the action taken and a comment, shown in the batch's alarm log @demo

Started 2026-10-17T05:59:43.239Z, 1.6 s.

```text
error: invalid input syntax for type uuid: ""
```

**FAIL**

## 3. A serial query (L3)

The L3/L4 simulator is the GMP server's L3 system (EBMR_L3_URL); the server asks it live. Arranged as the L3 server test arranges it: the pool row of the review batch (tab.serial_pool).

### Passed: [PR-42] a serial query: the server asks the L3 system live and answers the serial's lot from the record and its L3 status; an unknown serial is refused @demo

Started 2026-10-17T05:59:46.407Z, 3.4 s.

- **Serial lookup: ask for serial LFUN5H9MVG8V** (2026-10-17T05:59:47.573Z to 2026-10-17T05:59:47.883Z)
  - Expected: The record's lot (the batch number) and the L3 status COMMISSIONED, with the pool and GTIN; no difference reported
  - Actual: 3 of 3 assertions passed
  - serial: `LFUN5H9MVG8V`
  - poolId: `POOL-000001`
  - gtin: `00312345678906`
  - lot: `GBT260001`
  - expiry: `2028-09`
  - status: `Commissioned`
  - Screenshot: [exit-demo/item3-1.jpeg](exit-demo/item3-1.jpeg)
- **Serial lookup: ask for a serial no pool of the record holds (DEMO69C133EC)** (2026-10-17T05:59:47.885Z to 2026-10-17T05:59:49.899Z)
  - Expected: Refused with its code (the L3 does not know it); nothing is shown as the answer
  - Actual: 3 of 3 assertions passed
  - serial: `DEMO69C133EC`
  - status: `404`
  - code: `null`
  - why: `null`
  - Screenshot: [exit-demo/item3-2.jpeg](exit-demo/item3-2.jpeg)

**PASS**

## 4. A mock recall from an API lot to every consignee, signed off by the authorised person

The suite's 6j-b flow as it is: the lot chain (receipt, consumption, finished lot, two ERP distribution records) is arranged as the genealogy server tests arrange it; the explorer, the mock recall and the AP sign-off are the real screens. GB-T-03 shows the same recall with the shipments landed by the ERP adapter (golden job).

### Passed: [PR-57][IN-07] the genealogy explorer traces an API lot forward to the batch, its finished lot and every shipment, as a tree and as a table, and a shipment backward to the API lot @office

Started 2026-10-17T06:00:03.489Z, 3.8 s.

- **Trace the API lot forward** (2026-10-17T06:00:05.720Z to 2026-10-17T06:00:07.016Z)
  - Expected: Lot, batch (consumed), finished lot and both shipments, with their depth; the counts say 2 lots, 1 batch, 2 shipments
  - Actual: 16 of 16 assertions passed
  - rows: `5`
  - Screenshot: [exit-demo/item4-1.jpeg](exit-demo/item4-1.jpeg)
- **Trace the first shipment backward** (2026-10-17T06:00:07.018Z to 2026-10-17T06:00:07.337Z)
  - Expected: From the shipment to the finished lot, the batch and the API lot it consumed
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item4-2.jpeg](exit-demo/item4-2.jpeg)

### Passed: [IN-29][PR-57] the head of QC runs a mock recall from the API lot to every consignee; it reproduces, reconciles delivered against returned, and the authorised person signs it off through the ceremony @office

Started 2026-10-17T06:00:07.427Z, 4.9 s.

- **The head of QC runs a mock recall from the API lot** (2026-10-17T06:00:09.276Z to 2026-10-17T06:00:10.316Z)
  - Expected: The recall reproduces; it lists the batch, the finished lot delivered 650 units with nothing returned, and both consignees with their addresses
  - Actual: 16 of 16 assertions passed
  - consignees: `2`
  - Screenshot: [exit-demo/item4-3.jpeg](exit-demo/item4-3.jpeg)
- **The authorised person signs the mock recall off** (2026-10-17T06:00:11.228Z to 2026-10-17T06:00:12.130Z)
  - Expected: The ceremony signs it; the recall shows who signed it off
  - Actual: 5 of 5 assertions passed
  - signedBy: `Shalini Kapoor-wA`
  - Screenshot: [exit-demo/item4-4.jpeg](exit-demo/item4-4.jpeg)

**PASS**

## 5. Controlled dispensing under dual custody (IN-53 draft banner)

The suite's 6j-b flow as it is. IN-53 is a draft control (NDPS rules not verified; owner decision pending): every screen carries the draft banner.

### Passed: [IN-53] controlled dispensing under dual custody: QA flags the product and a second QA person approves; the stores person proposes and signs first, cannot countersign; a verifier at the kiosk countersigns @office

Started 2026-10-17T05:59:49.943Z, 10.7 s.

- **QA records the controlled-substance flag of the product for the controlled API material, under the change record** (2026-10-17T05:59:51.515Z to 2026-10-17T05:59:52.483Z)
  - Expected: The draft banner is on the screen; the flag is recorded and awaits a second QA person
  - Actual: 7 of 7 assertions passed
  - Screenshot: [exit-demo/item5-1.jpeg](exit-demo/item5-1.jpeg)
- **A second QA person approves the flag through the ceremony** (2026-10-17T05:59:53.389Z to 2026-10-17T05:59:54.066Z)
  - Expected: The flag is APPROVED and in effect for the material
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item5-2.jpeg](exit-demo/item5-2.jpeg)
- **The issuer plans a GB-T-01 batch from the open order and issues it through the ceremony** (2026-10-17T05:59:54.221Z to 2026-10-17T05:59:55.590Z)
  - Expected: The batch is issued
  - Actual: 7 of 7 assertions passed
  - batchNumber: `GBT260002`
  - Screenshot: [exit-demo/item5-3.jpeg](exit-demo/item5-3.jpeg)
- **The stores person proposes the dispensing of 2.500 kg of the controlled lot to the batch and signs as the first custodian** (2026-10-17T05:59:56.519Z to 2026-10-17T05:59:57.523Z)
  - Expected: The dispensing names the batch; after the first signature it awaits the second custodian
  - Actual: 12 of 12 assertions passed
  - Screenshot: [exit-demo/item5-4.jpeg](exit-demo/item5-4.jpeg)
- **The same person tries to countersign as the second custodian** (2026-10-17T05:59:57.584Z to 2026-10-17T05:59:58.058Z)
  - Expected: The ceremony refuses it: one person never fills both places; the record still awaits the second custodian
  - Actual: 3 of 3 assertions passed
  - refusal: `This signature must come from a person other than those who signed before it. Nothing was signed. Why: CONTROLLED_CUSTODY_COUNTERSIGNED must be signed by a person other than the signers of {CONTROLLED`
  - Screenshot: [exit-demo/item5-5.jpeg](exit-demo/item5-5.jpeg)
- **A verifier at the dispensing kiosk countersigns as the second custodian (badge and PIN)** (2026-10-17T05:59:59.237Z to 2026-10-17T06:00:00.549Z)
  - Expected: The dispensing is CONFIRMED with two different custodians
  - Actual: 9 of 9 assertions passed
  - state: `CONFIRMED`
  - Screenshot: [exit-demo/item5-6.jpeg](exit-demo/item5-6.jpeg)

**PASS**

## 6. English step screens

The suite's 6j-b flow as it is (decision 0018: English only).

### **FAILED**: the step screen is in English: the page declares English, offers no other language, writes Western digits and dates as 27-SEP-2026 @kiosk

Started 2026-10-17T06:00:00.618Z, 1.3 s.

```text
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:36065/demo/devices
Call log:
  - navigating to "http://localhost:36065/demo/devices", waiting until "load"

```

**FAIL**

## 7. A lot transferred between two sites (two installations) and accepted by local QA

Two GMP servers (PUNE, GOA), each on its own database with its own installation key, listening on HTTP, as the 6i route tests run them; the exchange goes over HTTP between them. Arranged (deployment steps): the installation identities and proposed peers, the released intermediate lot at PUNE. Not through the browser: the transfer screens exist, but the two-installation browser stack is not built (the E2E stack has one GMP and one sandbox installation).

Run by vitest (apps/tablets-server/test/demo/transfer.demo.ts): exit code 0.

- **Two installations trust each other (QA approved each peer key through the ceremony)** (2026-10-17T05:43:43.600Z)
  - pune: `PUNE-2FE2 http://127.0.0.1:34159`
  - goa: `GOA-2FE2 http://127.0.0.1:43607`
  - puneSees: `GOA-2FE2 APPROVED`
- **PUNE stores seal a package of the released intermediate lot for GOA (100 kg)** (2026-10-17T05:43:43.709Z)
  - lot: `INT-2FE2`
  - packageNo: `INT-2FE2/T1`
  - packageId: `40070a4a-6df1-44d1-94ff-1e593354ae63`
  - sealed: `true`
  - seal: `n8lRcYHAyxNCimFeK1mPULbU/ayVr9YXZYyUpQtc+gASborXLF4mHK8rCGWfzR7T`
- **GOA stores take in a copy whose quantity was changed to 400** (2026-10-17T05:43:43.801Z)
  - outcome: `REFUSED`
  - kind: `TAMPERED`
  - alarmKind: `TAMPERED`
  - alarmSeverity: `MAJOR`
  - alarmPath: `TRANSFER_IMPORT`
- **GOA stores take in the genuine package** (2026-10-17T05:43:43.866Z)
  - outcome: `RECEIVED`
  - receiptId: `0de34123-5a86-4f56-90bf-514e311bf60a`
  - origin: `PUNE-2FE2`
  - originState: `RELEASED_FOR_FURTHER_PROCESSING`
  - lotState: `QUARANTINE`
  - state: `RECEIVED`
  - quantity: `100`
  - holdRemainingSeconds: `69704176`
- **GOA stores take in the same package a second time** (2026-10-17T05:43:43.904Z)
  - outcome: `REFUSED`
  - kind: `DUPLICATE`
- **GOA stores try to accept the receipt** (2026-10-17T05:43:43.933Z)
  - ok: `false`
  - refusal: `ESIG_PREVIEW_NOT_ALLOWED`
- **GOA QA accepts the receipt through the ceremony (TRANSFER_RECEIPT_DECIDE)** (2026-10-17T05:43:44.125Z)
  - ok: `true`
  - signature: `{"manifestation":{"signatureId":"8f854789-7d48-4478-ab54-bcda881e3cba","signer":{"personId":"37d9f659-8742-4dd7-a426-8a643fc3c0ce","legalName":"Divya Menon","loginName":"divya.menon","role":"QA_REVIEW`
  - state: `ACCEPTED`
  - decision: `ACCEPTED`
  - decidedBy: `{"decision":"ACCEPTED","reason":null,"by":{"personId":"37d9f659-8742-4dd7-a426-8a643fc3c0ce","legalName":"Divya Menon","loginName":"divya.menon","role":"QA"},"at":{"us":"1792215824105748","text":"17-O`
  - lotState: `QUARANTINE`
- **PUNE traces its lot forward across the transfer** (2026-10-17T05:43:44.312Z)
  - complete: `true`
  - localEdges: `LOT:null TRANSFER:TRANSFERRED`
  - remotePeer: `GOA-2FE2`
  - remoteStatus: `ANSWERED`
  - remoteEdges: `TRANSFER:null LOT:TRANSFER_RECEIVED`
**PASS**

