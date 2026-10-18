# Batchwright Tablets: user guide

This guide is for the people who work in Batchwright Tablets every day. It is written by role: find your role in the
table and read its page. Every task names the screen you use, the right (permission) your role must hold for it, and
the meaning of the electronic signature it asks for. The [first page](01-getting-started.md) is for everyone: signing
in, the two installations, signing, and what to do when the system refuses something.

| Page | Roles |
|---|---|
| [Getting started](01-getting-started.md) | Everyone |
| [Operator and shift supervisor](02-operator-and-shift-supervisor.md) | `OPERATOR`, `DISPENSER`, `VERIFIER`, `SHIFT_SUPERVISOR`, `STAGE_RESPONSIBLE`, `HEAD_OF_PRODUCTION`, `QA_SHOP_FLOOR` |
| [QA reviewer](03-qa-reviewer.md) | `QA_REVIEWER` |
| [Authorised person and market releases](04-authorised-person-and-release.md) | `AUTHORISED_PERSON`, `US_QCU_SIGNER`, `EU_QP`, `EU_QP_READER` |
| [Master-data steward](05-master-data-steward.md) | `MASTER_DATA_STEWARD`, with `QA_MBR_APPROVER` for the approvals |
| [MBR author](06-mbr-author.md) | `MBR_AUTHOR`, `MBR_CHECKER`, `QA_MBR_APPROVER`, `REGULATORY_SIGNER` |
| [Data-integrity lead](07-data-integrity-lead.md) | `CSV_DI_LEAD`, with `QA_REVIEWER` for the audit-trail review |
| [Controlled-substance roles](08-controlled-substances.md) | the holders of a `CONTROLLED.*` right |

The lists behind the tasks are generated from the code:

- [Rights, roles and signature meanings](../reference/permissions.md)
- [Screens](../reference/screens.md)

The administrator's side (accounts, devices, interfaces, backups) is in the
[administrator guide](../admin-guide/README.md).
