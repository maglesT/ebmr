# Phase 6 exit demo, record

Run 2026-10-17T06:19:55.074Z to 2026-10-17T06:36:38.848Z (UTC), commit 5800f7dc, by `pnpm demo:phase6-exit` (tools/e2e/demo/run.ts). Written by the run; re-running replaces this file and the screenshots.

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

Screenshots: 20 files, 1396 KiB in exit-demo/.

## 1. ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk

Faults: each system is its simulator process; each adapter is started by the GMP server itself from its service-keys file (MIRROR mode; the integrations feature and its adapter workers are GMP's) and pulls on its own 5 s timer. The demo only publishes on the simulators and switches their faults (POST /api/fault). Stale mirror: the step signature is on a TEST- batch at the sandbox kiosk (as in 6j-b); no adapter worker runs on the sandbox, so its LMS training arrives through the adapter's receiving command, called as the registered adapter identity. The staleness is real time: the LMS mirror bound is set to its minimum (60 s, a change-controlled setting) and no synchronisation follows until it has passed. Arranged in the database as the 6j-b flows do: the training coordinator's product requirement, the employee numbers, the change record. By design a same-key, same-hash resend is recorded as DEDUPLICATED without an alarm (an alarm is raised for a same key with a different hash), and a cut link is a TRANSPORT failure that is retried, not recorded as a refusal or alarm; the worker's error shows on the adapter page. The SEQUENCE_GAP alarms in the counts were raised by the adapters during the fault sequences (each listed per system).

### Passed: [DI-31][DI-20] the ERP, QMS, LMS and CMMS exchange data under injected faults (malformed, duplicate, out of order, link cut): each refused or de-duplicated with an alarm, no partial value, the count reconciles @demo

Started 2026-10-17T06:31:57.129Z, 178.9 s.

- **ERP: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:31:58.174Z to 2026-10-17T06:32:00.708Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `ERP-RUHLXN`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **ERP: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:32:00.709Z to 2026-10-17T06:32:05.737Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the erp.material_master v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `0e0fe9f9-8a16-4854-89e6-f3d97d69ed36`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **ERP: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:32:05.737Z to 2026-10-17T06:32:15.774Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **ERP: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:32:15.775Z to 2026-10-17T06:32:20.798Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `cce4eefa-05ae-402f-9e91-f224db63fd69`
- **ERP: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:32:20.798Z to 2026-10-17T06:32:40.841Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `MAT-DEMO-UJYEN-6`
  - payloadHash: `fe13ce6dd7523e33fc9e04810866c6392194b0c11fd8e1d68e9d30229215dbe5`
- **ERP: reconciliation of the run (no silent loss)** (2026-10-17T06:32:40.842Z to 2026-10-17T06:32:40.848Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **QMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:32:40.849Z to 2026-10-17T06:32:45.872Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `QMS-UMVPBD`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **QMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:32:45.873Z to 2026-10-17T06:32:50.404Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the qms.capa v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `c6ae92ce-a5fe-460b-b1b2-be0e86867d9a`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **QMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:32:50.404Z to 2026-10-17T06:33:00.448Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **QMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:33:00.449Z to 2026-10-17T06:33:05.478Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `d5a92ebc-8a70-453b-837c-04f8bf07d2d9`
- **QMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:33:05.478Z to 2026-10-17T06:33:25.510Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `CAPA-DEMO-UJYEN-12`
  - payloadHash: `a1f9bf06bb2b9ee2f91503a30fee6e75560ab6e4f5c973a9e8d220073a9c1f0a`
- **QMS: reconciliation of the run (no silent loss)** (2026-10-17T06:33:25.511Z to 2026-10-17T06:33:25.516Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **LMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:33:25.516Z to 2026-10-17T06:33:30.539Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `LMS-MGQTNE`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **LMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:33:30.539Z to 2026-10-17T06:33:35.570Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the lms.qualification v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `e6b8886e-9d6d-4826-86ad-f7532a9254fc`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **LMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:33:35.571Z to 2026-10-17T06:33:45.610Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **LMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:33:45.611Z to 2026-10-17T06:33:50.631Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `5536de12-42ba-4446-829e-9d8bcf0fb8c9`
- **LMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:33:50.631Z to 2026-10-17T06:34:10.655Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `EMP-UJYEN/SOP-DEMO-UJYEN-6`
  - payloadHash: `7c7dd324155228251dc5df2b9f74826d20bf56e0ba66d7efb5445e430b42fb32`
- **LMS: reconciliation of the run (no silent loss)** (2026-10-17T06:34:10.655Z to 2026-10-17T06:34:10.662Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **CMMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:34:10.663Z to 2026-10-17T06:34:15.685Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `CMMS-XZRRFT`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **CMMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:34:15.686Z to 2026-10-17T06:34:20.711Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the cmms.maintenance v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `0914b9ca-6d84-4a66-b61a-814a19738c05`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **CMMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:34:20.712Z to 2026-10-17T06:34:30.754Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **CMMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:34:30.754Z to 2026-10-17T06:34:35.782Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `511604bd-b907-4c9a-a8f1-09c6a0142d62`
- **CMMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:34:35.782Z to 2026-10-17T06:34:55.811Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `BAL-BLEND-01/WO-DEMO-UJYEN-24`
  - payloadHash: `0196fc4119a93968824944a1c9768ef231a93709d54af5a795a13aaaa6b18a76`
- **CMMS: reconciliation of the run (no silent loss)** (2026-10-17T06:34:55.812Z to 2026-10-17T06:34:55.815Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **The integration health page lists the four adapters and the integration alarms the faults raised** (2026-10-17T06:34:55.815Z to 2026-10-17T06:34:56.033Z)
  - Expected: Every adapter is listed with its worker; the alarms of the faults are shown
  - Actual: 6 of 6 assertions passed
  - ERP: `adapter ERP-RUHLXN: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - QMS: `adapter QMS-UMVPBD: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - LMS: `adapter LMS-MGQTNE: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - CMMS: `adapter CMMS-XZRRFT: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - alarmsShown: `16`
  - Screenshot: [exit-demo/item1-1.jpeg](exit-demo/item1-1.jpeg)

### Passed: [DI-31] a stale LMS mirror (no synchronisation for longer than its 60 s bound) refuses the operator's step signature at the kiosk, naming the stale qualification source; once the adapter synchronises again the same signature is accepted @demo

Started 2026-10-17T06:34:56.129Z, 68.4 s.

- **The LMS mirror has not synchronised for longer than its 60 s bound; the operator signs the booth clearance as performed** (2026-10-17T06:36:00.462Z to 2026-10-17T06:36:02.923Z)
  - Expected: The ceremony refuses the signature and names the stale qualification source; nothing is signed
  - Actual: 15 of 15 assertions passed
  - lmsMessage: `55210c3e-6b1a-4cf3-ad61-bb1b8215e500`
  - mirror: `{"age":"60","stale":true}`
  - refusal: `You are not authorised to sign this now. Nothing was signed. Why: the signer is not authorised to sign LINE_CLEARANCE_PERFORMED now: [["STALE_QUALIFICATION_SOURCE:TEST-SOP-AFXMGD"]] What you can do: Ask a person who holds the right role and training. Who can help: Your supervisor, QA (role and train`
  - Screenshot: [exit-demo/item1-2.jpeg](exit-demo/item1-2.jpeg)
- **The LMS adapter synchronises again; the operator signs the same step** (2026-10-17T06:36:03.066Z to 2026-10-17T06:36:04.327Z)
  - Expected: The signature is accepted and recorded
  - Actual: 4 of 4 assertions passed
  - signatures: `1`
  - Screenshot: [exit-demo/item1-3.jpeg](exit-demo/item1-3.jpeg)

**PASS**

## 2. A press excursion over OPC UA acknowledged with a comment in the batch's alarm log

Path used: the press's Alarms-and-Conditions REJECT_BURST on the OPC UA feed (OPC UA simulator -> GMP site gateway, its own process, holding the enrolled endpoint -> the GMP server's OPCUA adapter). Not shown: a tag-limit excursion over the gateway's process uplink: the GMP installation has no gateway uplink listener (only the sandbox server has one) and GB-T-03 does not start that path either (D-P6j-b-3); the alarm log and the acknowledgment are the same for both. Arranged: the press in use for the DEMO-ONLY review batch (an open equipment use after its verified cleaning), so the alarm binds to that batch.

### Passed: [DI-49][DI-31][INV-40] a press excursion over OPC UA (the press's REJECT_BURST through the site gateway) binds to the batch using the press and is acknowledged at the kiosk with the action taken and a comment, shown in the batch's alarm log @demo

Started 2026-10-17T06:36:04.500Z, 8.6 s.

- **The press raises REJECT_BURST over OPC UA (through the GMP site gateway); the operator opens the plant alarms at the compression kiosk** (2026-10-17T06:36:11.472Z to 2026-10-17T06:36:11.573Z)
  - Expected: The OPC UA alarm of PRESS-01 is listed, cleared at source, bound to the batch using the press
  - Actual: 3 of 3 assertions passed
  - alarmId: `52c4bb95-d2f3-4cfc-9a79-93b72db9569c`
  - endpointSession: `OPC-COMP-1 SignAndEncrypt Basic256Sha256 COMP-1 PRESS-01 enrolled-certificate`
  - severity: `700`
  - alarmCode: `REJECT_BURST`
  - gmpCritical: `true`
  - boundToBatch: `true`
  - raisedSourceUs: `1792218964554000`
  - clearedSourceUs: `1792218965562000`
  - Screenshot: [exit-demo/item2-1.jpeg](exit-demo/item2-1.jpeg)
- **Acknowledge it with the action taken, a comment and the operator's badge tap** (2026-10-17T06:36:11.578Z to 2026-10-17T06:36:11.904Z)
  - Expected: The alarm is acknowledged and leaves the open list
  - Actual: 3 of 3 assertions passed
  - Screenshot: [exit-demo/item2-2.jpeg](exit-demo/item2-2.jpeg)
- **The head of QC opens the review of the batch** (2026-10-17T06:36:12.638Z to 2026-10-17T06:36:12.999Z)
  - Expected: The batch's alarm log lists the OPC UA alarm with the acknowledgment: who, the action taken and the comment
  - Actual: 3 of 3 assertions passed
  - batch: `GBT260001`
  - acknowledgedAt: `2026-10-17 06:36:11.796474+00`
  - acknowledgedBy: `Priya Nair-wA`
  - Screenshot: [exit-demo/item2-3.jpeg](exit-demo/item2-3.jpeg)

**PASS**

## 3. A serial query (L3)

The L3/L4 simulator is the GMP server's L3 system (EBMR_L3_URL); the server asks it live. Arranged as the L3 server test arranges it: the pool row of the review batch (tab.serial_pool).

### Passed: [PR-42] a serial query: the server asks the L3 system live and answers the serial's lot from the record and its L3 status; an unknown serial is refused @demo

Started 2026-10-17T06:36:13.077Z, 3.0 s.

- **Serial lookup: ask for serial LFUN5H9MVG8V** (2026-10-17T06:36:13.778Z to 2026-10-17T06:36:14.042Z)
  - Expected: The record's lot (the batch number) and the L3 status COMMISSIONED, with the pool and GTIN; no difference reported
  - Actual: 3 of 3 assertions passed
  - serial: `LFUN5H9MVG8V`
  - poolId: `POOL-000001`
  - gtin: `00312345678906`
  - lot: `GBT260001`
  - expiry: `2028-09`
  - status: `Commissioned`
  - Screenshot: [exit-demo/item3-1.jpeg](exit-demo/item3-1.jpeg)
- **Serial lookup: ask for a serial no pool of the record holds (DEMO41B36748)** (2026-10-17T06:36:14.043Z to 2026-10-17T06:36:16.017Z)
  - Expected: Refused with its code (the L3 does not know it); nothing is shown as the answer
  - Actual: 3 of 3 assertions passed
  - serial: `DEMO41B36748`
  - status: `404`
  - code: `L3-UNKNOWN`
  - why: `no pool holds serial DEMO41B36748`
  - Screenshot: [exit-demo/item3-2.jpeg](exit-demo/item3-2.jpeg)

**PASS**

## 4. A mock recall from an API lot to every consignee, signed off by the authorised person

The suite's 6j-b flow as it is: the lot chain (receipt, consumption, finished lot, two ERP distribution records) is arranged as the genealogy server tests arrange it; the explorer, the mock recall and the AP sign-off are the real screens. GB-T-03 shows the same recall with the shipments landed by the ERP adapter (golden job).

### Passed: [PR-57][IN-07] the genealogy explorer traces an API lot forward to the batch, its finished lot and every shipment, as a tree and as a table, and a shipment backward to the API lot @office

Started 2026-10-17T06:36:31.365Z, 2.8 s.

- **Trace the API lot forward** (2026-10-17T06:36:32.852Z to 2026-10-17T06:36:33.833Z)
  - Expected: Lot, batch (consumed), finished lot and both shipments, with their depth; the counts say 2 lots, 1 batch, 2 shipments
  - Actual: 16 of 16 assertions passed
  - rows: `5`
  - Screenshot: [exit-demo/item4-1.jpeg](exit-demo/item4-1.jpeg)
- **Trace the first shipment backward** (2026-10-17T06:36:33.833Z to 2026-10-17T06:36:34.175Z)
  - Expected: From the shipment to the finished lot, the batch and the API lot it consumed
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item4-2.jpeg](exit-demo/item4-2.jpeg)

### Passed: [IN-29][PR-57] the head of QC runs a mock recall from the API lot to every consignee; it reproduces, reconciles delivered against returned, and the authorised person signs it off through the ceremony @office

Started 2026-10-17T06:36:34.229Z, 3.8 s.

- **The head of QC runs a mock recall from the API lot** (2026-10-17T06:36:35.751Z to 2026-10-17T06:36:36.544Z)
  - Expected: The recall reproduces; it lists the batch, the finished lot delivered 650 units with nothing returned, and both consignees with their addresses
  - Actual: 16 of 16 assertions passed
  - consignees: `2`
  - Screenshot: [exit-demo/item4-3.jpeg](exit-demo/item4-3.jpeg)
- **The authorised person signs the mock recall off** (2026-10-17T06:36:37.230Z to 2026-10-17T06:36:37.932Z)
  - Expected: The ceremony signs it; the recall shows who signed it off
  - Actual: 5 of 5 assertions passed
  - signedBy: `Shalini Kapoor-wA`
  - Screenshot: [exit-demo/item4-4.jpeg](exit-demo/item4-4.jpeg)

**PASS**

## 5. Controlled dispensing under dual custody (IN-53 draft banner)

The suite's 6j-b flow as it is. IN-53 is a draft control (NDPS rules not verified; owner decision pending): every screen carries the draft banner.

### Passed: [IN-53] controlled dispensing under dual custody: QA flags the product and a second QA person approves; the stores person proposes and signs first, cannot countersign; a verifier at the kiosk countersigns @office

Started 2026-10-17T06:36:16.076Z, 9.2 s.

- **QA records the controlled-substance flag of the product for the controlled API material, under the change record** (2026-10-17T06:36:17.711Z to 2026-10-17T06:36:18.737Z)
  - Expected: The draft banner is on the screen; the flag is recorded and awaits a second QA person
  - Actual: 7 of 7 assertions passed
  - Screenshot: [exit-demo/item5-1.jpeg](exit-demo/item5-1.jpeg)
- **A second QA person approves the flag through the ceremony** (2026-10-17T06:36:19.617Z to 2026-10-17T06:36:20.173Z)
  - Expected: The flag is APPROVED and in effect for the material
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item5-2.jpeg](exit-demo/item5-2.jpeg)
- **The issuer plans a GB-T-01 batch from the open order and issues it through the ceremony** (2026-10-17T06:36:20.270Z to 2026-10-17T06:36:21.525Z)
  - Expected: The batch is issued
  - Actual: 7 of 7 assertions passed
  - batchNumber: `GBT260002`
  - Screenshot: [exit-demo/item5-3.jpeg](exit-demo/item5-3.jpeg)
- **The stores person proposes the dispensing of 2.500 kg of the controlled lot to the batch and signs as the first custodian** (2026-10-17T06:36:22.341Z to 2026-10-17T06:36:23.250Z)
  - Expected: The dispensing names the batch; after the first signature it awaits the second custodian
  - Actual: 12 of 12 assertions passed
  - Screenshot: [exit-demo/item5-4.jpeg](exit-demo/item5-4.jpeg)
- **The same person tries to countersign as the second custodian** (2026-10-17T06:36:23.252Z to 2026-10-17T06:36:23.641Z)
  - Expected: The ceremony refuses it: one person never fills both places; the record still awaits the second custodian
  - Actual: 3 of 3 assertions passed
  - refusal: `This signature must come from a person other than those who signed before it. Nothing was signed. Why: CONTROLLED_CUSTODY_COUNTERSIGNED must be signed by a person other than the signers of {CONTROLLED`
  - Screenshot: [exit-demo/item5-5.jpeg](exit-demo/item5-5.jpeg)
- **A verifier at the dispensing kiosk countersigns as the second custodian (badge and PIN)** (2026-10-17T06:36:24.455Z to 2026-10-17T06:36:25.256Z)
  - Expected: The dispensing is CONFIRMED with two different custodians
  - Actual: 9 of 9 assertions passed
  - state: `CONFIRMED`
  - Screenshot: [exit-demo/item5-6.jpeg](exit-demo/item5-6.jpeg)

**PASS**

## 6. English step screens

The suite's 6j-b flow as it is (decision 0018: English only).

### Passed: the step screen is in English: the page declares English, offers no other language, writes Western digits and dates as 27-SEP-2026 @kiosk

Started 2026-10-17T06:36:25.319Z, 6.0 s.

- **Open the booth clearance step on the kiosk** (2026-10-17T06:36:28.833Z to 2026-10-17T06:36:28.888Z)
  - Expected: The page declares English and offers no language choice; the step card reads in English
  - Actual: 5 of 5 assertions passed
  - lang: `en`
  - Screenshot: [exit-demo/item6-1.jpeg](exit-demo/item6-1.jpeg)
- **Start the step and record its entries** (2026-10-17T06:36:28.889Z to 2026-10-17T06:36:31.307Z)
  - Expected: Every saved entry is confirmed in English; dates read as 27-SEP-2026 and every digit is a Western digit
  - Actual: 15 of 15 assertions passed
  - recordDate: `17-OCT-2026`
  - Screenshot: [exit-demo/item6-2.jpeg](exit-demo/item6-2.jpeg)

**PASS**

## 7. A lot transferred between two sites (two installations) and accepted by local QA

Two GMP servers (PUNE, GOA), each on its own database with its own installation key, listening on HTTP, as the 6i route tests run them; the exchange goes over HTTP between them. Arranged (deployment steps): the installation identities and proposed peers, the released intermediate lot at PUNE. Not through the browser: the transfer screens exist, but the two-installation browser stack is not built (the E2E stack has one GMP and one sandbox installation).

Run by vitest (apps/tablets-server/test/demo/transfer.demo.ts): exit code 0.

- **Two installations trust each other (QA approved each peer key through the ceremony)** (2026-10-17T06:20:24.214Z)
  - pune: `PUNE-E26A http://127.0.0.1:35433`
  - goa: `GOA-E26A http://127.0.0.1:45519`
  - puneSees: `GOA-E26A APPROVED`
- **PUNE stores seal a package of the released intermediate lot for GOA (100 kg)** (2026-10-17T06:20:24.405Z)
  - lot: `INT-E26A`
  - packageNo: `INT-E26A/T1`
  - packageId: `963abd42-7f13-4887-b715-a4e51c61ae27`
  - sealed: `true`
  - seal: `/GfcmXtEycSFscOBCI+jwqRFRD1SON5VnnEypjIpNWtoiWzYlgnynZ1N7tggb2rg`
- **GOA stores take in a copy whose quantity was changed to 400** (2026-10-17T06:20:24.561Z)
  - outcome: `REFUSED`
  - kind: `TAMPERED`
  - alarmKind: `TAMPERED`
  - alarmSeverity: `MAJOR`
  - alarmPath: `TRANSFER_IMPORT`
- **GOA stores take in the genuine package** (2026-10-17T06:20:24.747Z)
  - outcome: `RECEIVED`
  - receiptId: `a7156c7b-80fc-499e-ae7f-041d0568cbb2`
  - origin: `PUNE-E26A`
  - originState: `RELEASED_FOR_FURTHER_PROCESSING`
  - lotState: `QUARANTINE`
  - state: `RECEIVED`
  - quantity: `100`
  - holdRemainingSeconds: `69701975`
- **GOA stores take in the same package a second time** (2026-10-17T06:20:24.923Z)
  - outcome: `REFUSED`
  - kind: `DUPLICATE`
- **GOA stores try to accept the receipt** (2026-10-17T06:20:24.939Z)
  - ok: `false`
  - refusal: `ESIG_PREVIEW_NOT_ALLOWED`
- **GOA QA accepts the receipt through the ceremony (TRANSFER_RECEIPT_DECIDE)** (2026-10-17T06:20:25.271Z)
  - ok: `true`
  - signature: `{"manifestation":{"signatureId":"11ab501f-52b3-46ea-ad58-3d70f4aebf42","signer":{"personId":"5dba4408-3092-4803-960d-e17e4f739486","legalName":"Divya Menon","loginName":"divya.menon","role":"QA_REVIEW`
  - state: `ACCEPTED`
  - decision: `ACCEPTED`
  - decidedBy: `{"decision":"ACCEPTED","reason":null,"by":{"personId":"5dba4408-3092-4803-960d-e17e4f739486","legalName":"Divya Menon","loginName":"divya.menon","role":"QA"},"at":{"us":"1792218025261304","text":"17-O`
  - lotState: `QUARANTINE`
- **PUNE traces its lot forward across the transfer** (2026-10-17T06:20:25.647Z)
  - complete: `true`
  - localEdges: `LOT:null TRANSFER:TRANSFERRED`
  - remotePeer: `GOA-E26A`
  - remoteStatus: `ANSWERED`
  - remoteEdges: `TRANSFER:null LOT:TRANSFER_RECEIVED`
**PASS**

