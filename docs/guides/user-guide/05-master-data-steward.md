# Master-data steward

This page is for the master-data steward (`MASTER_DATA_STEWARD`): formulas, ERP masters, plant definitions, labels,
batch-number rules and the market rule tables. Most changes need a configuration change record that QA approved, and
the approvals are signed by QA (`QA_MBR_APPROVER` or `QA_REVIEWER`), never by the steward who made the change.

## Change control first

A change of configuration (master data, rules, analytics methods, the system description) is made under a
configuration change record: raise it, have QA approve it, make the change naming it, then close it.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Raise a configuration change record | `/config/change-records` | `CONFIG.CHANGE_RAISE` | none |
| Approve it (QA) | `/config/change-records` | `CONFIG.CHANGE_APPROVE` | `CONFIG_CHANGE_APPROVED` |
| Close it when the change is done | `/config/change-records` | `CONFIG.CHANGE_CLOSE` | none |
| See what configuration was in force on a date | `/config/history` | `RECORD.READ` | none |
| See what a change touches before making it | `/change-impact` | `RECORD.READ` | none |

## Formulas, ERP masters and plant definitions

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Create and edit a formula version | `/master-data/formulas`, `/master-data/formulas/$formulaId` | `FORMULA.MANAGE` | none |
| Approve a formula version | `/master-data/formulas/$formulaId` | `FORMULA.APPROVE` | `FORMULA_APPROVED` |
| See the ERP's material and product masters | `/master-data/erp` | `RECORD.READ` | none |
| Confirm an ERP master change before it is used (QA) | `/quality/erp` | `ERP.MASTER_CONFIRM` | `ERP_MASTER_CONFIRMED` |
| Change plant definitions (equipment, rooms, lines) | `/master-data/plant` | `MASTERDATA.CHANGE` | none |
| Propose a penicillin facility rule or a beta-lactam classification | no screen in v1.0 (the plant-rules interface) | `MASTERDATA.CHANGE` | none |
| Approve the proposal (a QA person other than the proposer) | no screen in v1.0 (the plant-rules interface) | `PLANT_RULE.APPROVE` | `QA_APPROVED` |

**Plant rules take effect only with QA (7a, PR-27).** A proposal of the steward changes nothing by itself when it
loosens the rule. It takes effect when a QA person who is not the proposer signs it with the meaning *Quality-unit
approved*. Until then the rule in force is the earlier one. A tightening is in force at once. Only the latest proposal
of a site, material or product can be approved, and only once.

## Labels, batch numbers and market rules

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Design a label template | `/labels/templates` | `LABEL.DESIGN` | none |
| Approve a label template (a second person, QA; refused while an India particular is missing) | `/labels/templates` | `LABEL.APPROVE` | none |
| Define a batch-number rule (the register at `/india/register` shows every number allocated, voided or recovered) | the batch-number interface | `BATCH_NUMBER.RULE_DEFINE` | none |
| Publish a market rule table, or set a site value | the market rules interface | `MARKET.RULE_TABLE_PUBLISH`, `MARKET.SITE_VALUE_SET` | none |
| Approve a loosening of a site value (QA) | the market rules interface | `MBR.APPROVE` | `SITE_VALUE_LOOSENING_APPROVED` |

## Licences (India)

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Record a manufacturing or loan licence, or an export permission | `/india` | `LICENCE.RECORD` | none |
| Approve it (a second QA person) | `/india` | `LICENCE.APPROVE` | `LICENCE_APPROVED`, `EXPORT_PERMISSION_APPROVED` |

`LICENCE.RECORD` is held by the regulatory-conformity signer (`REGULATORY_SIGNER`). A batch issue is refused when no
approved licence covers the product.
