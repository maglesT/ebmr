# Batchwright on the platform: permission list (A10, platform D-16), draft for approval

Generated from the `iam.permission` rows of the migrations (163 codes). Each code the database checks today with
`iam.require_permission` becomes one platform code `ebmr.<code in lower case>`; the label is today's description.
Domain and effect stay in Batchwright: they drive DI-18 (administration never does GMP work in the same session),
read-only and service-account rules, unchanged.

## In the manifest (140)

| Platform code | Today | Domain | Effect | Label |
|---|---|---|---|---|
| `ebmr.alarm.acknowledge` | ALARM.ACKNOWLEDGE | GMP | ACKNOWLEDGE | Acknowledge process alarms in batch context |
| `ebmr.alarm.acknowledge_gap` | ALARM.ACKNOWLEDGE_GAP | GMP | ACKNOWLEDGE | Acknowledge a sequence gap on a blocking mirror's adapter, accounting for lost messages (DI-31) |
| `ebmr.analytics.disposition` | ANALYTICS.DISPOSITION | GOVERNANCE | WRITE | Record a verdict on an advisory analytics flag (DI-52) |
| `ebmr.analytics.di_review` | ANALYTICS.DI_REVIEW | READ_ONLY | READ | Read advisory analytics flags about a person or an account (data-integrity review; DI-53) |
| `ebmr.analytics.method` | ANALYTICS.METHOD | GOVERNANCE | WRITE | Make an analytics method version or reference set effective, under an approved change record (DI-52, DI-09) |
| `ebmr.analytics.view` | ANALYTICS.VIEW | READ_ONLY | READ | Read the advisory analytics screens (not for GMP decisions; DI-51) |
| `ebmr.archive.inspect` | ARCHIVE.INSPECT | READ_ONLY | READ | Read certified evidence exports in the read-only inspection workspace (every read logged) |
| `ebmr.batch.issue` | BATCH.ISSUE | GMP | SIGN | Issue a batch record from an effective MBR and sign it as issued |
| `ebmr.batch_number.allocate` | BATCH_NUMBER.ALLOCATE | GMP | WRITE | Allocate a batch number from the rule in force |
| `ebmr.batch_number.recover` | BATCH_NUMBER.RECOVER | GMP | WRITE | Re-enter a batch number issued in the window a restore lost, with its evidence |
| `ebmr.batch_number.register_external` | BATCH_NUMBER.REGISTER_EXTERNAL | GMP | WRITE | Register a batch number issued by an external system |
| `ebmr.batch_number.rule_define` | BATCH_NUMBER.RULE_DEFINE | GMP | WRITE | Define a batch-number rule of a site |
| `ebmr.batch_number.void` | BATCH_NUMBER.VOID | GMP | WRITE | Void an allocated batch number, with its reason |
| `ebmr.capa.qa_approve` | CAPA.QA_APPROVE | GMP | SIGN | QA closure and cancellation of a CAPA (never by the person who raised it) |
| `ebmr.capa.record` | CAPA.RECORD | GMP | WRITE | Raise a CAPA, link it to deviations and to the master version it waits for, record its implementation, schedule and record effectiveness checks |
| `ebmr.config.change_approve` | CONFIG.CHANGE_APPROVE | GMP | SIGN | Record the quality unit's approval of a configuration change record (DI-09) |
| `ebmr.config.change_close` | CONFIG.CHANGE_CLOSE | GMP | WRITE | Close a configuration change record (DI-09) |
| `ebmr.config.change_raise` | CONFIG.CHANGE_RAISE | GMP | WRITE | Raise a configuration change record (DI-09) |
| `ebmr.config.system_description` | CONFIG.SYSTEM_DESCRIPTION | GMP | WRITE | Record an interface of the approved system description, under an approved change record (DI-06, DI-09) |
| `ebmr.contingency.issue` | CONTINGENCY.ISSUE | GMP | WRITE | Issue a numbered contingency pack (paper forms) for a batch at its issue or at a stage start |
| `ebmr.contingency.reconcile` | CONTINGENCY.RECONCILE | GMP | WRITE | Record the return, transcription, verification, void or loss of an issued contingency form |
| `ebmr.continuity.alarm_acknowledge` | CONTINUITY.ALARM_ACKNOWLEDGE | GOVERNANCE | ACKNOWLEDGE | Acknowledge continuity alarms (backup, restore-drill, number-ledger and audit-chain alarms) |
| `ebmr.continuity.counter_reserve` | CONTINUITY.COUNTER_RESERVE | GMP | WRITE | Acknowledge a write-ahead ceiling of a protected number counter (in the counter's site) |
| `ebmr.continuity.hardening_attest` | CONTINUITY.HARDENING_ATTEST | ADMINISTRATION | ADMINISTER | Record and revoke hardening attestations of shop-floor terminals |
| `ebmr.contract_giver.read` | CONTRACT_GIVER.READ | READ_ONLY | READ | Read the batch records of the loan licence a live contract-giver access names (every read logged) |
| `ebmr.contract_giver_access.grant` | CONTRACT_GIVER_ACCESS.GRANT | GMP | WRITE | Grant or revoke a time-boxed, read-only contract-giver access to the batches of one loan licence |
| `ebmr.controlled.approve` | CONTROLLED.APPROVE | GMP | SIGN | Approve a controlled-substance flag recorded by another person (IN-53) |
| `ebmr.controlled.balance` | CONTROLLED.BALANCE | GMP | SIGN | Record and sign the controlled-API account of a batch at a yield checkpoint (IN-53) |
| `ebmr.controlled.custody` | CONTROLLED.CUSTODY | GMP | SIGN | Propose and sign a dual-custody record of a controlled API: dispensing, transfer, return or destruction (IN-53) |
| `ebmr.controlled.read` | CONTROLLED.READ | READ_ONLY | READ | Read the controlled-substance list, balance and register (IN-53) |
| `ebmr.controlled.record` | CONTROLLED.RECORD | GMP | WRITE | Record a product's controlled-substance flag and its controlled API materials (QA; IN-53) |
| `ebmr.controlled.register` | CONTROLLED.REGISTER | GMP | WRITE | Run the controlled-substance register export (IN-53) |
| `ebmr.deviation.approve_inline` | DEVIATION.APPROVE_INLINE | GMP | SIGN | Approve in-line exceptions of the classes the holder is designated competent for |
| `ebmr.deviation.classify` | DEVIATION.CLASSIFY | GMP | WRITE | QA classification of a deviation record with its risk rationale, owner and due date (never by its initiator) |
| `ebmr.deviation.investigate` | DEVIATION.INVESTIGATE | GMP | WRITE | Start the investigation of a deviation-lite record and record its finding (assignable cause, cause, root-cause category) |
| `ebmr.deviation.qa_approve` | DEVIATION.QA_APPROVE | GMP | SIGN | QA conclusion, closure and cancellation of a deviation-lite record (never by its initiator) |
| `ebmr.deviation.raise` | DEVIATION.RAISE | GMP | WRITE | Raise a deviation, OOS or investigation record and link it to the batches, lots and containers it concerns |
| `ebmr.dispense.execute` | DISPENSE.EXECUTE | GMP | WRITE | Dispense materials against a batch as a designated dispenser |
| `ebmr.di_investigation.approve_closure` | DI_INVESTIGATION.APPROVE_CLOSURE | GMP | SIGN | Approve the closure of a data-integrity investigation (never the investigator or the person investigated) |
| `ebmr.erp.master_confirm` | ERP.MASTER_CONFIRM | GMP | SIGN | Confirm a received ERP master version that changes a controlled value (ERP_MASTER_CONFIRMED) |
| `ebmr.evidence.store` | EVIDENCE.STORE | GMP | WRITE | Store an evidence document (its hash, media type, size and storage key) for a GMP record to cite |
| `ebmr.formula.approve` | FORMULA.APPROVE | GMP | SIGN | Approve a formula version written by another person (FORMULA_APPROVED) |
| `ebmr.formula.manage` | FORMULA.MANAGE | GMP | WRITE | Record a formula and write draft versions of its per-unit composition |
| `ebmr.formula.read` | FORMULA.READ | READ_ONLY | READ | Read a formula's composition (confidential master data of the dossier) and the composition of an MBR taken from it |
| `ebmr.hazard.approve` | HAZARD.APPROVE | GMP | SIGN | Approve a product's hazard classification or an area's dedication recorded by another person (IN-27) |
| `ebmr.hazard.record` | HAZARD.RECORD | GMP | WRITE | Record a product's hazard class from its risk assessment and the rooms and lines dedicated to a hazard class (QA) |
| `ebmr.iam.alert_acknowledge` | IAM.ALERT_ACKNOWLEDGE | GOVERNANCE | ACKNOWLEDGE | Acknowledge security alerts |
| `ebmr.iam.certification_record` | IAM.CERTIFICATION_RECORD | GOVERNANCE | WRITE | Record the legal entity's US electronic-signature certification letter (11.100(c)) |
| `ebmr.iam.device_manage` | IAM.DEVICE_MANAGE | ADMINISTRATION | ADMINISTER | Register, block, relocate and decommission devices |
| `ebmr.iam.policy_manage` | IAM.POLICY_MANAGE | ADMINISTRATION | ADMINISTER | Change identity policy values within their allowed ranges |
| `ebmr.incident.cert_in_report` | INCIDENT.CERT_IN_REPORT | GMP | WRITE | Mark an incident as reportable to CERT-In and record the report |
| `ebmr.incident.close` | INCIDENT.CLOSE | GMP | WRITE | Close an incident under investigation (root cause and CAPA when it was ever major or critical) |
| `ebmr.incident.investigate` | INCIDENT.INVESTIGATE | GMP | WRITE | Reclassify an incident, start its investigation and assess its impact on linked records |
| `ebmr.incident.raise` | INCIDENT.RAISE | GMP | WRITE | Raise an incident and link the records it affects |
| `ebmr.label.approve` | LABEL.APPROVE | GMP | WRITE | Approve a label template another person designed (IN-31) |
| `ebmr.label.design` | LABEL.DESIGN | GMP | WRITE | Save label template versions (layout and record-field bindings only) |
| `ebmr.labelling.issue` | LABELLING.ISSUE | GMP | WRITE | Issue labelling and packaging materials |
| `ebmr.label_store.transact` | LABEL_STORE.TRANSACT | GMP | WRITE | Open a label-store transaction: receipt, issue, return or destruction of printed material (PR-32) |
| `ebmr.licence.approve` | LICENCE.APPROVE | GMP | SIGN | Approve a recorded licence or export permission (never its recorder) and record its suspension or cancellation (QA) |
| `ebmr.licence.record` | LICENCE.RECORD | GMP | WRITE | Record a manufacturing or loan licence, or an export permission, as the authority granted it (regulatory affairs) |
| `ebmr.logbook.entry` | LOGBOOK.ENTRY | GMP | WRITE | Cleaning, maintenance and calibration logbook entries |
| `ebmr.logbook.sign` | LOGBOOK.SIGN | GMP | SIGN | Sign logbook entries |
| `ebmr.market.policy_change` | MARKET.POLICY_CHANGE | GMP | WRITE | Define a policy switch and schedule its versions (a loosening needs an approval record and a change reference) |
| `ebmr.market.policy_tighten_batch` | MARKET.POLICY_TIGHTEN_BATCH | GMP | WRITE | Apply a stricter policy version already in force to an issued batch |
| `ebmr.market.rule_evaluate` | MARKET.RULE_EVALUATE | GMP | WRITE | Resolve a rule for a scope and store the evaluation (Phase 1 stub scopes) |
| `ebmr.market.rule_table_correct` | MARKET.RULE_TABLE_CORRECT | GMP | WRITE | Publish a SOURCE_CORRECTION version of a market rule table (citation and two other approvers) |
| `ebmr.market.rule_table_publish` | MARKET.RULE_TABLE_PUBLISH | GMP | WRITE | Publish the next version (INITIAL or UPDATE) of a market rule table under change control |
| `ebmr.market.site_value_set` | MARKET.SITE_VALUE_SET | GMP | WRITE | Set a site value for a rule key (tighten only; loosening guidance needs a justification and QA approval) |
| `ebmr.masterdata.change` | MASTERDATA.CHANGE | GMP | WRITE | Change master data under change control |
| `ebmr.master_data.enter` | MASTER_DATA.ENTER | GMP | WRITE | Enter a product or material master version on screen when the ERP does not send it (QA confirms every one) |
| `ebmr.material.handle` | MATERIAL.HANDLE | GMP | WRITE | Receipt, staging, kitting and returns of materials |
| `ebmr.material.qa_disposition` | MATERIAL.QA_DISPOSITION | GMP | SIGN | QA disposition of a material lot |
| `ebmr.material.release` | MATERIAL.RELEASE | GMP | SIGN | Release or reject a quarantined material lot for use, with its release route (QC or QA) |
| `ebmr.mbr.approve` | MBR.APPROVE | GMP | SIGN | Approve an MBR version for the quality unit |
| `ebmr.mbr.author` | MBR.AUTHOR | GMP | WRITE | Compose and edit MBR versions and library elements |
| `ebmr.mbr.change_record` | MBR.CHANGE_RECORD | GMP | WRITE | Record the change-control records and risk assessments that MBR versions cite |
| `ebmr.mbr.check` | MBR.CHECK | GMP | SIGN | Sign an MBR version as independently checked |
| `ebmr.mbr.regulatory_confirm` | MBR.REGULATORY_CONFIRM | GMP | SIGN | Confirm registration references and registered flags per market |
| `ebmr.mbr.sign_prepared` | MBR.SIGN_PREPARED | GMP | SIGN | Sign an MBR version as prepared |
| `ebmr.notification.acknowledge` | NOTIFICATION.ACKNOWLEDGE | GMP | WRITE | Acknowledge a notification addressed to your department (IN-39) |
| `ebmr.plant_rule.approve` | PLANT_RULE.APPROVE | GMP | SIGN | Approve a penicillin facility rule or a beta-lactam classification proposed by another person (PR-27) |
| `ebmr.platform.alarm_clear` | PLATFORM.ALARM_CLEAR | GOVERNANCE | WRITE | Clear a time alarm the monitor does not re-check, ending its fault window (platform.alarm.clear) |
| `ebmr.platform.operate` | PLATFORM.OPERATE | ADMINISTRATION | ADMINISTER | Start, stop and restart the server's background workers; on demo and sandbox installations load or reset the demo data and drive the simulators |
| `ebmr.platform.settings_change` | PLATFORM.SETTINGS_CHANGE | GOVERNANCE | WRITE | Change a platform setting within its allowed range (platform.settings.change) |
| `ebmr.platform.time_check_record` | PLATFORM.TIME_CHECK_RECORD | GOVERNANCE | WRITE | Record the time monitor's drift readings, which raise and clear time alarms (platform.time_check.record) |
| `ebmr.platform.time_source_manage` | PLATFORM.TIME_SOURCE_MANAGE | ADMINISTRATION | ADMINISTER | Register, activate and deactivate time sources (platform.time_source.manage) |
| `ebmr.platform.time_source_validate` | PLATFORM.TIME_SOURCE_VALIDATE | GOVERNANCE | WRITE | Confirm a registered time source is validated, as the named validator |
| `ebmr.pqr.extract` | PQR.EXTRACT | GMP | WRITE | Run the product quality review extract for a product and period (IN-01, PR-58) |
| `ebmr.pqr.sign_off` | PQR.SIGN_OFF | GMP | SIGN | Sign off a product quality review extract as the authorised person (IN-01 (b)) |
| `ebmr.qa.floor_approve` | QA.FLOOR_APPROVE | GMP | SIGN | Approve critical exceptions on the shop floor in real time |
| `ebmr.qc.result_approve` | QC.RESULT_APPROVE | GMP | SIGN | Approve QC results used for release |
| `ebmr.qc.result_record` | QC.RESULT_RECORD | GMP | WRITE | Record QC results |
| `ebmr.qp_access.grant` | QP_ACCESS.GRANT | GMP | WRITE | Grant or revoke a read-only, time-boxed QP access to the batch packages of one lot |
| `ebmr.qp_package.read` | QP_PACKAGE.READ | READ_ONLY | READ | Read the issued EU QP batch packages of the one lot a live, time-boxed QP access names |
| `ebmr.qualification.record` | QUALIFICATION.RECORD | GOVERNANCE | WRITE | Record or withdraw person qualifications in the qualification register |
| `ebmr.recall.mock_run` | RECALL.MOCK_RUN | GMP | WRITE | Run a mock recall from a lot or a deviation as of an instant (IN-29, PR-57) |
| `ebmr.recall.mock_sign_off` | RECALL.MOCK_SIGN_OFF | GMP | SIGN | Sign off a mock recall as the authorised person who owns recall execution (IN-29) |
| `ebmr.record.audit_trail_review` | RECORD.AUDIT_TRAIL_REVIEW | GMP | SIGN | Review and sign the batch audit trail |
| `ebmr.record.disposal_approve` | RECORD.DISPOSAL_APPROVE | GMP | SIGN | Approve the disposal of a record whose retention has ended |
| `ebmr.record.export` | RECORD.EXPORT | READ_ONLY | READ | Export records (every export is logged) |
| `ebmr.record.legal_hold` | RECORD.LEGAL_HOLD | GMP | WRITE | Place and release legal holds on records |
| `ebmr.record.production_approve` | RECORD.PRODUCTION_APPROVE | GMP | SIGN | Approve a completed processing or packaging record before QA review |
| `ebmr.record.purge` | RECORD.PURGE | GMP | WRITE | Execute an approved purge of a record after its retention (retention job) |
| `ebmr.record.qa_review` | RECORD.QA_REVIEW | GMP | SIGN | QA review of a batch record and its exceptions |
| `ebmr.record.read` | RECORD.READ | READ_ONLY | READ | View and search records |
| `ebmr.record.retention_manage` | RECORD.RETENTION_MANAGE | GMP | WRITE | Create retention schedules, change retention inputs and link retention dependencies |
| `ebmr.record.true_copy_register` | RECORD.TRUE_COPY_REGISTER | GMP | WRITE | Register a verified true copy (archive bundle) of a record |
| `ebmr.record.type_approve` | RECORD.TYPE_APPROVE | GMP | SIGN | Approve a record-type version so it becomes current (never one's own) |
| `ebmr.record.type_define` | RECORD.TYPE_DEFINE | GMP | WRITE | Define a new version of a record type in the record-type register |
| `ebmr.release.disposal` | RELEASE.DISPOSAL | GMP | SIGN | Record the disposal of a rejected or recalled finished lot (witnessed destruction, reprocessing or return; PR-46) |
| `ebmr.release.eu_qp_certify` | RELEASE.EU_QP_CERTIFY | GMP | SIGN | Qualified-person certification, only when the in-system QP feature is on |
| `ebmr.release.manufacturer` | RELEASE.MANUFACTURER | GMP | SIGN | Manufacturer release, rejection or hold (India authorised person or named delegate) |
| `ebmr.release.us_disposition` | RELEASE.US_DISPOSITION | GMP | SIGN | Quality-unit disposition of a lot for the US market |
| `ebmr.reprocessing.authorise` | REPROCESSING.AUTHORISE | GMP | SIGN | Authorise reprocessing of a batch |
| `ebmr.review.rbe_rule_change` | REVIEW.RBE_RULE_CHANGE | GMP | WRITE | Change a review-by-exception rule under an approved change record (DI-26, DI-09) |
| `ebmr.sample.dispose` | SAMPLE.DISPOSE | GMP | WRITE | Dispose of a reserve or retention sample after its retention period (QA) |
| `ebmr.sample.pull` | SAMPLE.PULL | GMP | WRITE | Pull a reserve sample of a finished lot or a retention sample of a starting material (QC) |
| `ebmr.sample_record.approve` | SAMPLE_RECORD.APPROVE | GMP | SIGN | Sample state machine (Phase 1 scaffolding): approve, return or supersede a sample record |
| `ebmr.sample_record.check` | SAMPLE_RECORD.CHECK | GMP | SIGN | Sample state machine (Phase 1 scaffolding): check or return a submitted sample record |
| `ebmr.sample_record.retire` | SAMPLE_RECORD.RETIRE | GMP | WRITE | Sample state machine (Phase 1 scaffolding): retire an approved sample record |
| `ebmr.sample_record.submit` | SAMPLE_RECORD.SUBMIT | GMP | WRITE | Sample state machine (Phase 1 scaffolding): submit a sample record |
| `ebmr.shelf_life.record` | SHELF_LIFE.RECORD | GMP | WRITE | Record the stability basis of a product's shelf life (head of QC, QA) |
| `ebmr.specification.approve` | SPECIFICATION.APPROVE | GMP | SIGN | Approve a specification version (never its drafter) and mark a pharmacopoeia edition effective (QA, head of QC) |
| `ebmr.specification.draft` | SPECIFICATION.DRAFT | GMP | WRITE | Draft a new version of a material's specification: tests, limits, units, pharmacopoeia and edition (QC) |
| `ebmr.step.execute` | STEP.EXECUTE | GMP | WRITE | Execute steps, scan and capture data |
| `ebmr.step.sign_performed` | STEP.SIGN_PERFORMED | GMP | SIGN | Sign a step as performed |
| `ebmr.step.supervise` | STEP.SUPERVISE | GMP | SIGN | Supervise execution and hand-over |
| `ebmr.step.verify` | STEP.VERIFY | GMP | SIGN | Verify an entry or step performed by someone else |
| `ebmr.step.witness` | STEP.WITNESS | GMP | SIGN | Witness an act as it happens |
| `ebmr.support.approve_it` | SUPPORT.APPROVE_IT | GOVERNANCE | SIGN | Approve a vendor support grant for IT, as system or process owner (one of its two customer signatures) |
| `ebmr.support.approve_qa` | SUPPORT.APPROVE_QA | GOVERNANCE | SIGN | Approve a vendor support grant for the quality unit (one of its two customer signatures) |
| `ebmr.support.grant_request` | SUPPORT.GRANT_REQUEST | ADMINISTRATION | ADMINISTER | Request a time-boxed support grant for a named vendor support account |
| `ebmr.system.configure` | SYSTEM.CONFIGURE | ADMINISTRATION | ADMINISTER | Deploy configuration under change control |
| `ebmr.system.periodic_review` | SYSTEM.PERIODIC_REVIEW | GOVERNANCE | SIGN | Sign the periodic system review |
| `ebmr.system.vendor_support` | SYSTEM.VENDOR_SUPPORT | ADMINISTRATION | ADMINISTER | Named, time-boxed, customer-approved vendor support access |
| `ebmr.training.manage` | TRAINING.MANAGE | GOVERNANCE | WRITE | Maintain curricula, qualification types and qualification requirements |
| `ebmr.transfer.peer_approve` | TRANSFER.PEER_APPROVE | GMP | SIGN | Approve or revoke the trust in another site installation whose packages and answers this site accepts (L-41, DI-31) |
| `ebmr.validation.approve_evaluation` | VALIDATION.APPROVE_EVALUATION | GMP | SIGN | Sign off the periodic evaluation pack of the system (DI-11) |
| `ebmr.validation.approve_summary` | VALIDATION.APPROVE_SUMMARY | GMP | SIGN | Approve the validation summary of the running release (DI-03) |
| `ebmr.validation.manage` | VALIDATION.MANAGE | GOVERNANCE | WRITE | Maintain validation evidence and data-integrity investigations |

## Not in the manifest (23)

| Today | Why |
|---|---|
| CONTINUITY.BACKUP_READ | platform backups and restore (PL-11) |
| CONTINUITY.BACKUP_RECORD | platform backups and restore (PL-11) |
| CONTINUITY.BACKUP_RUN | platform backups and restore (PL-11) |
| CONTINUITY.RESTORE_APPROVE | platform backups and restore (PL-11) |
| CONTINUITY.RESTORE_OPERATE | platform backups and restore (PL-11) |
| ERP.MASTER_WRITE | service accounts only; stays local, not a person code |
| EXECUTION.SWEEP | service accounts only; stays local, not a person code |
| FEDERATION.ANSWER | service accounts only; stays local, not a person code |
| GATEWAY.API_CONTACT_RECORD | service accounts only; stays local, not a person code |
| GENEALOGY.FEDERATE | service accounts only; stays local, not a person code |
| IAM.ACCESS_RECERTIFY | core does it (people, grants, passwords, unlock, recertification) |
| IAM.ACCOUNT_MANAGE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.BREAK_GLASS_APPROVE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.CREDENTIAL_ISSUE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.DELEGATION_APPROVE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.GRANT_APPROVE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.GRANT_REQUEST | core does it (people, grants, passwords, unlock, recertification) |
| IAM.GRANT_REVOKE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.IDENTITY_VERIFY | core does it (people, grants, passwords, unlock, recertification) |
| IAM.PERSON_MANAGE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.ROLE_MANAGE | core does it (people, grants, passwords, unlock, recertification) |
| IAM.UNLOCK | core does it (people, grants, passwords, unlock, recertification) |
| INTERFACE.WRITE | service accounts only; stays local, not a person code |

## Old role → codes (for the move)

The move reads `iam.role_permission` (today's role → permission map, data in the database, unchanged since R3)
and gives each person the union of the codes of their current, unexpired role grants, minus the codes above. Nobody
who is deactivated or locked gets a code, and their existing `ebmr.*` codes are revoked. The generated role → codes
table is part of the move's mapping report. Moved SYSTEM_ADMINISTRATOR holders also get `core.people.manage` (as in
the other products).
