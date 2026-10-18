# QA reviewer

This page is for the QA batch-record and audit-trail reviewer (`QA_REVIEWER`). QA reviews each batch record after
production has approved it, reviews its audit trail, decides on its exceptions and deviations, and keeps the records
(locks, amendments, true copies, retention). The release itself is the authorised person's
([Authorised person and market releases](04-authorised-person-and-release.md)).

## Reviewing a batch record

The review is *by exception*: the system lists what needs a person's eyes (exceptions, corrections, late entries,
entries changed shortly before use, free text, open deviations), and QA decides on each item. Non-critical items of
the same kind may be accepted together; a critical item is decided one by one.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Find the batches waiting for review | `/review` (home tile **Batch record review**) | `RECORD.READ` | none |
| Open a batch's review: production approval, register, audit trail, QA review | `/review/$batchId` | `RECORD.QA_REVIEW` | none |
| Decide on the items of the exception register (one by one, or non-critical ones together) | `/review/$batchId/register` | `RECORD.QA_REVIEW` | `REVIEW_ITEMS_DISPOSITIONED`, `EXCEPTION_DISPOSITIONED` |
| Ask production a question on an item, and read the answer | `/review/$batchId/register` | `RECORD.QA_REVIEW` | none |
| Review the batch's audit trail (the whole trail, or what changed since the last signed mark) | `/review/$batchId` (**Audit-trail review**) | `RECORD.AUDIT_TRAIL_REVIEW` | `AUDIT_TRAIL_REVIEWED`, `DELTA_AUDIT_TRAIL_REVIEWED` |
| Sign the QA review of the record | `/review/$batchId` (**Sign the QA review**) | `RECORD.QA_REVIEW` | `QA_REVIEWED` |
| Reopen a signed review, with a reason | `/review/$batchId` (**Reopen the review**) | `RECORD.QA_REVIEW` | `REVIEW_REOPENED` |
| Check the output containers of the batch | `/review/$batchId/containers` | `RECORD.READ` | none |

The review page shows, for each gate, why it cannot close yet. QA cannot sign the review while an item is open, while
the audit trail is not reviewed, or while production has not approved the record. The analytics may show a review
priority beside a batch (`/analytics/review-priority/$batchId`); it is advice only and never changes the record.

## Exceptions, deviations and CAPA

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Classify a deviation | `/quality/deviations/$deviationId` | `DEVIATION.CLASSIFY` | none |
| Investigate a deviation | `/quality/deviations/$deviationId` | `DEVIATION.INVESTIGATE` | none |
| Assess its impact, conclude the investigation and close it | `/quality/deviations/$deviationId` | `DEVIATION.QA_APPROVE` | `DEVIATION_IMPACT_ASSESSED`, `DEVIATION_CONCLUDED`, `DEVIATION_CLOSED` |
| See which batches and lots a deviation reaches | `/genealogy/deviations/$deviationId/impact` | `RECORD.READ` | none |
| Record a CAPA and close it | `/capa`, `/capa/$capaId` | `CAPA.RECORD`, `CAPA.QA_APPROVE` | `CAPA_CLOSED` |

## Materials, specifications and laboratory results

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Release or reject a material lot | `/quality/lots/$lotId` | `MATERIAL.RELEASE` | `MATERIAL_LOT_RELEASED`, `MATERIAL_LOT_REJECTED` |
| Decide a lot's status as QA (for example after a deviation) | `/quality/lots/$lotId` | `MATERIAL.QA_DISPOSITION` | `MATERIAL_LOT_STATUS_DECIDED` |
| Approve a manufacturer for a material | `/quality/approved-manufacturers` | `MATERIAL.QA_DISPOSITION` | `MANUFACTURER_APPROVED` |
| Approve a specification | `/quality/specifications` | `SPECIFICATION.APPROVE` | `SPECIFICATION_APPROVED` |
| Approve reprocessing of a batch | `/quality/reprocessing` | `REPROCESSING.AUTHORISE` | `REPROCESSING_AUTHORISED` |

(`REPROCESSING.AUTHORISE` is held by QA operations and the authorised person; the QA reviewer sees the register.)

## Keeping the records

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Open an amendment of a locked record, and close it | `/records/$batchId` | `RECORD.QA_REVIEW` | `AMENDMENT_OPENED`, `AMENDMENT_CLOSED` |
| Download the PDF/A-3 true copy of a batch record | `/archive/batches/$batchId` | `RECORD.READ` | none |
| Assemble an evidence export and certify it | `/archive/batches/$batchId` | `RECORD.QA_REVIEW` | `EVIDENCE_EXPORT_CERTIFIED` |
| Store a record's retention inputs | `/archive/batches/$batchId` | `RECORD.RETENTION_MANAGE` | none |
| Request and approve the disposal of a record past its retention | `/archive/batches/$batchId` | `RECORD.DISPOSAL_APPROVE` | `RECORD_DISPOSAL_APPROVED` |
| Read certified exports in the inspection workspace | `/archive/inspection` | `ARCHIVE.INSPECT` | none |

A true copy is a marked copy: the electronic record in Batchwright stays the original. It carries your company's name
and site; it never carries the Batchwright name or the Medhanta logo.

## Configuration and rules QA approves

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Approve a configuration change record | `/config/change-records` | `CONFIG.CHANGE_APPROVE` | `CONFIG_CHANGE_APPROVED` |
| Change a review-by-exception rule | `/config/rbe-rules` | `REVIEW.RBE_RULE_CHANGE` | none |
| Approve a penicillin facility rule or a beta-lactam classification proposed by the master-data steward | no screen in v1.0 (the plant-rules interface) | `PLANT_RULE.APPROVE` | `QA_APPROVED` |
| Approve the validation summary of the running release | (as planned; checked at 7f) | `VALIDATION.APPROVE_SUMMARY` | `VALIDATION_SUMMARY_APPROVED` |

A facility rule or classification that loosens a rule takes effect only when a QA person other than the proposer signs
it; a tightening is in force at once (PR-27). The validation summary approval is described in the administrator guide
([Validation summary approval](../admin-guide/10-validation-summary-approval.md)).
