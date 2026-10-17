# Phase 6 exit demo, record

Run 2026-10-17T08:44:26.047Z to 2026-10-17T09:00:07.466Z (UTC), commit 0f879661, by `pnpm demo:phase6-exit` (tools/e2e/demo/run.ts). Written by the run; re-running replaces this file and the screenshots.

The stack is the real product: the GMP and sandbox servers, the sandbox site gateway with its scale simulator, a GMP site gateway holding the OPC UA press endpoint, the ERP, QMS, LMS, CMMS, L3/L4 and OPC UA simulators each as its own process, the adapters started by the servers themselves, and Chromium (tools/e2e/demo/global-setup.ts). Item 7 runs two further GMP servers on HTTP (vitest.demo.config.ts). DEMO-ONLY data and credentials; every name is unique per run, so ids, hashes and times differ between runs while the outcomes do not.

## Summary

| Item | What | Result |
|---|---|---|
| 1 | ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk | PASS |
| 2 | A press excursion over OPC UA acknowledged with a comment in the batch's alarm log | PASS |
| 3 | A serial query (L3) | PASS |
| 4 | A mock recall from an API lot to every consignee, signed off by the authorised person | PASS |
| 5 | Controlled dispensing under dual custody (IN-53 draft banner) | PASS |
| 6 | English step screens | PASS |
| 7 | A lot transferred between two sites (two installations) and accepted by local QA | PASS |

Screenshots: 20 files, 1394 KiB in exit-demo/.

## 1. ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk

Faults: each system is its simulator process; each adapter is started by the GMP server itself from its service-keys file (MIRROR mode; the integrations feature and its adapter workers are GMP's) and pulls on its own 5 s timer. The demo only publishes on the simulators and switches their faults (POST /api/fault). Stale mirror: the step signature is on a TEST- batch at the sandbox kiosk (as in 6j-b); no adapter worker runs on the sandbox, so its LMS training arrives through the adapter's receiving command, called as the registered adapter identity. The staleness is real time: the LMS mirror bound is set to its minimum (60 s, a change-controlled setting) and no synchronisation follows until it has passed. Arranged in the database as the 6j-b flows do: the training coordinator's product requirement, the employee numbers, the change record. By design a same-key, same-hash resend is recorded as DEDUPLICATED without an alarm (an alarm is raised for a same key with a different hash), and a cut link is a TRANSPORT failure that is retried, not recorded as a refusal or alarm; the worker's error shows on the adapter page. The SEQUENCE_GAP alarms in the counts were raised by the adapters during the fault sequences (each listed per system).

### Passed: [DI-31][DI-20] the ERP, QMS, LMS and CMMS exchange data under injected faults (malformed, duplicate, out of order, link cut): each refused or de-duplicated with an alarm, no partial value, the count reconciles @demo

Started 2026-10-17T08:55:29.808Z, 179.0 s.

- **ERP: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T08:55:30.567Z to 2026-10-17T08:55:33.592Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `ERP-QQRORF`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **ERP: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T08:55:33.592Z to 2026-10-17T08:55:38.614Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the erp.material_master v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `182130f9-63ee-455f-82af-a7fb589618ce`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **ERP: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T08:55:38.615Z to 2026-10-17T08:55:48.646Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **ERP: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T08:55:48.646Z to 2026-10-17T08:55:53.670Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `dfdff75f-3fd6-4b77-a1b4-3720fc2017c3`
- **ERP: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T08:55:53.670Z to 2026-10-17T08:56:13.698Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `MAT-DEMO-LNBPA-6`
  - payloadHash: `9874cb32d460813fc99dbb062666f488821d94987e371fe9887fad220ccbfe22`
- **ERP: reconciliation of the run (no silent loss)** (2026-10-17T08:56:13.698Z to 2026-10-17T08:56:13.703Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **QMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T08:56:13.703Z to 2026-10-17T08:56:18.723Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `QMS-KKFSSV`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **QMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T08:56:18.724Z to 2026-10-17T08:56:23.748Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the qms.capa v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `6c0e84cc-fe0e-4d7a-ab21-7e52a2aa2b14`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **QMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T08:56:23.748Z to 2026-10-17T08:56:33.284Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **QMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T08:56:33.285Z to 2026-10-17T08:56:38.312Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `2fbc29ac-6eca-4503-afd2-61da1f2ebb38`
- **QMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T08:56:38.312Z to 2026-10-17T08:56:58.337Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `CAPA-DEMO-LNBPA-12`
  - payloadHash: `72c9bf70c4c92aa6610dd32f1d653e6449dc25bdfa389c116540deef0179f86f`
- **QMS: reconciliation of the run (no silent loss)** (2026-10-17T08:56:58.337Z to 2026-10-17T08:56:58.341Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **LMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T08:56:58.341Z to 2026-10-17T08:57:03.360Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `LMS-ORPTUL`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **LMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T08:57:03.361Z to 2026-10-17T08:57:08.383Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the lms.qualification v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `58590c8b-8bb0-4bb7-9059-172e974f90dc`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **LMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T08:57:08.384Z to 2026-10-17T08:57:18.419Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **LMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T08:57:18.419Z to 2026-10-17T08:57:23.442Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `c17e7a38-1e54-405d-99fa-71f90c7973e6`
- **LMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T08:57:23.442Z to 2026-10-17T08:57:43.466Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `EMP-LNBPA/SOP-DEMO-LNBPA-6`
  - payloadHash: `8a7f655452f68bb734231e29fd7a4104750e64b263807627285ac78fdce46519`
- **LMS: reconciliation of the run (no silent loss)** (2026-10-17T08:57:43.467Z to 2026-10-17T08:57:43.471Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **CMMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T08:57:43.471Z to 2026-10-17T08:57:48.491Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `CMMS-FAEDTG`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **CMMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T08:57:48.492Z to 2026-10-17T08:57:53.512Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the cmms.maintenance v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `e4785bb9-9a86-4acd-9d25-f07d40715a56`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **CMMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T08:57:53.513Z to 2026-10-17T08:58:03.546Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **CMMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T08:58:03.546Z to 2026-10-17T08:58:08.564Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `908f67a9-86f4-43b9-a1c1-e8acc6277f90`
- **CMMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T08:58:08.565Z to 2026-10-17T08:58:28.585Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `BAL-BLEND-01/WO-DEMO-LNBPA-24`
  - payloadHash: `08e594998927f727a02c34254875b66a8ec975cf054b41520e40da7900c999d6`
- **CMMS: reconciliation of the run (no silent loss)** (2026-10-17T08:58:28.586Z to 2026-10-17T08:58:28.589Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **The integration health page lists the four adapters and the integration alarms the faults raised** (2026-10-17T08:58:28.589Z to 2026-10-17T08:58:28.813Z)
  - Expected: Every adapter is listed with its worker; the alarms of the faults are shown
  - Actual: 6 of 6 assertions passed
  - ERP: `adapter ERP-QQRORF: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - QMS: `adapter QMS-KKFSSV: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - LMS: `adapter LMS-ORPTUL: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - CMMS: `adapter CMMS-FAEDTG: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - alarmsShown: `16`
  - Screenshot: [exit-demo/item1-1.jpeg](exit-demo/item1-1.jpeg)

### Passed: [DI-31] a stale LMS mirror (no synchronisation for longer than its 60 s bound) refuses the operator's step signature at the kiosk, naming the stale qualification source; once the adapter synchronises again the same signature is accepted @demo

Started 2026-10-17T08:58:28.883Z, 67.1 s.

- **The LMS mirror has not synchronised for longer than its 60 s bound; the operator signs the booth clearance as performed** (2026-10-17T08:59:32.471Z to 2026-10-17T08:59:34.642Z)
  - Expected: The ceremony refuses the signature and names the stale qualification source; nothing is signed
  - Actual: 15 of 15 assertions passed
  - lmsMessage: `1040fd12-d783-4c7e-93a7-bb0072fe2b82`
  - mirror: `{"age":"60","stale":true}`
  - refusal: `You are not authorised to sign this now. Nothing was signed. Why: the signer is not authorised to sign LINE_CLEARANCE_PERFORMED now: [["STALE_QUALIFICATION_SOURCE:TEST-SOP-TWGWGD"]] What you can do: Ask a person who holds the right role and training. Who can help: Your supervisor, QA (role and train`
  - Screenshot: [exit-demo/item1-2.jpeg](exit-demo/item1-2.jpeg)
- **The LMS adapter synchronises again; the operator signs the same step** (2026-10-17T08:59:34.760Z to 2026-10-17T08:59:35.894Z)
  - Expected: The signature is accepted and recorded
  - Actual: 4 of 4 assertions passed
  - signatures: `1`
  - Screenshot: [exit-demo/item1-3.jpeg](exit-demo/item1-3.jpeg)

**PASS**

## 2. A press excursion over OPC UA acknowledged with a comment in the batch's alarm log

Path used: the press's Alarms-and-Conditions REJECT_BURST on the OPC UA feed (OPC UA simulator -> GMP site gateway, its own process, holding the enrolled endpoint -> the GMP server's OPCUA adapter). Not shown: a tag-limit excursion over the gateway's process uplink: the GMP installation has no gateway uplink listener (only the sandbox server has one) and GB-T-03 does not start that path either (D-P6j-b-3); the alarm log and the acknowledgment are the same for both. Arranged: the press in use for the DEMO-ONLY review batch (an open equipment use after its verified cleaning), so the alarm binds to that batch.

### Passed: [DI-49][DI-31][INV-40] a press excursion over OPC UA (the press's REJECT_BURST through the site gateway) binds to the batch using the press and is acknowledged at the kiosk with the action taken and a comment, shown in the batch's alarm log @demo

Started 2026-10-17T08:59:36.035Z, 9.7 s.

- **The press raises REJECT_BURST over OPC UA (through the GMP site gateway); the operator opens the plant alarms at the compression kiosk** (2026-10-17T08:59:44.373Z to 2026-10-17T08:59:44.440Z)
  - Expected: The OPC UA alarm of PRESS-01 is listed, cleared at source, bound to the batch using the press
  - Actual: 3 of 3 assertions passed
  - alarmId: `a7e89fdc-230e-46e7-b4b9-95f5604e14b9`
  - endpointSession: `OPC-COMP-1 SignAndEncrypt Basic256Sha256 COMP-1 PRESS-01 enrolled-certificate`
  - severity: `700`
  - alarmCode: `REJECT_BURST`
  - gmpCritical: `true`
  - boundToBatch: `true`
  - raisedSourceUs: `1792227576084000`
  - clearedSourceUs: `1792227578592000`
  - Screenshot: [exit-demo/item2-1.jpeg](exit-demo/item2-1.jpeg)
- **Acknowledge it with the action taken, a comment and the operator's badge tap** (2026-10-17T08:59:44.444Z to 2026-10-17T08:59:44.723Z)
  - Expected: The alarm is acknowledged and leaves the open list
  - Actual: 3 of 3 assertions passed
  - Screenshot: [exit-demo/item2-2.jpeg](exit-demo/item2-2.jpeg)
- **The head of QC opens the review of the batch** (2026-10-17T08:59:45.356Z to 2026-10-17T08:59:45.676Z)
  - Expected: The batch's alarm log lists the OPC UA alarm with the acknowledgment: who, the action taken and the comment
  - Actual: 3 of 3 assertions passed
  - batch: `GBT260001`
  - acknowledgedAt: `2026-10-17 08:59:44.608351+00`
  - acknowledgedBy: `Priya Nair-wA`
  - Screenshot: [exit-demo/item2-3.jpeg](exit-demo/item2-3.jpeg)

**PASS**

## 3. A serial query (L3)

The L3/L4 simulator is the GMP server's L3 system (EBMR_L3_URL); the server asks it live. Arranged as the L3 server test arranges it: the pool row of the review batch (tab.serial_pool).

### Passed: [PR-42] a serial query: the server asks the L3 system live and answers the serial's lot from the record and its L3 status; an unknown serial is refused @demo

Started 2026-10-17T08:59:45.733Z, 2.8 s.

- **Serial lookup: ask for serial LFUN5H9MVG8V** (2026-10-17T08:59:46.324Z to 2026-10-17T08:59:46.539Z)
  - Expected: The record's lot (the batch number) and the L3 status COMMISSIONED, with the pool and GTIN; no difference reported
  - Actual: 3 of 3 assertions passed
  - serial: `LFUN5H9MVG8V`
  - poolId: `POOL-000001`
  - gtin: `00312345678906`
  - lot: `GBT260001`
  - expiry: `2028-09`
  - status: `Commissioned`
  - Screenshot: [exit-demo/item3-1.jpeg](exit-demo/item3-1.jpeg)
- **Serial lookup: ask for a serial no pool of the record holds (DEMO66B3B78C)** (2026-10-17T08:59:46.543Z to 2026-10-17T08:59:48.483Z)
  - Expected: Refused with its code (the L3 does not know it); nothing is shown as the answer
  - Actual: 3 of 3 assertions passed
  - serial: `DEMO66B3B78C`
  - status: `404`
  - code: `L3-UNKNOWN`
  - why: `no pool holds serial DEMO66B3B78C`
  - Screenshot: [exit-demo/item3-2.jpeg](exit-demo/item3-2.jpeg)

**PASS**

## 4. A mock recall from an API lot to every consignee, signed off by the authorised person

The suite's 6j-b flow as it is: the lot chain (receipt, consumption, finished lot, two ERP distribution records) is arranged as the genealogy server tests arrange it; the explorer, the mock recall and the AP sign-off are the real screens. GB-T-03 shows the same recall with the shipments landed by the ERP adapter (golden job).

### Passed: [PR-57][IN-07] the genealogy explorer traces an API lot forward to the batch, its finished lot and every shipment, as a tree and as a table, and a shipment backward to the API lot @office

Started 2026-10-17T09:00:01.627Z, 2.3 s.

- **Trace the API lot forward** (2026-10-17T09:00:02.872Z to 2026-10-17T09:00:03.602Z)
  - Expected: Lot, batch (consumed), finished lot and both shipments, with their depth; the counts say 2 lots, 1 batch, 2 shipments
  - Actual: 16 of 16 assertions passed
  - rows: `5`
  - Screenshot: [exit-demo/item4-1.jpeg](exit-demo/item4-1.jpeg)
- **Trace the first shipment backward** (2026-10-17T09:00:03.606Z to 2026-10-17T09:00:03.909Z)
  - Expected: From the shipment to the finished lot, the batch and the API lot it consumed
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item4-2.jpeg](exit-demo/item4-2.jpeg)

### Passed: [IN-29][PR-57] the head of QC runs a mock recall from the API lot to every consignee; it reproduces, reconciles delivered against returned, and the authorised person signs it off through the ceremony @office

Started 2026-10-17T09:00:03.954Z, 3.0 s.

- **The head of QC runs a mock recall from the API lot** (2026-10-17T09:00:05.171Z to 2026-10-17T09:00:05.791Z)
  - Expected: The recall reproduces; it lists the batch, the finished lot delivered 650 units with nothing returned, and both consignees with their addresses
  - Actual: 16 of 16 assertions passed
  - consignees: `2`
  - Screenshot: [exit-demo/item4-3.jpeg](exit-demo/item4-3.jpeg)
- **The authorised person signs the mock recall off** (2026-10-17T09:00:06.321Z to 2026-10-17T09:00:06.925Z)
  - Expected: The ceremony signs it; the recall shows who signed it off
  - Actual: 5 of 5 assertions passed
  - signedBy: `Shalini Kapoor-wA`
  - Screenshot: [exit-demo/item4-4.jpeg](exit-demo/item4-4.jpeg)

**PASS**

## 5. Controlled dispensing under dual custody (IN-53 draft banner)

The suite's 6j-b flow as it is. IN-53 is a draft control (NDPS rules not verified; owner decision pending): every screen carries the draft banner.

### Passed: [IN-53] controlled dispensing under dual custody: QA flags the product and a second QA person approves; the stores person proposes and signs first, cannot countersign; a verifier at the kiosk countersigns @office

Started 2026-10-17T08:59:48.522Z, 7.7 s.

- **QA records the controlled-substance flag of the product for the controlled API material, under the change record** (2026-10-17T08:59:49.689Z to 2026-10-17T08:59:50.361Z)
  - Expected: The draft banner is on the screen; the flag is recorded and awaits a second QA person
  - Actual: 7 of 7 assertions passed
  - Screenshot: [exit-demo/item5-1.jpeg](exit-demo/item5-1.jpeg)
- **A second QA person approves the flag through the ceremony** (2026-10-17T08:59:51.008Z to 2026-10-17T08:59:51.576Z)
  - Expected: The flag is APPROVED and in effect for the material
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item5-2.jpeg](exit-demo/item5-2.jpeg)
- **The issuer plans a GB-T-01 batch from the open order and issues it through the ceremony** (2026-10-17T08:59:51.652Z to 2026-10-17T08:59:52.827Z)
  - Expected: The batch is issued
  - Actual: 7 of 7 assertions passed
  - batchNumber: `GBT260002`
  - Screenshot: [exit-demo/item5-3.jpeg](exit-demo/item5-3.jpeg)
- **The stores person proposes the dispensing of 2.500 kg of the controlled lot to the batch and signs as the first custodian** (2026-10-17T08:59:53.422Z to 2026-10-17T08:59:54.226Z)
  - Expected: The dispensing names the batch; after the first signature it awaits the second custodian
  - Actual: 12 of 12 assertions passed
  - Screenshot: [exit-demo/item5-4.jpeg](exit-demo/item5-4.jpeg)
- **The same person tries to countersign as the second custodian** (2026-10-17T08:59:54.227Z to 2026-10-17T08:59:54.562Z)
  - Expected: The ceremony refuses it: one person never fills both places; the record still awaits the second custodian
  - Actual: 3 of 3 assertions passed
  - refusal: `This signature must come from a person other than those who signed before it. Nothing was signed. Why: CONTROLLED_CUSTODY_COUNTERSIGNED must be signed by a person other than the signers of {CONTROLLED`
  - Screenshot: [exit-demo/item5-5.jpeg](exit-demo/item5-5.jpeg)
- **A verifier at the dispensing kiosk countersigns as the second custodian (badge and PIN)** (2026-10-17T08:59:55.340Z to 2026-10-17T08:59:56.224Z)
  - Expected: The dispensing is CONFIRMED with two different custodians
  - Actual: 9 of 9 assertions passed
  - state: `CONFIRMED`
  - Screenshot: [exit-demo/item5-6.jpeg](exit-demo/item5-6.jpeg)

**PASS**

## 6. English step screens

The suite's 6j-b flow as it is (decision 0018: English only).

### Passed: the step screen is in English: the page declares English, offers no other language, writes Western digits and dates as 27-SEP-2026 @kiosk

Started 2026-10-17T08:59:56.268Z, 5.3 s.

- **Open the booth clearance step on the kiosk** (2026-10-17T08:59:59.407Z to 2026-10-17T08:59:59.445Z)
  - Expected: The page declares English and offers no language choice; the step card reads in English
  - Actual: 5 of 5 assertions passed
  - lang: `en`
  - Screenshot: [exit-demo/item6-1.jpeg](exit-demo/item6-1.jpeg)
- **Start the step and record its entries** (2026-10-17T08:59:59.448Z to 2026-10-17T09:00:01.576Z)
  - Expected: Every saved entry is confirmed in English; dates read as 27-SEP-2026 and every digit is a Western digit
  - Actual: 15 of 15 assertions passed
  - recordDate: `17-OCT-2026`
  - Screenshot: [exit-demo/item6-2.jpeg](exit-demo/item6-2.jpeg)

**PASS**

## 7. A lot transferred between two sites (two installations) and accepted by local QA

Two GMP servers (PUNE, GOA), each on its own database with its own installation key, listening on HTTP, as the 6i route tests run them; the exchange goes over HTTP between them. Arranged (deployment steps): the installation identities and proposed peers, the released intermediate lot at PUNE. Not through the browser: the transfer screens exist, but the two-installation browser stack is not built (the E2E stack has one GMP and one sandbox installation).

Run by vitest (apps/tablets-server/test/demo/transfer.demo.ts): exit code 0.

- **Two installations trust each other (QA approved each peer key through the ceremony)** (2026-10-17T08:44:38.938Z)
  - pune: `PUNE-599A http://127.0.0.1:34845`
  - goa: `GOA-599A http://127.0.0.1:46077`
  - puneSees: `GOA-599A APPROVED`
- **PUNE stores seal a package of the released intermediate lot for GOA (100 kg)** (2026-10-17T08:44:38.973Z)
  - lot: `INT-599A`
  - packageNo: `INT-599A/T1`
  - packageId: `383c8ba9-e58c-4e48-ba35-cfd07785f28c`
  - sealed: `true`
  - seal: `+1M3K9wV7+L/15LUgleG/9P+qeK1elR68dCLEhUE6o0ISPGX79uhyhLF66DfaC4f`
- **GOA stores take in a copy whose quantity was changed to 400** (2026-10-17T08:44:39.003Z)
  - outcome: `REFUSED`
  - kind: `TAMPERED`
  - alarmKind: `TAMPERED`
  - alarmSeverity: `MAJOR`
  - alarmPath: `TRANSFER_IMPORT`
- **GOA stores take in the genuine package** (2026-10-17T08:44:39.035Z)
  - outcome: `RECEIVED`
  - receiptId: `8c9dcf57-c93a-4ba8-af2e-445a65eb4472`
  - origin: `PUNE-599A`
  - originState: `RELEASED_FOR_FURTHER_PROCESSING`
  - lotState: `QUARANTINE`
  - state: `RECEIVED`
  - quantity: `100`
  - holdRemainingSeconds: `69693320`
- **GOA stores take in the same package a second time** (2026-10-17T08:44:39.054Z)
  - outcome: `REFUSED`
  - kind: `DUPLICATE`
- **GOA stores try to accept the receipt** (2026-10-17T08:44:39.061Z)
  - ok: `false`
  - refusal: `ESIG_PREVIEW_NOT_ALLOWED`
- **GOA QA accepts the receipt through the ceremony (TRANSFER_RECEIPT_DECIDE)** (2026-10-17T08:44:39.114Z)
  - ok: `true`
  - signature: `{"manifestation":{"signatureId":"1d4c9ef3-efea-41cc-8c80-eafd3dc78ab6","signer":{"personId":"59facbe6-2758-4608-89f8-4da8bc0da992","legalName":"Divya Menon","loginName":"divya.menon","role":"QA_REVIEW`
  - state: `ACCEPTED`
  - decision: `ACCEPTED`
  - decidedBy: `{"decision":"ACCEPTED","reason":null,"by":{"personId":"59facbe6-2758-4608-89f8-4da8bc0da992","legalName":"Divya Menon","loginName":"divya.menon","role":"QA"},"at":{"us":"1792226679109618","text":"17-O`
  - lotState: `QUARANTINE`
- **PUNE traces its lot forward across the transfer** (2026-10-17T08:44:39.191Z)
  - complete: `true`
  - localEdges: `LOT:null TRANSFER:TRANSFERRED`
  - remotePeer: `GOA-599A`
  - remoteStatus: `ANSWERED`
  - remoteEdges: `TRANSFER:null LOT:TRANSFER_RECEIVED`
**PASS**

