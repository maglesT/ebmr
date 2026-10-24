# Authorised person and market releases

This page is for the people who release finished lots: the authorised person for India (or a named delegate,
`AUTHORISED_PERSON`), the US quality-unit disposition signer (`US_QCU_SIGNER`), the EU qualified person (`EU_QP`) and
the EU importer's QP who reads a batch package (`EU_QP_READER`).

## How a release works

A finished lot is released by the manufacturer first, then for each market it is meant for.

1. The **release cockpit** (`/release`) lists the lots waiting for a decision.
2. The lot's page (`/release/$lotId`) shows **G-REL**, the release checklist the system evaluates from signed records:
   the batch record reviewed by QA, the deviations closed or justified, the QC results approved, the samples taken, the
   licence and market rules met. Each item is green or says what is missing and where it comes from. The browser
   computes none of it; every item is read from the database.
3. The authorised person signs the **manufacturer release decision** when G-REL is green. An open investigation may be
   released under a written justification, signed separately.
4. Each market then gets its own disposition: India (by the manufacturer release), the United States (the quality-unit
   disposition) and the European Union (the QP certification, after the importer's QP has the package).

A lot cannot ship to a market without that market's disposition (the shipping interlock).

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See the lots waiting for release | `/release` (home tile **Release cockpit**) | `RECORD.READ` | none |
| Read a lot's G-REL checklist | `/release/$lotId` | `RECORD.READ` | none |
| Sign the manufacturer release (India) | `/release/$lotId` | `RELEASE.MANUFACTURER` | `MANUFACTURER_RELEASE` |
| Release with an investigation still open, under a justification | `/release/$lotId` | `RELEASE.MANUFACTURER` | `OPEN_INVESTIGATION_JUSTIFIED` |
| Sign the US market disposition | `/release/$lotId` (US tab) | `RELEASE.US_DISPOSITION` | `US_DISPOSITION` |
| Certify (or reject) the lot as EU QP | `/release/$lotId` (EU tab) | `RELEASE.EU_QP_CERTIFY` | `QP_CERTIFIED`, `QP_REJECTED` |
| Read an EU batch package as the importer's QP | `/qp` (home tile **QP batch packages**) | `QP_PACKAGE.READ` | none |
| Add or remove a market of a batch after issue (QA) | `/release/batches/$batchId` | `RECORD.QA_REVIEW` | `MARKET_ADDED`, `MARKET_REMOVED` |

## Profiles: a dissolution profile as one release requirement

A sustained-release tablet is released on several time points of one dissolution test (for example 1 h, 4 h and 8 h),
each with its own limits; a delayed-release (gastro-resistant) tablet on an acid stage that must stay at or below a
limit and a buffer stage that must reach at least one. Both are written as one **profile** test of the specification.

1. **Specification (QC drafts, the head of QC or QA approves):** Quality, Specifications. *Start a new version from* the
   version in effect copies its tests into the draft. For the new test choose **Profile (time points)**; give each point
   its label (e.g. `1 h`), its time and unit (min or h) and its own lower and/or upper limit; for a two-stage test also
   the stage and medium of each point (e.g. `Acid 0.1 M HCl`, `Buffer pH 6.8`). The database keeps the points in time
   order (within each stage) and refuses a profile with fewer than two points or with limits on the test itself. The
   approval signs the points; an approved version never changes.
2. **Results (QC):** Quality, Material lots, the lot. The **Profiles** section lists each point with its limits, its
   result and the latest value the LIMS sent for it. Type the value at each point (or take the LIMS value) and record it;
   the database judges it against that point's limits and refuses a result for a point the specification does not have.
   Approve each point's result in the results list as any other result (`QC_RESULT_APPROVED`, another QC person).
3. **Release:** the checklist shows the profile as one line, `G3.PROFILE_<test>`, with one evidence entry per point. It
   is green only when every point has an approved result within its limits; a point outside its limits fails it (raise
   the OOS record from the failing result as for any test); a point without a result keeps it open. While it is red the
   lot is not ready and the manufacturer release is not offered; the database refuses it as well.

One result is recorded per point: the mean of the units tested, as the LIMS reports it (decision D-7p-1). The
pharmacopoeial staged acceptance of dissolution (stages 1 to 3 with more units) is not built yet; record the stage
result that decides, and investigate as usual.

Content uniformity of a low-dose tablet is a single test with an upper limit on the acceptance value (for example AV at
most 15): its result is judged and released like any other test (decision D-7p-6).

## After release

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See suspended lots and recalls | `/release/suspended` (home tile **Suspension and recall**) | `RECORD.READ` | none |
| Re-confirm a release after a suspension | `/release/$lotId` | `RELEASE.MANUFACTURER` | `RELEASE_RECONFIRMED` |
| Reject a lot after release | `/release/$lotId` | `RELEASE.MANUFACTURER` | `REJECTED_AFTER_RELEASE` |
| Recall a lot for a market (the licensing authority informed) | `/release/$lotId` | `RELEASE.MANUFACTURER` | `RECALLED` |
| Record the disposal of a rejected lot, with a witness | `/release/$lotId` | `RELEASE.DISPOSAL` | `DISPOSAL_RECORDED`, `DESTRUCTION_WITNESSED` |
| Run a mock recall and sign it off | `/recall`, `/recall/$mockRecallId` | `RECALL.MOCK_RUN`, `RECALL.MOCK_SIGN_OFF` | `MOCK_RECALL_SIGNED_OFF` |
| Find a lot, batch or shipment from a complaint | `/genealogy/lookup` | `RECORD.READ` | none |
| Follow a lot up and down its genealogy, across sites | `/genealogy`, `/genealogy/lots/$lotId/supply-chain` | `RECORD.READ`, `GENEALOGY.FEDERATE` | none |
| Sign off the product quality review | `/pqr`, `/pqr/$extractId` | `PQR.EXTRACT`, `PQR.SIGN_OFF` | `PQR_SIGNED_OFF` |
| Accept or refuse a lot transferred from another site | `/transfers/receipts/$receiptId` | `MATERIAL.QA_DISPOSITION` | `TRANSFER_RECEIPT_ACCEPTED`, `TRANSFER_RECEIPT_REFUSED` |
| Approve another installation as a transfer peer | `/transfers` | `TRANSFER.PEER_APPROVE` | `PEER_INSTALLATION_APPROVED` |

## Access for others

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Give an EU importer's QP access to a batch package (QA reviewer) | `/release/$lotId` (EU tab) | `QP_ACCESS.GRANT` | none |
| Give a contract giver access to the batches made for them (QA reviewer) | `/governance/contract-givers` | `CONTRACT_GIVER_ACCESS.GRANT` | none |
| Approve vendor support access, for QA | `/governance/support` | `SUPPORT.APPROVE_QA` | `SUPPORT_ACCESS_QA_APPROVED` |
