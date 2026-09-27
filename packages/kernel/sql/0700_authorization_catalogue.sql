-- Authorization (B7), part 1: permission catalogue entries for every protected action of the
-- market, records, continuity, site-services (batch-number register) and platform modules, and their
-- mapping to the kernel roles (DI-17 least privilege; DI-18 / INV-11 administrators kept out of GMP data).
--
-- Domains follow the identity module's rules (0120): GMP for anything that creates or changes GMP
-- data (so INV-11 keeps every holder away from administrator roles and break-glass accounts never
-- hold it), ADMINISTRATION for pure IT functions, GOVERNANCE for oversight that is neither. Service
-- accounts hold only WRITE effects (they never sign or acknowledge, DI-14).
--
-- The catalogue tables are audited (kernel.register_audited_table in 0120), so rows added after
-- 0120 need an actor. A migration has no person behind it; like the installation bootstrap (0180),
-- the rows are attributed to a clearly labelled pipeline identity: nil person, account and session,
-- role SOFTWARE_RELEASE, source SYSTEM, reason code SOFTWARE_RELEASE. Each row is therefore both in
-- the hash-chained audit trail (chains iam_permission:<code> and iam_role:<role>) and covered by this
-- migration's checksum. Later migrations extend the catalogue the same way.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 0700_authorization_catalogue)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'permission catalogue for the authority checks of the kernel modules (DI-17, DI-18)'));

insert into iam.permission (code, domain, effect, description) values
  -- market-profile engine
  ('MARKET.RULE_TABLE_PUBLISH', 'GMP', 'WRITE', 'Publish the next version (INITIAL or UPDATE) of a market rule table under change control'),
  ('MARKET.RULE_TABLE_CORRECT', 'GMP', 'WRITE', 'Publish a SOURCE_CORRECTION version of a market rule table (citation and two other approvers)'),
  ('MARKET.SITE_VALUE_SET', 'GMP', 'WRITE', 'Set a site value for a rule key (tighten only; loosening guidance needs a justification and QA approval)'),
  ('MARKET.POLICY_CHANGE', 'GMP', 'WRITE', 'Define a policy switch and schedule its versions (a loosening needs an approval record and a change reference)'),
  ('MARKET.POLICY_TIGHTEN_BATCH', 'GMP', 'WRITE', 'Apply a stricter policy version already in force to an issued batch'),
  ('MARKET.RULE_EVALUATE', 'GMP', 'WRITE', 'Resolve a rule for a scope and store the evaluation (Phase 1 stub scopes)'),
  -- records
  ('RECORD.TYPE_DEFINE', 'GMP', 'WRITE', 'Define a new version of a record type in the record-type register'),
  ('RECORD.TYPE_APPROVE', 'GMP', 'SIGN', 'Approve a record-type version so it becomes current (never one''s own)'),
  ('RECORD.RETENTION_MANAGE', 'GMP', 'WRITE', 'Create retention schedules, change retention inputs and link retention dependencies'),
  ('RECORD.LEGAL_HOLD', 'GMP', 'WRITE', 'Place and release legal holds on records'),
  ('RECORD.DISPOSAL_APPROVE', 'GMP', 'SIGN', 'Approve the disposal of a record whose retention has ended'),
  ('RECORD.PURGE', 'GMP', 'WRITE', 'Execute an approved purge of a record after its retention (retention job)'),
  ('RECORD.TRUE_COPY_REGISTER', 'GMP', 'WRITE', 'Register a verified true copy (archive bundle) of a record'),
  ('INCIDENT.RAISE', 'GMP', 'WRITE', 'Raise an incident and link the records it affects'),
  ('INCIDENT.INVESTIGATE', 'GMP', 'WRITE', 'Reclassify an incident, start its investigation and assess its impact on linked records'),
  ('INCIDENT.CLOSE', 'GMP', 'WRITE', 'Close an incident under investigation (root cause and CAPA when it was ever major or critical)'),
  ('INCIDENT.CERT_IN_REPORT', 'GMP', 'WRITE', 'Mark an incident as reportable to CERT-In and record the report'),
  ('DI_INVESTIGATION.APPROVE_CLOSURE', 'GMP', 'SIGN', 'Approve the closure of a data-integrity investigation (never the investigator or the person investigated)'),
  -- continuity
  ('CONTINUITY.RESTORE_OPERATE', 'ADMINISTRATION', 'ADMINISTER', 'Record a database restore or failover and complete the restore procedure once it is approved'),
  ('CONTINUITY.RESTORE_APPROVE', 'GMP', 'SIGN', 'Approve a recorded restore event as a named second person'),
  ('CONTINUITY.BACKUP_RECORD', 'GOVERNANCE', 'WRITE', 'Record backup job runs and restore-drill results (system service accounts)'),
  ('CONTINUITY.HARDENING_ATTEST', 'ADMINISTRATION', 'ADMINISTER', 'Record and revoke hardening attestations of shop-floor terminals'),
  ('CONTINUITY.ALARM_ACKNOWLEDGE', 'GOVERNANCE', 'ACKNOWLEDGE', 'Acknowledge continuity alarms (backup, restore-drill and number-ledger alarms)'),
  ('CONTINUITY.COUNTER_RESERVE', 'GMP', 'WRITE', 'Acknowledge a write-ahead ceiling of a protected number counter'),
  -- site services: batch-number register
  ('BATCH_NUMBER.RULE_DEFINE', 'GMP', 'WRITE', 'Define a batch-number rule of a site'),
  ('BATCH_NUMBER.ALLOCATE', 'GMP', 'WRITE', 'Allocate a batch number from the rule in force'),
  ('BATCH_NUMBER.REGISTER_EXTERNAL', 'GMP', 'WRITE', 'Register a batch number issued by an external system'),
  ('BATCH_NUMBER.VOID', 'GMP', 'WRITE', 'Void an allocated batch number, with its reason'),
  ('BATCH_NUMBER.RECOVER', 'GMP', 'WRITE', 'Re-enter a batch number issued in the window a restore lost, with its evidence'),
  -- platform (names the platform uses, mapped by iam.platform_permission_code, 0710)
  ('PLATFORM.SETTINGS_CHANGE', 'GOVERNANCE', 'WRITE', 'Change a platform setting within its allowed range (platform.settings.change)'),
  ('PLATFORM.TIME_SOURCE_MANAGE', 'ADMINISTRATION', 'ADMINISTER', 'Register, activate and deactivate time sources (platform.time_source.manage)'),
  ('PLATFORM.ALARM_CLEAR', 'GOVERNANCE', 'WRITE', 'Clear a time alarm the monitor does not re-check, ending its fault window (platform.alarm.clear)'),
  ('PLATFORM.TIME_CHECK_RECORD', 'GOVERNANCE', 'WRITE', 'Record the time monitor''s drift readings, which raise and clear time alarms (platform.time_check.record)'),
  ('SAMPLE_RECORD.SUBMIT', 'GMP', 'WRITE', 'Sample state machine (Phase 1 scaffolding): submit a sample record'),
  ('SAMPLE_RECORD.CHECK', 'GMP', 'SIGN', 'Sample state machine (Phase 1 scaffolding): check or return a submitted sample record'),
  ('SAMPLE_RECORD.APPROVE', 'GMP', 'SIGN', 'Sample state machine (Phase 1 scaffolding): approve, return or supersede a sample record'),
  ('SAMPLE_RECORD.RETIRE', 'GMP', 'WRITE', 'Sample state machine (Phase 1 scaffolding): retire an approved sample record');

-- Role mapping (least privilege; features spec A.2 and outline 7.1). The permission-to-role table in
-- the module READMEs and in packages/kernel/test/integration/authorization.test.ts mirrors this list.
insert into iam.role_permission (role_code, permission_code)
select r, p from (values
  -- K5 master-data steward: rule tables and site layer under change control, numbering rules
  ('MASTER_DATA_STEWARD', 'MARKET.RULE_TABLE_PUBLISH'), ('MASTER_DATA_STEWARD', 'MARKET.SITE_VALUE_SET'),
  ('MASTER_DATA_STEWARD', 'BATCH_NUMBER.RULE_DEFINE'),
  -- K4 regulatory-conformity signer: corrections of a shipped value against its regulatory source
  ('REGULATORY_SIGNER', 'MARKET.RULE_TABLE_CORRECT'),
  -- K3 QA MBR approver: policy switches, the record-type register (defines and approves)
  ('QA_MBR_APPROVER', 'MARKET.POLICY_CHANGE'), ('QA_MBR_APPROVER', 'RECORD.TYPE_DEFINE'), ('QA_MBR_APPROVER', 'RECORD.TYPE_APPROVE'),
  -- K25 CSV / data-integrity lead: record-type definitions, DI-relevant incidents, time-alarm clearance
  ('CSV_DI_LEAD', 'RECORD.TYPE_DEFINE'), ('CSV_DI_LEAD', 'INCIDENT.RAISE'), ('CSV_DI_LEAD', 'INCIDENT.INVESTIGATE'),
  ('CSV_DI_LEAD', 'INCIDENT.CERT_IN_REPORT'), ('CSV_DI_LEAD', 'PLATFORM.ALARM_CLEAR'),
  -- K14 QA reviewer: retention, holds, disposal, true copies, incidents, DI closure, restore approval
  ('QA_REVIEWER', 'MARKET.POLICY_TIGHTEN_BATCH'), ('QA_REVIEWER', 'MARKET.RULE_EVALUATE'),
  ('QA_REVIEWER', 'RECORD.RETENTION_MANAGE'), ('QA_REVIEWER', 'RECORD.LEGAL_HOLD'), ('QA_REVIEWER', 'RECORD.DISPOSAL_APPROVE'),
  ('QA_REVIEWER', 'RECORD.TRUE_COPY_REGISTER'), ('QA_REVIEWER', 'INCIDENT.RAISE'), ('QA_REVIEWER', 'INCIDENT.INVESTIGATE'),
  ('QA_REVIEWER', 'INCIDENT.CLOSE'), ('QA_REVIEWER', 'INCIDENT.CERT_IN_REPORT'), ('QA_REVIEWER', 'DI_INVESTIGATION.APPROVE_CLOSURE'),
  ('QA_REVIEWER', 'CONTINUITY.RESTORE_APPROVE'),
  ('QA_REVIEWER', 'SAMPLE_RECORD.CHECK'), ('QA_REVIEWER', 'SAMPLE_RECORD.APPROVE'), ('QA_REVIEWER', 'SAMPLE_RECORD.RETIRE'),
  -- K1 MBR author and K2 checker: rule evaluation at MBR verification; the sample machine
  ('MBR_AUTHOR', 'MARKET.RULE_EVALUATE'), ('MBR_AUTHOR', 'SAMPLE_RECORD.SUBMIT'),
  ('MBR_CHECKER', 'SAMPLE_RECORD.CHECK'),
  -- K6 batch issuer: batch numbers (and the write-ahead ceilings their issue needs), evaluation at issue
  ('BATCH_ISSUER', 'MARKET.RULE_EVALUATE'), ('BATCH_ISSUER', 'INCIDENT.RAISE'), ('BATCH_ISSUER', 'CONTINUITY.COUNTER_RESERVE'),
  ('BATCH_ISSUER', 'BATCH_NUMBER.ALLOCATE'), ('BATCH_ISSUER', 'BATCH_NUMBER.REGISTER_EXTERNAL'), ('BATCH_ISSUER', 'BATCH_NUMBER.VOID'),
  ('BATCH_ISSUER', 'BATCH_NUMBER.RECOVER'),
  -- Shop-floor and laboratory roles: evaluation during execution (operator) and raising incidents where they work
  ('OPERATOR', 'MARKET.RULE_EVALUATE'), ('OPERATOR', 'INCIDENT.RAISE'),
  ('VERIFIER', 'INCIDENT.RAISE'), ('DISPENSER', 'INCIDENT.RAISE'), ('SHIFT_SUPERVISOR', 'INCIDENT.RAISE'),
  ('STAGE_RESPONSIBLE', 'INCIDENT.RAISE'), ('HEAD_OF_PRODUCTION', 'INCIDENT.RAISE'), ('QA_SHOP_FLOOR', 'INCIDENT.RAISE'),
  ('WAREHOUSE_LABELLING', 'INCIDENT.RAISE'), ('MAINTENANCE_TECHNICIAN', 'INCIDENT.RAISE'), ('HEAD_OF_QC', 'INCIDENT.RAISE'),
  ('QC_ANALYST', 'INCIDENT.RAISE'),
  -- K28 service accounts (time monitor, gateway, retention job, backup agent, ERP): WRITE effects only
  ('SERVICE_ACCOUNT', 'MARKET.RULE_EVALUATE'), ('SERVICE_ACCOUNT', 'RECORD.RETENTION_MANAGE'), ('SERVICE_ACCOUNT', 'RECORD.PURGE'),
  ('SERVICE_ACCOUNT', 'RECORD.TRUE_COPY_REGISTER'), ('SERVICE_ACCOUNT', 'INCIDENT.RAISE'), ('SERVICE_ACCOUNT', 'CONTINUITY.BACKUP_RECORD'),
  ('SERVICE_ACCOUNT', 'CONTINUITY.COUNTER_RESERVE'), ('SERVICE_ACCOUNT', 'BATCH_NUMBER.REGISTER_EXTERNAL'),
  ('SERVICE_ACCOUNT', 'PLATFORM.TIME_CHECK_RECORD'),
  -- K23 system administrator: IT functions only (restore operation, kiosk hardening, time sources, IT alarms)
  ('SYSTEM_ADMINISTRATOR', 'CONTINUITY.RESTORE_OPERATE'), ('SYSTEM_ADMINISTRATOR', 'CONTINUITY.HARDENING_ATTEST'),
  ('SYSTEM_ADMINISTRATOR', 'CONTINUITY.ALARM_ACKNOWLEDGE'), ('SYSTEM_ADMINISTRATOR', 'PLATFORM.TIME_SOURCE_MANAGE'),
  -- K24 system / process owner: platform settings, continuity alarms
  ('PROCESS_OWNER', 'CONTINUITY.ALARM_ACKNOWLEDGE'), ('PROCESS_OWNER', 'PLATFORM.SETTINGS_CHANGE')
) as seed (r, p);

select kernel.set_actor_context(null);

reset role;
