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
