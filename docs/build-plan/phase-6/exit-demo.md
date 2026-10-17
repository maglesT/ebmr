# Phase 6 exit demo, record

Run 2026-10-17T05:19:15.630Z to 2026-10-17T05:36:26.093Z (UTC), commit dcf69ea5, by `pnpm demo:phase6-exit` (tools/e2e/demo/run.ts). Written by the run; re-running replaces this file and the screenshots.

The stack is the real product: the GMP and sandbox servers, the sandbox site gateway with its scale simulator, a GMP site gateway holding the OPC UA press endpoint, the ERP, QMS, LMS, CMMS, L3/L4 and OPC UA simulators each as its own process, the adapters started by the servers themselves, and Chromium (tools/e2e/demo/global-setup.ts). Item 7 runs two further GMP servers on HTTP (vitest.demo.config.ts). DEMO-ONLY data and credentials; every name is unique per run, so ids, hashes and times differ between runs while the outcomes do not.

## Summary

| Item | What | Result |
|---|---|---|
| 1 | ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk | FAIL |
| 2 | A press excursion over OPC UA acknowledged with a comment in the batch's alarm log | FAIL |
| 3 | A serial query (L3) | FAIL |
| 4 | A mock recall from an API lot to every consignee, signed off by the authorised person | PASS |
| 5 | Controlled dispensing under dual custody (IN-53 draft banner) | PASS |
| 6 | English step screens | PASS |
| 7 | A lot transferred between two sites (two installations) and accepted by local QA | PASS |

Screenshots: 13 files, 891 KiB in exit-demo/.

## 1. ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk

Each system is its simulator process; each adapter is started by the sandbox server itself from its service-keys file (MIRROR mode) and pulls on its own 5 s timer. The demo only publishes on the simulators and switches their faults (POST /api/fault). The stale mirror is real time: the LMS mirror bound is set to its minimum (60 s, a change-controlled setting) and the LMS stops confirming its feed (STALE_MIRROR), so the adapter records no synchronisation. Arranged in the database as the 6j-b flows do: the training coordinator's product requirement, the employee numbers, the change record.

### **FAILED**: [DI-31][DI-20] the ERP, QMS, LMS and CMMS exchange data under injected faults (malformed, duplicate, out of order, link cut): each refused or de-duplicated with an alarm, no partial value, the count reconciles @demo

Started 2026-10-17T05:32:54.869Z, 61.2 s.

```text
Error: waited too long for ERP clean: last {"accepted":0,"refused":0,"dedup":0,"alarms":{}}
```

### **FAILED**: [DI-31] a stale LMS mirror (the LMS stops confirming its feed; bound 60 s) refuses the operator's step signature at the kiosk, naming the stale qualification source; once the adapter synchronises again the same signature is accepted @demo

Started 2026-10-17T05:33:58.195Z, 66.9 s.

```text
Error: waited too long for the operator's LMS training: last 0
```

**FAIL**

## 2. A press excursion over OPC UA acknowledged with a comment in the batch's alarm log

Path used: the press's Alarms-and-Conditions REJECT_BURST on the OPC UA feed (OPC UA simulator -> GMP site gateway, its own process, holding the enrolled endpoint -> the GMP server's OPCUA adapter). Not shown: a tag-limit excursion over the gateway's process uplink: the GMP installation has no gateway uplink listener (only the sandbox server has one) and GB-T-03 does not start that path either (D-P6j-b-3); the alarm log and the acknowledgment are the same for both. Arranged: the press in use for the DEMO-ONLY review batch (an open equipment use after its verified cleaning), so the alarm binds to that batch.

### **FAILED**: [DI-49][DI-31][INV-40] a press excursion over OPC UA (the press's REJECT_BURST through the site gateway) binds to the batch using the press and is acknowledged at the kiosk with the action taken and a comment, shown in the batch's alarm log @demo

Started 2026-10-17T05:35:07.916Z, 0.2 s.

```text
error: duplicate key value violates unique constraint "equipment_use_equipment_id_previous_use_id_key"
```

**FAIL**

## 3. A serial query (L3)

The L3/L4 simulator is the GMP server's L3 system (EBMR_L3_URL); the server asks it live. Arranged as the L3 server test arranges it: the pool row of the review batch (tab.serial_pool).

### **FAILED**: [PR-42] a serial query: the server asks the L3 system live and answers the serial's lot from the record and its L3 status; an unknown serial is refused @demo

Started 2026-10-17T05:35:10.316Z, 23.0 s.

- **Serial lookup: ask for serial LFUN5H9MVG8V** (2026-10-17T05:35:12.262Z to 2026-10-17T05:35:12.992Z)
  - Expected: The record's lot (the batch number) and the L3 status COMMISSIONED, with the pool and GTIN; no difference reported
  - Actual: 3 of 3 assertions passed
  - serial: `LFUN5H9MVG8V`
  - poolId: `POOL-000001`
  - gtin: `00312345678906`
  - lot: `GBT260001`
  - expiry: `2028-09`
  - status: `Commissioned`
  - Screenshot: [exit-demo/item3-1.jpeg](exit-demo/item3-1.jpeg)

```text
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('alert').first()
Expected pattern: /EBMR-L3-\d{3}|not/i
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" with timeout 20000ms
  - waiting for getByRole('alert').first()

```

**FAIL**

## 4. A mock recall from an API lot to every consignee, signed off by the authorised person

The suite's 6j-b flow as it is: the lot chain (receipt, consumption, finished lot, two ERP distribution records) is arranged as the genealogy server tests arrange it; the explorer, the mock recall and the AP sign-off are the real screens. GB-T-03 shows the same recall with the shipments landed by the ERP adapter (golden job).

### Passed: [PR-57][IN-07] the genealogy explorer traces an API lot forward to the batch, its finished lot and every shipment, as a tree and as a table, and a shipment backward to the API lot @office

Started 2026-10-17T05:36:10.071Z, 6.4 s.

- **Trace the API lot forward** (2026-10-17T05:36:13.101Z to 2026-10-17T05:36:15.516Z)
  - Expected: Lot, batch (consumed), finished lot and both shipments, with their depth; the counts say 2 lots, 1 batch, 2 shipments
  - Actual: 16 of 16 assertions passed
  - rows: `5`
  - Screenshot: [exit-demo/item4-1.jpeg](exit-demo/item4-1.jpeg)
- **Trace the first shipment backward** (2026-10-17T05:36:15.524Z to 2026-10-17T05:36:16.287Z)
  - Expected: From the shipment to the finished lot, the batch and the API lot it consumed
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item4-2.jpeg](exit-demo/item4-2.jpeg)

### Passed: [IN-29][PR-57] the head of QC runs a mock recall from the API lot to every consignee; it reproduces, reconciles delivered against returned, and the authorised person signs it off through the ceremony @office

Started 2026-10-17T05:36:16.482Z, 8.1 s.

- **The head of QC runs a mock recall from the API lot** (2026-10-17T05:36:19.532Z to 2026-10-17T05:36:21.484Z)
  - Expected: The recall reproduces; it lists the batch, the finished lot delivered 650 units with nothing returned, and both consignees with their addresses
  - Actual: 16 of 16 assertions passed
  - consignees: `2`
  - Screenshot: [exit-demo/item4-3.jpeg](exit-demo/item4-3.jpeg)
- **The authorised person signs the mock recall off** (2026-10-17T05:36:22.756Z to 2026-10-17T05:36:24.363Z)
  - Expected: The ceremony signs it; the recall shows who signed it off
  - Actual: 5 of 5 assertions passed
  - signedBy: `Shalini Kapoor-wA`
  - Screenshot: [exit-demo/item4-4.jpeg](exit-demo/item4-4.jpeg)

**PASS**

## 5. Controlled dispensing under dual custody (IN-53 draft banner)

The suite's 6j-b flow as it is. IN-53 is a draft control (NDPS rules not verified; owner decision pending): every screen carries the draft banner.

### Passed: [IN-53] controlled dispensing under dual custody: QA flags the product and a second QA person approves; the stores person proposes and signs first, cannot countersign; a verifier at the kiosk countersigns @office

Started 2026-10-17T05:35:35.992Z, 20.3 s.

- **QA records the controlled-substance flag of the product for the controlled API material, under the change record** (2026-10-17T05:35:39.672Z to 2026-10-17T05:35:42.056Z)
  - Expected: The draft banner is on the screen; the flag is recorded and awaits a second QA person
  - Actual: 7 of 7 assertions passed
  - Screenshot: [exit-demo/item5-1.jpeg](exit-demo/item5-1.jpeg)
- **A second QA person approves the flag through the ceremony** (2026-10-17T05:35:43.763Z to 2026-10-17T05:35:45.689Z)
  - Expected: The flag is APPROVED and in effect for the material
  - Actual: 8 of 8 assertions passed
  - Screenshot: [exit-demo/item5-2.jpeg](exit-demo/item5-2.jpeg)
- **The issuer plans a GB-T-01 batch from the open order and issues it through the ceremony** (2026-10-17T05:35:45.926Z to 2026-10-17T05:35:48.777Z)
  - Expected: The batch is issued
  - Actual: 7 of 7 assertions passed
  - batchNumber: `GBT260002`
  - Screenshot: [exit-demo/item5-3.jpeg](exit-demo/item5-3.jpeg)
- **The stores person proposes the dispensing of 2.500 kg of the controlled lot to the batch and signs as the first custodian** (2026-10-17T05:35:50.232Z to 2026-10-17T05:35:51.793Z)
  - Expected: The dispensing names the batch; after the first signature it awaits the second custodian
  - Actual: 12 of 12 assertions passed
  - Screenshot: [exit-demo/item5-4.jpeg](exit-demo/item5-4.jpeg)
- **The same person tries to countersign as the second custodian** (2026-10-17T05:35:51.796Z to 2026-10-17T05:35:52.367Z)
  - Expected: The ceremony refuses it: one person never fills both places; the record still awaits the second custodian
  - Actual: 3 of 3 assertions passed
  - refusal: `This signature must come from a person other than those who signed before it. Nothing was signed. Why: CONTROLLED_CUSTODY_COUNTERSIGNED must be signed by a person other than the signers of {CONTROLLED`
  - Screenshot: [exit-demo/item5-5.jpeg](exit-demo/item5-5.jpeg)
- **A verifier at the dispensing kiosk countersigns as the second custodian (badge and PIN)** (2026-10-17T05:35:54.365Z to 2026-10-17T05:35:56.405Z)
  - Expected: The dispensing is CONFIRMED with two different custodians
  - Actual: 9 of 9 assertions passed
  - state: `CONFIRMED`
  - Screenshot: [exit-demo/item5-6.jpeg](exit-demo/item5-6.jpeg)

**PASS**

## 6. English step screens

The suite's 6j-b flow as it is (decision 0018: English only).

### Passed: the step screen is in English: the page declares English, offers no other language, writes Western digits and dates as 27-SEP-2026 @kiosk

Started 2026-10-17T05:35:56.551Z, 13.5 s.

- **Open the booth clearance step on the kiosk** (2026-10-17T05:36:04.902Z to 2026-10-17T05:36:05.155Z)
  - Expected: The page declares English and offers no language choice; the step card reads in English
  - Actual: 5 of 5 assertions passed
  - lang: `en`
  - Screenshot: [exit-demo/item6-1.jpeg](exit-demo/item6-1.jpeg)
- **Start the step and record its entries** (2026-10-17T05:36:05.158Z to 2026-10-17T05:36:09.943Z)
  - Expected: Every saved entry is confirmed in English; dates read as 27-SEP-2026 and every digit is a Western digit
  - Actual: 15 of 15 assertions passed
  - recordDate: `17-OCT-2026`
  - Screenshot: [exit-demo/item6-2.jpeg](exit-demo/item6-2.jpeg)

**PASS**

## 7. A lot transferred between two sites (two installations) and accepted by local QA

Two GMP servers (PUNE, GOA), each on its own database with its own installation key, listening on HTTP, as the 6i route tests run them; the exchange goes over HTTP between them. Arranged (deployment steps): the installation identities and proposed peers, the released intermediate lot at PUNE. Not through the browser: the transfer screens exist, but the two-installation browser stack is not built (the E2E stack has one GMP and one sandbox installation).

Run by vitest (apps/tablets-server/test/demo/transfer.demo.ts): exit code 0.

- **Two installations trust each other (QA approved each peer key through the ceremony)** (2026-10-17T05:20:00.781Z)
  - pune: `PUNE-4FBB http://127.0.0.1:34051`
  - goa: `GOA-4FBB http://127.0.0.1:34083`
  - puneSees: `GOA-4FBB APPROVED`
- **PUNE stores seal a package of the released intermediate lot for GOA (100 kg)** (2026-10-17T05:20:00.909Z)
  - lot: `INT-4FBB`
  - packageNo: `INT-4FBB/T1`
  - packageId: `be40d723-b3e1-4c81-9259-24eb84e28dde`
  - sealed: `true`
  - seal: `G6PsU1hlqC114KBBVJQrQWIAxhgkkPazM/RdDjFvpEoAsgLPvEcyubAGWFeLuxOV`
- **GOA stores take in a copy whose quantity was changed to 400** (2026-10-17T05:20:00.979Z)
  - outcome: `REFUSED`
  - kind: `TAMPERED`
  - alarmKind: `TAMPERED`
  - alarmSeverity: `MAJOR`
  - alarmPath: `TRANSFER_IMPORT`
- **GOA stores take in the genuine package** (2026-10-17T05:20:01.036Z)
  - outcome: `RECEIVED`
  - receiptId: `fc418dec-b76d-4052-b5e6-90eb94c53c72`
  - origin: `PUNE-4FBB`
  - originState: `RELEASED_FOR_FURTHER_PROCESSING`
  - lotState: `QUARANTINE`
  - state: `RECEIVED`
  - quantity: `100`
  - holdRemainingSeconds: `69705598`
- **GOA stores take in the same package a second time** (2026-10-17T05:20:01.070Z)
  - outcome: `REFUSED`
  - kind: `DUPLICATE`
- **GOA stores try to accept the receipt** (2026-10-17T05:20:01.090Z)
  - ok: `false`
  - refusal: `ESIG_PREVIEW_NOT_ALLOWED`
- **GOA QA accepts the receipt through the ceremony (TRANSFER_RECEIPT_DECIDE)** (2026-10-17T05:20:01.208Z)
  - ok: `true`
  - signature: `{"manifestation":{"signatureId":"4528fc53-9e37-40cb-8022-e9f28a6180c3","signer":{"personId":"47d6edb7-ded6-490d-a333-ac5dbe0711f6","legalName":"Divya Menon","loginName":"divya.menon","role":"QA_REVIEW`
  - state: `ACCEPTED`
  - decision: `ACCEPTED`
  - decidedBy: `{"decision":"ACCEPTED","reason":null,"by":{"personId":"47d6edb7-ded6-490d-a333-ac5dbe0711f6","legalName":"Divya Menon","loginName":"divya.menon","role":"QA"},"at":{"us":"1792214401194134","text":"17-O`
  - lotState: `QUARANTINE`
- **PUNE traces its lot forward across the transfer** (2026-10-17T05:20:01.410Z)
  - complete: `true`
  - localEdges: `LOT:null TRANSFER:TRANSFERRED`
  - remotePeer: `GOA-4FBB`
  - remoteStatus: `ANSWERED`
  - remoteEdges: `TRANSFER:null LOT:TRANSFER_RECEIVED`
**PASS**

