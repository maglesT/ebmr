# Phase B slice 5: demo codes and demo grants

Lead decision of 4 November 2026 (option d): the platform demo is a **moved copy of today's Batchwright demo**. Nothing
in Batchwright's seeds is renamed.

- [`tools/platform/demo-code-map.json`](../../../tools/platform/demo-code-map.json) maps today's demo codes that have a
  counterpart in the platform's demo company (databsee `docs/demo-company.md`) one to one, per kind (product, room,
  equipment, instrument, material). The move (slice 6) links each mapped local code to that master item in
  `md.item_map`. Local records keep their own codes (PL-07), and the write-time check finds the master item through the
  link (PL-08).
- Codes with no counterpart (the fictional EXZ, CXC, GBT and GLV products, their materials, lines, and the room
  balances) are created in master_data by the move, as moved items. A master item with the same kind and code is
  reused.

## ebmr.* codes for the demo company's people

Each old role gives the codes below: today's `iam.role_permission`, without the 23 codes the manifest leaves out
(`permission-list.md`). Generated from a demo database built with today's full demo set-up. The move derives each
moved person's codes the same way.

Administration and GMP codes never go to one person (INV-11). `SYSTEM_ADMINISTRATOR` keeps its administration,
governance and read-only codes only. Its holders also get `core.people.manage` and `core.masterdata.edit`.

Suggested grants for the demo company's people, applied by the lead in databsee `deploy/demo.seed.yaml` and
`docs/demo-company.md`:

| Demo company person (by function) | Batchwright role(s) whose codes they get |
|---|---|
| Production operators | OPERATOR, DISPENSER |
| Production supervisors / officers | SHIFT_SUPERVISOR, VERIFIER, STAGE_RESPONSIBLE, BATCH_ISSUER |
| Head of production | HEAD_OF_PRODUCTION, PROCESS_OWNER |
| QA officers | QA_SHOP_FLOOR, QA_REVIEWER |
| QA manager / authorised person | AUTHORISED_PERSON, QA_MBR_APPROVER |
| QC analysts | QC_ANALYST |
| Head of QC | HEAD_OF_QC |
| Warehouse | WAREHOUSE_LABELLING |
| Engineering / maintenance | MAINTENANCE_TECHNICIAN |
| Technology transfer / documentation | MBR_AUTHOR, MBR_CHECKER (different people), MASTER_DATA_STEWARD |
| Training | TRAINING_COORDINATOR |
| IT administrator (no GMP codes) | SYSTEM_ADMINISTRATOR |

### Role → codes

| Role | Codes |
|---|---|
| AUDITOR_READONLY | ebmr.record.export ebmr.record.read |
| AUTHORISED_PERSON | ebmr.analytics.view ebmr.capa.qa_approve ebmr.capa.record ebmr.controlled.read ebmr.controlled.register ebmr.deviation.classify ebmr.deviation.qa_approve ebmr.evidence.store ebmr.formula.read ebmr.material.qa_disposition ebmr.notification.acknowledge ebmr.pqr.extract ebmr.pqr.sign_off ebmr.recall.mock_run ebmr.recall.mock_sign_off ebmr.record.read ebmr.release.disposal ebmr.release.manufacturer ebmr.reprocessing.authorise ebmr.support.approve_qa ebmr.transfer.peer_approve |
| BATCH_ISSUER | ebmr.batch.issue ebmr.batch_number.allocate ebmr.batch_number.recover ebmr.batch_number.register_external ebmr.batch_number.void ebmr.continuity.counter_reserve ebmr.incident.raise ebmr.market.rule_evaluate ebmr.record.read |
| CONTRACT_GIVER_REVIEWER | ebmr.contract_giver.read ebmr.record.read |
| CSV_DI_LEAD | ebmr.analytics.disposition ebmr.analytics.di_review ebmr.analytics.view ebmr.config.change_close ebmr.config.change_raise ebmr.config.system_description ebmr.incident.cert_in_report ebmr.incident.investigate ebmr.incident.raise ebmr.platform.alarm_clear ebmr.platform.time_source_validate ebmr.record.export ebmr.record.read ebmr.record.type_define ebmr.validation.manage |
| DISPENSER | ebmr.controlled.custody ebmr.controlled.read ebmr.deviation.raise ebmr.dispense.execute ebmr.incident.raise ebmr.record.read ebmr.step.sign_performed |
| EU_QP | ebmr.analytics.view ebmr.record.read ebmr.release.eu_qp_certify |
| EU_QP_READER | ebmr.qp_package.read |
| HEAD_OF_PRODUCTION | ebmr.analytics.view ebmr.capa.record ebmr.deviation.raise ebmr.evidence.store ebmr.formula.read ebmr.incident.raise ebmr.notification.acknowledge ebmr.record.production_approve ebmr.record.read |
| HEAD_OF_QC | ebmr.capa.record ebmr.controlled.read ebmr.controlled.register ebmr.deviation.investigate ebmr.deviation.raise ebmr.evidence.store ebmr.formula.read ebmr.incident.raise ebmr.material.release ebmr.pqr.extract ebmr.qc.result_approve ebmr.recall.mock_run ebmr.record.read ebmr.sample.pull ebmr.shelf_life.record ebmr.specification.approve ebmr.specification.draft |
| INSPECTION_READER | ebmr.archive.inspect |
| MAINTENANCE_TECHNICIAN | ebmr.incident.raise ebmr.logbook.entry ebmr.logbook.sign ebmr.record.read |
| MASTER_DATA_STEWARD | ebmr.batch_number.rule_define ebmr.config.change_close ebmr.config.change_raise ebmr.formula.approve ebmr.formula.manage ebmr.formula.read ebmr.label.design ebmr.market.rule_table_publish ebmr.market.site_value_set ebmr.masterdata.change ebmr.master_data.enter ebmr.record.read |
| MBR_AUTHOR | ebmr.formula.read ebmr.label.design ebmr.market.rule_evaluate ebmr.mbr.author ebmr.mbr.sign_prepared ebmr.record.read ebmr.sample_record.submit |
| MBR_CHECKER | ebmr.formula.read ebmr.mbr.check ebmr.record.read ebmr.sample_record.check |
| OPERATOR | ebmr.alarm.acknowledge ebmr.contingency.reconcile ebmr.deviation.raise ebmr.evidence.store ebmr.incident.raise ebmr.market.rule_evaluate ebmr.record.read ebmr.step.execute ebmr.step.sign_performed |
| PROCESS_OWNER | ebmr.alarm.acknowledge_gap ebmr.analytics.method ebmr.config.change_close ebmr.config.change_raise ebmr.config.system_description ebmr.continuity.alarm_acknowledge ebmr.platform.settings_change ebmr.record.read ebmr.support.approve_it ebmr.system.periodic_review |
| QA_MBR_APPROVER | ebmr.config.change_approve ebmr.config.change_close ebmr.config.change_raise ebmr.controlled.approve ebmr.controlled.read ebmr.controlled.record ebmr.erp.master_confirm ebmr.formula.approve ebmr.formula.read ebmr.hazard.approve ebmr.hazard.record ebmr.label.approve ebmr.licence.approve ebmr.market.policy_change ebmr.mbr.approve ebmr.mbr.change_record ebmr.notification.acknowledge ebmr.plant_rule.approve ebmr.record.read ebmr.record.type_approve ebmr.record.type_define ebmr.review.rbe_rule_change ebmr.shelf_life.record ebmr.support.approve_qa ebmr.validation.approve_evaluation ebmr.validation.approve_summary |
| QA_REVIEWER | ebmr.alarm.acknowledge_gap ebmr.analytics.disposition ebmr.analytics.method ebmr.analytics.view ebmr.archive.inspect ebmr.capa.qa_approve ebmr.capa.record ebmr.config.change_approve ebmr.contingency.issue ebmr.contingency.reconcile ebmr.contract_giver_access.grant ebmr.controlled.approve ebmr.controlled.read ebmr.controlled.register ebmr.deviation.classify ebmr.deviation.investigate ebmr.deviation.qa_approve ebmr.deviation.raise ebmr.di_investigation.approve_closure ebmr.evidence.store ebmr.formula.read ebmr.hazard.approve ebmr.incident.cert_in_report ebmr.incident.close ebmr.incident.investigate ebmr.incident.raise ebmr.licence.approve ebmr.market.policy_tighten_batch ebmr.market.rule_evaluate ebmr.material.qa_disposition ebmr.material.release ebmr.notification.acknowledge ebmr.plant_rule.approve ebmr.pqr.extract ebmr.qp_access.grant ebmr.recall.mock_run ebmr.record.audit_trail_review ebmr.record.disposal_approve ebmr.record.legal_hold ebmr.record.qa_review ebmr.record.read ebmr.record.retention_manage ebmr.record.true_copy_register ebmr.release.disposal ebmr.review.rbe_rule_change ebmr.sample.dispose ebmr.sample_record.approve ebmr.sample_record.check ebmr.sample_record.retire ebmr.specification.approve ebmr.transfer.peer_approve ebmr.validation.approve_evaluation ebmr.validation.approve_summary |
| QA_SHOP_FLOOR | ebmr.capa.record ebmr.contingency.issue ebmr.contingency.reconcile ebmr.controlled.balance ebmr.controlled.custody ebmr.controlled.read ebmr.deviation.classify ebmr.deviation.investigate ebmr.deviation.raise ebmr.evidence.store ebmr.formula.read ebmr.incident.raise ebmr.notification.acknowledge ebmr.qa.floor_approve ebmr.record.read ebmr.reprocessing.authorise ebmr.step.witness |
| QC_ANALYST | ebmr.deviation.raise ebmr.evidence.store ebmr.formula.read ebmr.incident.raise ebmr.qc.result_record ebmr.record.read ebmr.sample.pull ebmr.specification.draft |
| REGULATORY_SIGNER | ebmr.formula.read ebmr.licence.record ebmr.market.rule_table_correct ebmr.mbr.change_record ebmr.mbr.regulatory_confirm ebmr.record.read |
| SHIFT_SUPERVISOR | ebmr.alarm.acknowledge ebmr.contingency.issue ebmr.contingency.reconcile ebmr.controlled.balance ebmr.controlled.custody ebmr.controlled.read ebmr.deviation.approve_inline ebmr.deviation.raise ebmr.evidence.store ebmr.incident.raise ebmr.notification.acknowledge ebmr.record.read ebmr.step.supervise |
| STAGE_RESPONSIBLE | ebmr.controlled.balance ebmr.controlled.read ebmr.deviation.raise ebmr.incident.raise ebmr.record.production_approve ebmr.record.read |
| SYSTEM_ADMINISTRATOR | ebmr.continuity.alarm_acknowledge ebmr.continuity.hardening_attest ebmr.platform.operate ebmr.platform.time_source_manage ebmr.record.read ebmr.support.grant_request ebmr.system.configure |
| TRAINING_COORDINATOR | ebmr.qualification.record ebmr.record.read ebmr.training.manage |
| US_QCU_SIGNER | ebmr.record.read ebmr.release.us_disposition |
| VERIFIER | ebmr.controlled.custody ebmr.controlled.read ebmr.deviation.raise ebmr.incident.raise ebmr.record.read ebmr.step.verify ebmr.step.witness |
| WAREHOUSE_LABELLING | ebmr.controlled.custody ebmr.controlled.read ebmr.controlled.register ebmr.deviation.raise ebmr.incident.raise ebmr.labelling.issue ebmr.label_store.transact ebmr.material.handle ebmr.record.read |
