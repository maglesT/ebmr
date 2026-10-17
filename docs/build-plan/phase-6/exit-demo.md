# Phase 6 exit demo, record

Run 2026-10-17T06:01:25.289Z to 2026-10-17T06:18:43.532Z (UTC), commit 3c19aae3, by `pnpm demo:phase6-exit` (tools/e2e/demo/run.ts). Written by the run; re-running replaces this file and the screenshots.

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

Started 2026-10-17T06:13:46.985Z, 178.9 s.

- **ERP: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:13:48.360Z to 2026-10-17T06:13:50.415Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `ERP-GMZVWX`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **ERP: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:13:50.415Z to 2026-10-17T06:13:55.475Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the erp.material_master v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `098f95da-5cef-4644-a88a-60625a1fd139`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **ERP: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:13:55.475Z to 2026-10-17T06:14:05.556Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **ERP: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:14:05.556Z to 2026-10-17T06:14:10.619Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `4b4b13b3-26a9-4c3d-9742-d307232330bd`
- **ERP: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:14:10.620Z to 2026-10-17T06:14:30.172Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `MAT-DEMO-RKMAE-6`
  - payloadHash: `5be84eed8ab16a1896633ed61f388a32fb882d3a87a1ec606aca83fe6fd71f87`
- **ERP: reconciliation of the run (no silent loss)** (2026-10-17T06:14:30.173Z to 2026-10-17T06:14:30.182Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **QMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:14:30.188Z to 2026-10-17T06:14:35.232Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `QMS-EBOESU`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **QMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:14:35.233Z to 2026-10-17T06:14:40.269Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the qms.capa v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `082a42d1-91a8-4d4f-acb2-0318159ed7d1`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **QMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:14:40.269Z to 2026-10-17T06:14:50.314Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **QMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:14:50.317Z to 2026-10-17T06:14:55.382Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `7355fb32-921d-4324-bd14-6c7db5acc31b`
- **QMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:14:55.383Z to 2026-10-17T06:15:15.460Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `CAPA-DEMO-RKMAE-12`
  - payloadHash: `1a0c7e0ac277069f33b2dbffabe1c74d9fb101eacbe86cacd89df4f537269eab`
- **QMS: reconciliation of the run (no silent loss)** (2026-10-17T06:15:15.461Z to 2026-10-17T06:15:15.474Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **LMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:15:15.474Z to 2026-10-17T06:15:20.555Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `LMS-ZOOPLM`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **LMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:15:20.555Z to 2026-10-17T06:15:25.600Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the lms.qualification v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `cca2c1e0-95e4-40f1-be36-b87541ae494e`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **LMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:15:25.601Z to 2026-10-17T06:15:35.171Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **LMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:15:35.171Z to 2026-10-17T06:15:40.230Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `6f1f8e36-2fe0-4169-8825-db3b13a5082e`
- **LMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:15:40.230Z to 2026-10-17T06:16:00.273Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `EMP-RKMAE/SOP-DEMO-RKMAE-6`
  - payloadHash: `24449095f72b4c7a7726645d216ee14459958e25464411273e84a4eadb0d9e2b`
- **LMS: reconciliation of the run (no silent loss)** (2026-10-17T06:16:00.273Z to 2026-10-17T06:16:00.278Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **CMMS: a clean message reaches the eBMR through the adapter the server started** (2026-10-17T06:16:00.279Z to 2026-10-17T06:16:05.306Z)
  - Expected: Accepted (one inbound message more)
  - Actual: 1 of 1 assertion passed
  - adapter: `CMMS-PNAABN`
  - acceptedBefore: `0`
  - acceptedAfter: `1`
- **CMMS: MALFORMED (the payload carries a field outside the contract)** (2026-10-17T06:16:05.307Z to 2026-10-17T06:16:10.350Z)
  - Expected: Refused as MALFORMED with an integration alarm; nothing of it lands
  - Actual: 3 of 3 assertions passed
  - errorClass: `MALFORMED`
  - refusal: `the cmms.maintenance v1 payload does not match the contract: : Unrecognized key: "simulatorExtra"`
  - alarmId: `2208445a-3029-44b0-abf0-ade6efd27c9d`
  - malformedAlarms: `1`
  - acceptedUnchanged: `true`
- **CMMS: DUPLICATE (every page delivers the last message again, same key and hash)** (2026-10-17T06:16:10.350Z to 2026-10-17T06:16:20.410Z)
  - Expected: The resend is de-duplicated (recorded, not applied twice); the new message is accepted once
  - Actual: 1 of 1 assertion passed
  - deduplicatedBefore: `0`
  - deduplicatedAfter: `1`
  - acceptedNew: `1`
  - duplicateAlarms: `0`
- **CMMS: OUT_OF_ORDER (a page arrives in reverse order)** (2026-10-17T06:16:20.410Z to 2026-10-17T06:16:25.462Z)
  - Expected: An OUT_OF_ORDER integration alarm; each message accepted once, none lost
  - Actual: 2 of 2 assertions passed
  - published: `2`
  - accepted: `2`
  - refused: `0`
  - outOfOrderAlarms: `1`
  - alarmId: `0b823f30-6a47-4970-8be3-416bcb15ae49`
- **CMMS: LINK_CUT (the answer is cut off mid-transfer)** (2026-10-17T06:16:25.463Z to 2026-10-17T06:16:45.512Z)
  - Expected: Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole
  - Actual: 2 of 2 assertions passed
  - acceptedWhileCut: `0`
  - acceptedAfterLinkBack: `1`
  - transportAlarms: `0`
  - sourceRecord: `BAL-BLEND-01/WO-DEMO-RKMAE-24`
  - payloadHash: `9882744b5fe65ca4104e055987a8731908a57d53aa01653fa8034f592a9bbd4f`
- **CMMS: reconciliation of the run (no silent loss)** (2026-10-17T06:16:45.512Z to 2026-10-17T06:16:45.518Z)
  - Expected: Distinct messages the source published = accepted + refused; every refusal has an alarm
  - Actual: 2 of 2 assertions passed
  - publishedBySource: `6`
  - accepted: `5`
  - refused: `1`
  - deduplicated: `1`
  - refusalsWithoutAlarm: `0`
  - alarms: `{"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
- **The integration health page lists the four adapters and the integration alarms the faults raised** (2026-10-17T06:16:45.518Z to 2026-10-17T06:16:45.870Z)
  - Expected: Every adapter is listed with its worker; the alarms of the faults are shown
  - Actual: 6 of 6 assertions passed
  - ERP: `adapter ERP-GMZVWX: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - QMS: `adapter QMS-EBOESU: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - LMS: `adapter LMS-ZOOPLM: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - CMMS: `adapter CMMS-PNAABN: accepted 5, refused 1, de-duplicated 1, alarms {"MALFORMED":1,"OUT_OF_ORDER":1,"SEQUENCE_GAP":2}`
  - alarmsShown: `16`
  - Screenshot: [exit-demo/item1-1.jpeg](exit-demo/item1-1.jpeg)

### Passed: [DI-31] a stale LMS mirror (no synchronisation for longer than its 60 s bound) refuses the operator's step signature at the kiosk, naming the stale qualification source; once the adapter synchronises again the same signature is accepted @demo

Started 2026-10-17T06:16:45.973Z, 71.9 s.

- **The LMS mirror has not synchronised for longer than its 60 s bound; the operator signs the booth clearance as performed** (2026-10-17T06:17:52.161Z to 2026-10-17T06:17:55.691Z)
  - Expected: The ceremony refuses the signature and names the stale qualification source; nothing is signed
  - Actual: 15 of 15 assertions passed
  - lmsMessage: `8fdeedf7-b7c0-49ee-a83c-0e903a8f45ee`
  - mirror: `{"age":"60","stale":true}`
  - refusal: `You are not authorised to sign this now. Nothing was signed. Why: the signer is not authorised to sign LINE_CLEARANCE_PERFORMED now: [["STALE_QUALIFICATION_SOURCE:TEST-SOP-TTFJVX"]] What you can do: Ask a person who holds the right role and training. Who can help: Your supervisor, QA (role and train`
  - Screenshot: [exit-demo/item1-2.jpeg](exit-demo/item1-2.jpeg)
- **The LMS adapter synchronises again; the operator signs the same step** (2026-10-17T06:17:55.903Z to 2026-10-17T06:17:57.671Z)
  - Expected: The signature is accepted and recorded
  - Actual: 4 of 4 assertions passed
  - signatures: `1`
  - Screenshot: [exit-demo/item1-3.jpeg](exit-demo/item1-3.jpeg)

**PASS**

## 2. A press excursion over OPC UA acknowledged with a comment in the batch's alarm log

Path used: the press's Alarms-and-Conditions REJECT_BURST on the OPC UA feed (OPC UA simulator -> GMP site gateway, its own process, holding the enrolled endpoint -> the GMP server's OPCUA adapter). Not shown: a tag-limit excursion over the gateway's process uplink: the GMP installation has no gateway uplink listener (only the sandbox server has one) and GB-T-03 does not start that path either (D-P6j-b-3); the alarm log and the acknowledgment are the same for both. Arranged: the press in use for the DEMO-ONLY review batch (an open equipment use after its verified cleaning), so the alarm binds to that batch.

### Passed: [DI-49][DI-31][INV-40] a press excursion over OPC UA (the press's REJECT_BURST through the site gateway) binds to the batch using the press and is acknowledged at the kiosk with the action taken and a comment, shown in the batch's alarm log @demo

Started 2026-10-17T06:17:57.934Z, 11.0 s.

- **The press raises REJECT_BURST over OPC UA (through the GMP site gateway); the operator opens the plant alarms at the compression kiosk** (2026-10-17T06:18:06.789Z to 2026-10-17T06:18:06.939Z)
  - Expected: The OPC UA alarm of PRESS-01 is listed, cleared at source, bound to the batch using the press
  - Actual: 3 of 3 assertions passed
  - alarmId: `2781bfae-86a2-4d02-9c8c-5d94e3dcea32`
  - endpointSession: `OPC-COMP-1 SignAndEncrypt Basic256Sha256 COMP-1 PRESS-01 enrolled-certificate`
  - severity: `700`
  - alarmCode: `REJECT_BURST`
  - gmpCritical: `true`
  - boundToBatch: `true`
  - raisedSourceUs: `1792217878011000`
  - clearedSourceUs: `1792217880525000`
  - Screenshot: [exit-demo/item2-1.jpeg](exit-demo/item2-1.jpeg)
- **Acknowledge it with the action taken, a comment and the operator's badge tap** (2026-10-17T06:18:06.941Z to 2026-10-17T06:18:07.429Z)
  - Expected: The alarm is acknowledged and leaves the open list
  - Actual: 3 of 3 assertions passed
  - Screenshot: [exit-demo/item2-2.jpeg](exit-demo/item2-2.jpeg)
- **The head of QC opens the review of the batch** (2026-10-17T06:18:08.377Z to 2026-10-17T06:18:08.892Z)
  - Expected: The batch's alarm log lists the OPC UA alarm with the acknowledgment: who, the action taken and the comment
  - Actual: 3 of 3 assertions passed
  - batch: `GBT260001`
  - acknowledgedAt: `2026-10-17 06:18:07.24241+00`
  - acknowledgedBy: `Priya Nair-wA`
  - Screenshot: [exit-demo/item2-3.jpeg](exit-demo/item2-3.jpeg)

**PASS**

## 3. A serial query (L3)

The L3/L4 simulator is the GMP server's L3 system (EBMR_L3_URL); the server asks it live. Arranged as the L3 server test arranges it: the pool row of the review batch (tab.serial_pool).

### Passed: [PR-42] a serial query: the server asks the L3 system live and answers the serial's lot from the record and its L3 status; an unknown serial is refused @demo

Started 2026-10-17T06:18:08.990Z, 3.3 s.

- **Serial lookup: ask for serial LFUN5H9MVG8V** (2026-10-17T06:18:09.892Z to 2026-10-17T06:18:10.211Z)
  - Expected: The record's lot (the batch number) and the L3 status COMMISSIONED, with the pool and GTIN; no difference reported
  - Actual: 3 of 3 assertions passed
  - serial: `LFUN5H9MVG8V`
  - poolId: `POOL-000001`
  - gtin: `00312345678906`
  - lot: `GBT260001`
  - expiry: `2028-09`
  - status: `Commissioned`
  - Screenshot: [exit-demo/item3-1.jpeg](exit-demo/item3-1.jpeg)
- **Serial lookup: ask for a serial no pool of the record holds (DEMOE98B7130)** (2026-10-17T06:18:10.212Z to 2026-10-17T06:18:12.241Z)
  - Expected: Refused with its code (the L3 does not know it); nothing is shown as the answer
  - Actual: 3 of 3 assertions passed
  - serial: `DEMOE98B7130`
  - status: `404`
  - code: `null`
  - why: `null`
  - Screenshot: [exit-demo/item3-2.jpeg](exit-demo/item3-2.jpeg)

**PASS**

## 4. A mock recall from an API lot to every consignee, signed off by the authorised person

The suite's 6j-b flow as it is: the lot chain (receipt, consumption, finished lot, two ERP distribution records) is arranged as the genealogy server tests arrange it; the explorer, the mock recall and the AP sign-off are the real screens. GB-T-03 shows the same recall with the shipments landed by the ERP adapter (golden job).

### Passed: [PR-57][IN-07] the genealogy explorer traces an API lot forward to the batch, its finished lot and every shipment, as a tree and as a table, and a shipment backward to the API lot @office

Started 2026-10-17T06:18:34.004Z, 3.7 s.

- **Trace the API lot forward** (2026-10-17T06:18:36.013Z to 2026-10-17T06:18:37.290Z)
  - Expected: Lot, batch (consumed), finished lot and both shipments, with their depth; the counts say 2 lots, 1 batch, 2 shipments
  - Actual: 16 of 16 assertions passed
  - rows: `5`
  - Screenshot: [exit-demo/item4-1.jpeg](exit-demo/item4-1.jpeg)
- **Trace the first shipment backward** (2026-10-17T06:18:37.291Z to 2026-10-17T06:18:37.675Z)
  - Expected: From the shipment to the finished lot, the batch and the API lot it consumed
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item4-2.jpeg](exit-demo/item4-2.jpeg)

### Passed: [IN-29][PR-57] the head of QC runs a mock recall from the API lot to every consignee; it reproduces, reconciles delivered against returned, and the authorised person signs it off through the ceremony @office

Started 2026-10-17T06:18:37.749Z, 4.8 s.

- **The head of QC runs a mock recall from the API lot** (2026-10-17T06:18:39.769Z to 2026-10-17T06:18:40.841Z)
  - Expected: The recall reproduces; it lists the batch, the finished lot delivered 650 units with nothing returned, and both consignees with their addresses
  - Actual: 16 of 16 assertions passed
  - consignees: `2`
  - Screenshot: [exit-demo/item4-3.jpeg](exit-demo/item4-3.jpeg)
- **The authorised person signs the mock recall off** (2026-10-17T06:18:41.706Z to 2026-10-17T06:18:42.447Z)
  - Expected: The ceremony signs it; the recall shows who signed it off
  - Actual: 5 of 5 assertions passed
  - signedBy: `Shalini Kapoor-wA`
  - Screenshot: [exit-demo/item4-4.jpeg](exit-demo/item4-4.jpeg)

**PASS**

## 5. Controlled dispensing under dual custody (IN-53 draft banner)

The suite's 6j-b flow as it is. IN-53 is a draft control (NDPS rules not verified; owner decision pending): every screen carries the draft banner.

### Passed: [IN-53] controlled dispensing under dual custody: QA flags the product and a second QA person approves; the stores person proposes and signs first, cannot countersign; a verifier at the kiosk countersigns @office

Started 2026-10-17T06:18:12.356Z, 13.0 s.

- **QA records the controlled-substance flag of the product for the controlled API material, under the change record** (2026-10-17T06:18:14.409Z to 2026-10-17T06:18:15.755Z)
  - Expected: The draft banner is on the screen; the flag is recorded and awaits a second QA person
  - Actual: 7 of 7 assertions passed
  - Screenshot: [exit-demo/item5-1.jpeg](exit-demo/item5-1.jpeg)
- **A second QA person approves the flag through the ceremony** (2026-10-17T06:18:17.010Z to 2026-10-17T06:18:17.852Z)
  - Expected: The flag is APPROVED and in effect for the material
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item5-2.jpeg](exit-demo/item5-2.jpeg)
- **The issuer plans a GB-T-01 batch from the open order and issues it through the ceremony** (2026-10-17T06:18:18.006Z to 2026-10-17T06:18:19.661Z)
  - Expected: The batch is issued
  - Actual: 7 of 7 assertions passed
  - batchNumber: `GBT260002`
  - Screenshot: [exit-demo/item5-3.jpeg](exit-demo/item5-3.jpeg)
- **The stores person proposes the dispensing of 2.500 kg of the controlled lot to the batch and signs as the first custodian** (2026-10-17T06:18:20.785Z to 2026-10-17T06:18:22.091Z)
  - Expected: The dispensing names the batch; after the first signature it awaits the second custodian
  - Actual: 12 of 12 assertions passed
  - Screenshot: [exit-demo/item5-4.jpeg](exit-demo/item5-4.jpeg)
- **The same person tries to countersign as the second custodian** (2026-10-17T06:18:22.102Z to 2026-10-17T06:18:22.741Z)
  - Expected: The ceremony refuses it: one person never fills both places; the record still awaits the second custodian
  - Actual: 3 of 3 assertions passed
  - refusal: `This signature must come from a person other than those who signed before it. Nothing was signed. Why: CONTROLLED_CUSTODY_COUNTERSIGNED must be signed by a person other than the signers of {CONTROLLED`
  - Screenshot: [exit-demo/item5-5.jpeg](exit-demo/item5-5.jpeg)
- **A verifier at the dispensing kiosk countersigns as the second custodian (badge and PIN)** (2026-10-17T06:18:23.986Z to 2026-10-17T06:18:25.288Z)
  - Expected: The dispensing is CONFIRMED with two different custodians
  - Actual: 9 of 9 assertions passed
  - state: `CONFIRMED`
  - Screenshot: [exit-demo/item5-6.jpeg](exit-demo/item5-6.jpeg)

**PASS**

## 6. English step screens

The suite's 6j-b flow as it is (decision 0018: English only).

### Passed: the step screen is in English: the page declares English, offers no other language, writes Western digits and dates as 27-SEP-2026 @kiosk

Started 2026-10-17T06:18:25.376Z, 8.6 s.

- **Open the booth clearance step on the kiosk** (2026-10-17T06:18:30.411Z to 2026-10-17T06:18:30.614Z)
  - Expected: The page declares English and offers no language choice; the step card reads in English
  - Actual: 5 of 5 assertions passed
  - lang: `en`
  - Screenshot: [exit-demo/item6-1.jpeg](exit-demo/item6-1.jpeg)
- **Start the step and record its entries** (2026-10-17T06:18:30.619Z to 2026-10-17T06:18:33.924Z)
  - Expected: Every saved entry is confirmed in English; dates read as 27-SEP-2026 and every digit is a Western digit
  - Actual: 15 of 15 assertions passed
  - recordDate: `17-OCT-2026`
  - Screenshot: [exit-demo/item6-2.jpeg](exit-demo/item6-2.jpeg)

**PASS**

## 7. A lot transferred between two sites (two installations) and accepted by local QA

Two GMP servers (PUNE, GOA), each on its own database with its own installation key, listening on HTTP, as the 6i route tests run them; the exchange goes over HTTP between them. Arranged (deployment steps): the installation identities and proposed peers, the released intermediate lot at PUNE. Not through the browser: the transfer screens exist, but the two-installation browser stack is not built (the E2E stack has one GMP and one sandbox installation).

Run by vitest (apps/tablets-server/test/demo/transfer.demo.ts): exit code 0.

- **Two installations trust each other (QA approved each peer key through the ceremony)** (2026-10-17T06:01:56.749Z)
  - pune: `PUNE-A255 http://127.0.0.1:35027`
  - goa: `GOA-A255 http://127.0.0.1:42727`
  - puneSees: `GOA-A255 APPROVED`
- **PUNE stores seal a package of the released intermediate lot for GOA (100 kg)** (2026-10-17T06:01:56.808Z)
  - lot: `INT-A255`
  - packageNo: `INT-A255/T1`
  - packageId: `05f4fcfc-399c-401b-845d-2f56247f7218`
  - sealed: `true`
  - seal: `15g0s5I7wtPtB13X143GSqX39Dt6ref3md7cM0loK00Ps9haqQVVBLarc3t1wEWa`
- **GOA stores take in a copy whose quantity was changed to 400** (2026-10-17T06:01:56.857Z)
  - outcome: `REFUSED`
  - kind: `TAMPERED`
  - alarmKind: `TAMPERED`
  - alarmSeverity: `MAJOR`
  - alarmPath: `TRANSFER_IMPORT`
- **GOA stores take in the genuine package** (2026-10-17T06:01:56.926Z)
  - outcome: `RECEIVED`
  - receiptId: `05943d62-acc4-4146-9185-f9db9c2f21f0`
  - origin: `PUNE-A255`
  - originState: `RELEASED_FOR_FURTHER_PROCESSING`
  - lotState: `QUARANTINE`
  - state: `RECEIVED`
  - quantity: `100`
  - holdRemainingSeconds: `69703083`
- **GOA stores take in the same package a second time** (2026-10-17T06:01:56.955Z)
  - outcome: `REFUSED`
  - kind: `DUPLICATE`
- **GOA stores try to accept the receipt** (2026-10-17T06:01:56.979Z)
  - ok: `false`
  - refusal: `ESIG_PREVIEW_NOT_ALLOWED`
- **GOA QA accepts the receipt through the ceremony (TRANSFER_RECEIPT_DECIDE)** (2026-10-17T06:01:57.088Z)
  - ok: `true`
  - signature: `{"manifestation":{"signatureId":"c3d0e1ff-a5c5-4b32-8ea1-8c283819f008","signer":{"personId":"c075f816-a93f-4ab8-8110-bd1c4c4ff996","legalName":"Divya Menon","loginName":"divya.menon","role":"QA_REVIEW`
  - state: `ACCEPTED`
  - decision: `ACCEPTED`
  - decidedBy: `{"decision":"ACCEPTED","reason":null,"by":{"personId":"c075f816-a93f-4ab8-8110-bd1c4c4ff996","legalName":"Divya Menon","loginName":"divya.menon","role":"QA"},"at":{"us":"1792216917074926","text":"17-O`
  - lotState: `QUARANTINE`
- **PUNE traces its lot forward across the transfer** (2026-10-17T06:01:57.215Z)
  - complete: `true`
  - localEdges: `LOT:null TRANSFER:TRANSFERRED`
  - remotePeer: `GOA-A255`
  - remoteStatus: `ANSWERED`
  - remoteEdges: `TRANSFER:null LOT:TRANSFER_RECEIVED`
**PASS**

