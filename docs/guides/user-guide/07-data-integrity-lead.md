# Data-integrity lead

This page is for the CSV / data-integrity lead (`CSV_DI_LEAD`), who watches that the records stay attributable,
legible, contemporaneous, original and accurate. The batch audit-trail review itself is signed by the QA reviewer
([QA reviewer](03-qa-reviewer.md#reviewing-a-batch-record)); the DI lead reviews the analytics' audit-trail flags,
looks across batches, and keeps the system's validation and interfaces in order.

## The audit trail

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Search the audit trail (by record, person, time) | `/audit` (home tile **Audit trail**) | `RECORD.READ` | none |
| Review a batch's audit trail and sign it (QA reviewer) | `/review/$batchId` | `RECORD.AUDIT_TRAIL_REVIEW` | `AUDIT_TRAIL_REVIEWED`, `DELTA_AUDIT_TRAIL_REVIEWED` |
| Export records for an inspection | `/archive/batches/$batchId` | `RECORD.EXPORT` | none |

Every entry shows who did it (legal name and user ID), under which role, on which terminal, when (the database's time,
shown in the site's time zone), what it was before and after, and the reason. Nothing in the audit trail can be
changed or deleted by anyone, including an administrator.

## Analytics flags

The analytics are advisory: they never change a GMP record. They flag patterns for a person to look at.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See the analytics overview, methods and flags | `/analytics`, `/analytics/methods`, `/analytics/flags` | `ANALYTICS.VIEW` | none |
| Review the audit-trail flags (for example, many corrections by one person, entries just before a deadline) | `/analytics/audit-flags`, `/analytics/audit-flags/$flagId` | `ANALYTICS.DI_REVIEW` | none |
| Record the disposition of a flag | `/analytics/audit-flags/$flagId` | `ANALYTICS.DISPOSITION` | none |
| See control charts, capability and deviation rates | `/analytics/spc`, `/analytics/rates` | `ANALYTICS.VIEW` | none |
| See multivariate monitoring of a batch | `/analytics/mspc`, `/analytics/mspc/batches/$batchId` | `ANALYTICS.VIEW` | none |

Flags about a person (for example many corrections by one operator) are shown only to holders of `ANALYTICS.DI_REVIEW`;
the server refuses them to anyone else.

## Validation, interfaces and incidents

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Record an interface of the approved system description | the configuration interface (under an approved change record) | `CONFIG.SYSTEM_DESCRIPTION` | none |
| See the integration health page | `/integrations`, `/integrations/$adapterCode` | `RECORD.READ` | none |
| Validate a time source | the platform interface | `PLATFORM.TIME_SOURCE_VALIDATE` | none |
| Investigate an incident and record the CERT-In report | the incident register (no screen in v1.0) | `INCIDENT.INVESTIGATE`, `INCIDENT.CERT_IN_REPORT` | none |
| Manage the validation records | (as planned; checked at 7f) | `VALIDATION.MANAGE` | none |

The administrator guide describes these in full: [adapters and the system description](../admin-guide/05-adapters-and-system-description.md),
[incident handling](../admin-guide/11-incident-handling.md) and the
[validation summary approval](../admin-guide/10-validation-summary-approval.md).
