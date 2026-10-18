# Controlled-substance roles

This page is for the people who handle controlled substances (narcotic or psychotropic APIs): the holders of a
`CONTROLLED.*` right, among them the dispenser, the verifier, the warehouse, the shift supervisor and QA.

> **Draft.** The controlled-substance mode is a draft (control IN-53): its rules wait for the expert's decision. Every
> controlled-substance screen shows a draft banner. Do not rely on it as your only register until the decision is
> made; keep the register your procedures require.

## What the mode does

When QA approves the controlled-substance flag on a product, its batches keep a custody record of the controlled API
from the store to the batch and back, a balance per batch, and a register. Only the roles that hold a `CONTROLLED.*`
right, and QA, can read them (`CONTROLLED.READ`, 7a); anyone else is refused.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Approve the controlled-substance flag of a product (QA) | `/controlled` (home tile **Controlled substances (draft)**) | `CONTROLLED.APPROVE` | `CONTROLLED_PRODUCT_APPROVED` |
| Read the controlled list, the balances and the register | `/controlled` | `CONTROLLED.READ` | none |
| Record a custody movement (issue, return, transfer) | `/controlled/batches/$batchId` | `CONTROLLED.CUSTODY` | `CONTROLLED_CUSTODY_RECORDED` |
| Countersign a custody movement (a second person) | `/controlled/batches/$batchId` | `CONTROLLED.CUSTODY` | `CONTROLLED_CUSTODY_COUNTERSIGNED` |
| Sign the batch's account of the controlled API | `/controlled/batches/$batchId` | `CONTROLLED.BALANCE` | `CONTROLLED_BALANCE_SIGNED` |
| Extract the register | `/controlled` | `CONTROLLED.REGISTER` | none |

A custody movement is recorded by one person and countersigned by another; the same person cannot do both.
