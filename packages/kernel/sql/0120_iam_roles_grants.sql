-- Identity and access (B1), part 3: permission and role catalogue, scoped role grants with a
-- separate approver, static segregation of duties, point-in-time access lists and access
-- recertification (DI-14, DI-16, DI-17, DI-18, INV-11).
--
-- Static conflicts are refused when a grant is requested and again when it is approved, by
-- triggers that hold for every writer (the application role has no write privilege at all):
--   * INV-11 / DI-18: nobody holds an ADMINISTRATION permission and a GMP permission, in any
--     scope and through any of their accounts; a role never mixes the two;
--   * DI-14: generic (shared) and READONLY_DISPLAY accounts hold READ permissions only;
--     SERVICE and INTEGRATION accounts never hold SIGN or ACKNOWLEDGE permissions;
--   * break-glass accounts never hold GMP, SIGN or ACKNOWLEDGE permissions;
--   * the requester, the approver and the grantee are three different persons, and nobody
--     revokes their own grants (a person's admin account never acts on their own grants).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------------------------

create table iam.permission (
  code         text primary key check (code ~ '^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$'),
  domain       text not null check (domain in ('GMP', 'ADMINISTRATION', 'GOVERNANCE', 'READ_ONLY')),
  effect       text not null check (effect in ('READ', 'WRITE', 'SIGN', 'ACKNOWLEDGE', 'ADMINISTER')),
  description  text not null,
  check ((domain = 'ADMINISTRATION') = (effect = 'ADMINISTER')),
  check ((domain = 'READ_ONLY') = (effect = 'READ'))
);

create table iam.role (
  code           text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  catalogue_ref  text,
  name           text not null,
  role_group     text not null check (role_group in ('MASTER_RECORDS', 'EXECUTION', 'QUALITY_RELEASE', 'ADMINISTRATION_SECURITY')),
  description    text not null,
  account_kinds  text[] not null check (cardinality(account_kinds) >= 1
                                         and account_kinds <@ array['HUMAN', 'SERVICE', 'INTEGRATION', 'READONLY_DISPLAY']),
  is_kernel      boolean not null default false,
  created_at     timestamptz not null default clock_timestamp()
);

create table iam.role_permission (
  id               uuid primary key default gen_random_uuid(),
  role_code        text not null references iam.role (code),
  permission_code  text not null references iam.permission (code),
  added_at         timestamptz not null default clock_timestamp(),
  removed_at       timestamptz,
  check (removed_at is null or removed_at >= added_at)
);
create unique index role_permission_live on iam.role_permission (role_code, permission_code) where removed_at is null;
create index role_permission_role on iam.role_permission (role_code);

insert into iam.permission (code, domain, effect, description) values
  ('MBR.AUTHOR', 'GMP', 'WRITE', 'Compose and edit MBR versions and library elements'),
  ('MBR.SIGN_PREPARED', 'GMP', 'SIGN', 'Sign an MBR version as prepared'),
  ('MBR.CHECK', 'GMP', 'SIGN', 'Sign an MBR version as independently checked'),
  ('MBR.APPROVE', 'GMP', 'SIGN', 'Approve an MBR version for the quality unit'),
  ('MBR.REGULATORY_CONFIRM', 'GMP', 'SIGN', 'Confirm registration references and registered flags per market'),
  ('MASTERDATA.CHANGE', 'GMP', 'WRITE', 'Change master data under change control'),
  ('BATCH.ISSUE', 'GMP', 'SIGN', 'Issue a batch record from an effective MBR and sign it as issued'),
  ('STEP.EXECUTE', 'GMP', 'WRITE', 'Execute steps, scan and capture data'),
  ('STEP.SIGN_PERFORMED', 'GMP', 'SIGN', 'Sign a step as performed'),
  ('STEP.VERIFY', 'GMP', 'SIGN', 'Verify an entry or step performed by someone else'),
  ('STEP.WITNESS', 'GMP', 'SIGN', 'Witness an act as it happens'),
  ('STEP.SUPERVISE', 'GMP', 'SIGN', 'Supervise execution and hand-over'),
  ('DISPENSE.EXECUTE', 'GMP', 'WRITE', 'Dispense materials against a batch as a designated dispenser'),
  ('DEVIATION.APPROVE_INLINE', 'GMP', 'SIGN', 'Approve in-line exceptions of the classes the holder is designated competent for'),
  ('RECORD.PRODUCTION_APPROVE', 'GMP', 'SIGN', 'Approve a completed processing or packaging record before QA review'),
  ('QA.FLOOR_APPROVE', 'GMP', 'SIGN', 'Approve critical exceptions on the shop floor in real time'),
  ('ALARM.ACKNOWLEDGE', 'GMP', 'ACKNOWLEDGE', 'Acknowledge process alarms in batch context'),
  ('RECORD.QA_REVIEW', 'GMP', 'SIGN', 'QA review of a batch record and its exceptions'),
  ('RECORD.AUDIT_TRAIL_REVIEW', 'GMP', 'SIGN', 'Review and sign the batch audit trail'),
  ('QC.RESULT_RECORD', 'GMP', 'WRITE', 'Record QC results'),
  ('QC.RESULT_APPROVE', 'GMP', 'SIGN', 'Approve QC results used for release'),
  ('RELEASE.MANUFACTURER', 'GMP', 'SIGN', 'Manufacturer release, rejection or hold (India authorised person or named delegate)'),
  ('RELEASE.US_DISPOSITION', 'GMP', 'SIGN', 'Quality-unit disposition of a lot for the US market'),
  ('RELEASE.EU_QP_CERTIFY', 'GMP', 'SIGN', 'Qualified-person certification, only when the in-system QP feature is on'),
  ('MATERIAL.HANDLE', 'GMP', 'WRITE', 'Receipt, staging, kitting and returns of materials'),
  ('LABELLING.ISSUE', 'GMP', 'WRITE', 'Issue labelling and packaging materials'),
  ('LOGBOOK.ENTRY', 'GMP', 'WRITE', 'Cleaning, maintenance and calibration logbook entries'),
  ('LOGBOOK.SIGN', 'GMP', 'SIGN', 'Sign logbook entries'),
  ('INTERFACE.WRITE', 'GMP', 'WRITE', 'Machine-to-machine data exchange attributed to the source system'),
  ('TRAINING.MANAGE', 'GOVERNANCE', 'WRITE', 'Maintain curricula, qualification types and qualification requirements'),
  ('QUALIFICATION.RECORD', 'GOVERNANCE', 'WRITE', 'Record or withdraw person qualifications in the qualification register'),
  ('IAM.GRANT_APPROVE', 'GOVERNANCE', 'SIGN', 'Approve or reject an access request (never one''s own, never one''s own request)'),
  ('IAM.ACCESS_RECERTIFY', 'GOVERNANCE', 'SIGN', 'Periodic access recertification of other people''s accounts'),
  ('IAM.DELEGATION_APPROVE', 'GOVERNANCE', 'SIGN', 'Approve a delegation of signing authority'),
  ('IAM.BREAK_GLASS_APPROVE', 'GOVERNANCE', 'SIGN', 'Second authorisation of a break-glass window and its later review'),
  ('IAM.CERTIFICATION_RECORD', 'GOVERNANCE', 'WRITE', 'Record the legal entity''s US electronic-signature certification letter (11.100(c))'),
  ('IAM.ALERT_ACKNOWLEDGE', 'GOVERNANCE', 'ACKNOWLEDGE', 'Acknowledge security alerts'),
  ('SYSTEM.PERIODIC_REVIEW', 'GOVERNANCE', 'SIGN', 'Sign the periodic system review'),
  ('VALIDATION.MANAGE', 'GOVERNANCE', 'WRITE', 'Maintain validation evidence and data-integrity investigations'),
  ('IAM.PERSON_MANAGE', 'ADMINISTRATION', 'ADMINISTER', 'Create persons, record names, process leavers and rehires'),
  ('IAM.IDENTITY_VERIFY', 'ADMINISTRATION', 'ADMINISTER', 'Record identity verification of another person'),
  ('IAM.ACCOUNT_MANAGE', 'ADMINISTRATION', 'ADMINISTER', 'Create, activate, suspend and disable accounts'),
  ('IAM.CREDENTIAL_ISSUE', 'ADMINISTRATION', 'ADMINISTER', 'Issue initial and reset secrets, badges and badge tests (the secret itself is never shown to administrators)'),
  ('IAM.GRANT_REQUEST', 'ADMINISTRATION', 'ADMINISTER', 'Request a role grant for another person''s account'),
  ('IAM.GRANT_REVOKE', 'ADMINISTRATION', 'ADMINISTER', 'Revoke a role grant immediately'),
  ('IAM.ROLE_MANAGE', 'ADMINISTRATION', 'ADMINISTER', 'Maintain customer roles and permission bundles'),
  ('IAM.DEVICE_MANAGE', 'ADMINISTRATION', 'ADMINISTER', 'Register, block, relocate and decommission devices'),
  ('IAM.POLICY_MANAGE', 'ADMINISTRATION', 'ADMINISTER', 'Change identity policy values within their allowed ranges'),
  ('IAM.UNLOCK', 'ADMINISTRATION', 'ADMINISTER', 'Unlock a locked account'),
  ('SYSTEM.CONFIGURE', 'ADMINISTRATION', 'ADMINISTER', 'Deploy configuration under change control'),
  ('SYSTEM.VENDOR_SUPPORT', 'ADMINISTRATION', 'ADMINISTER', 'Named, time-boxed, customer-approved vendor support access'),
  ('RECORD.READ', 'READ_ONLY', 'READ', 'View and search records'),
  ('RECORD.EXPORT', 'READ_ONLY', 'READ', 'Export records (every export is logged)');

-- Kernel roles from the features spec, section A.2 (K1-K29), grouped as in outline 7.1, plus one
-- technical read-only role for line-status displays.
insert into iam.role (code, catalogue_ref, name, role_group, description, account_kinds, is_kernel) values
  ('MBR_AUTHOR', 'K1', 'MBR author', 'MASTER_RECORDS', 'Composes MBR versions and signs them as prepared', array['HUMAN'], true),
  ('MBR_CHECKER', 'K2', 'MBR independent checker', 'MASTER_RECORDS', 'Independently checks MBR versions', array['HUMAN'], true),
  ('QA_MBR_APPROVER', 'K3', 'QA MBR approver', 'MASTER_RECORDS', 'Quality-unit approval of MBR versions and delegations', array['HUMAN'], true),
  ('REGULATORY_SIGNER', 'K4', 'Regulatory-conformity signer', 'MASTER_RECORDS', 'Confirms registration references per market', array['HUMAN'], true),
  ('MASTER_DATA_STEWARD', 'K5', 'Master-data steward', 'MASTER_RECORDS', 'Maintains master data under change control', array['HUMAN'], true),
  ('BATCH_ISSUER', 'K6', 'Batch issuer', 'EXECUTION', 'Issues batch records from effective MBRs', array['HUMAN'], true),
  ('OPERATOR', 'K7', 'Production operator', 'EXECUTION', 'Executes steps and signs them as performed', array['HUMAN'], true),
  ('VERIFIER', 'K8', 'Verifier / checker', 'EXECUTION', 'Verifies or witnesses other people''s entries with own credentials', array['HUMAN'], true),
  ('DISPENSER', 'K9', 'Designated dispenser', 'EXECUTION', 'Dispenses against a batch', array['HUMAN'], true),
  ('SHIFT_SUPERVISOR', 'K10', 'Shift supervisor', 'EXECUTION', 'Approves in-line exceptions within designated competence; manages hand-over', array['HUMAN'], true),
  ('STAGE_RESPONSIBLE', 'K11', 'Person responsible for a stage', 'EXECUTION', 'Signs stage responsibility and production approval before QA review', array['HUMAN'], true),
  ('HEAD_OF_PRODUCTION', 'K12', 'Head of production', 'EXECUTION', 'Production approvals', array['HUMAN'], true),
  ('QA_SHOP_FLOOR', 'K13', 'QA operations (shop floor)', 'EXECUTION', 'Real-time approval of critical exceptions; witnessing; security alert acknowledgement', array['HUMAN'], true),
  ('WAREHOUSE_LABELLING', 'K20', 'Warehouse / labelling store', 'EXECUTION', 'Receipt, staging, kitting, returns and labelling issue', array['HUMAN'], true),
  ('MAINTENANCE_TECHNICIAN', 'K21', 'Maintenance, calibration and cleaning technician', 'EXECUTION', 'Logbook entries', array['HUMAN'], true),
  ('STATUS_DISPLAY', 'X1', 'Line-status display', 'EXECUTION', 'Read-only view for shared displays; cannot create, change, sign, verify or acknowledge', array['READONLY_DISPLAY', 'HUMAN'], true),
  ('QA_REVIEWER', 'K14', 'QA batch-record and audit-trail reviewer', 'QUALITY_RELEASE', 'Dispositions exceptions, reviews batch records and audit trails', array['HUMAN'], true),
  ('HEAD_OF_QC', 'K15', 'Head of QC', 'QUALITY_RELEASE', 'Approves QC results used for release', array['HUMAN'], true),
  ('QC_ANALYST', 'K16', 'QC analyst', 'QUALITY_RELEASE', 'Records QC results', array['HUMAN'], true),
  ('AUTHORISED_PERSON', 'K17', 'Authorised person (India) or named delegate', 'QUALITY_RELEASE', 'Manufacturer release, rejection or hold', array['HUMAN'], true),
  ('US_QCU_SIGNER', 'K18', 'US quality-unit disposition signer', 'QUALITY_RELEASE', 'Releases or rejects lots for the US market', array['HUMAN'], true),
  ('EU_QP', 'K19', 'EU qualified person', 'QUALITY_RELEASE', 'Certifies only when the in-system QP feature is on', array['HUMAN'], true),
  ('TRAINING_COORDINATOR', 'K22', 'Training coordinator', 'ADMINISTRATION_SECURITY', 'Maps curricula and records qualifications', array['HUMAN'], true),
  ('SYSTEM_ADMINISTRATOR', 'K23', 'System administrator', 'ADMINISTRATION_SECURITY', 'Provisions users per approved requests; configuration; security alerts; never GMP data', array['HUMAN'], true),
  ('PROCESS_OWNER', 'K24', 'System / process owner', 'ADMINISTRATION_SECURITY', 'Approves access requests, recertifies access, approves break-glass and delegations', array['HUMAN'], true),
  ('CSV_DI_LEAD', 'K25', 'CSV / data-integrity lead', 'ADMINISTRATION_SECURITY', 'Validation evidence and data-integrity investigations', array['HUMAN'], true),
  ('AUDITOR_READONLY', 'K26', 'Auditor / inspector (read-only)', 'ADMINISTRATION_SECURITY', 'Time-limited read-only access; exports logged', array['HUMAN'], true),
  ('CONTRACT_GIVER_REVIEWER', 'K27', 'Contract giver / loan-licensee reviewer', 'ADMINISTRATION_SECURITY', 'Read-only access to completed records', array['HUMAN'], true),
  ('SERVICE_ACCOUNT', 'K28', 'Service (interface) account', 'ADMINISTRATION_SECURITY', 'Machine-to-machine exchange; never signs, never logs in interactively', array['SERVICE', 'INTEGRATION'], true),
  ('VENDOR_SUPPORT', 'K29', 'Vendor support', 'ADMINISTRATION_SECURITY', 'Named, time-boxed, customer-approved support; no GMP action', array['HUMAN'], true);

insert into iam.role_permission (role_code, permission_code)
select r, p from (values
  ('MBR_AUTHOR', 'MBR.AUTHOR'), ('MBR_AUTHOR', 'MBR.SIGN_PREPARED'), ('MBR_AUTHOR', 'RECORD.READ'),
  ('MBR_CHECKER', 'MBR.CHECK'), ('MBR_CHECKER', 'RECORD.READ'),
  ('QA_MBR_APPROVER', 'MBR.APPROVE'), ('QA_MBR_APPROVER', 'IAM.DELEGATION_APPROVE'), ('QA_MBR_APPROVER', 'RECORD.READ'),
  ('REGULATORY_SIGNER', 'MBR.REGULATORY_CONFIRM'), ('REGULATORY_SIGNER', 'RECORD.READ'),
  ('MASTER_DATA_STEWARD', 'MASTERDATA.CHANGE'), ('MASTER_DATA_STEWARD', 'RECORD.READ'),
  ('BATCH_ISSUER', 'BATCH.ISSUE'), ('BATCH_ISSUER', 'RECORD.READ'),
  ('OPERATOR', 'STEP.EXECUTE'), ('OPERATOR', 'STEP.SIGN_PERFORMED'), ('OPERATOR', 'ALARM.ACKNOWLEDGE'), ('OPERATOR', 'RECORD.READ'),
  ('VERIFIER', 'STEP.VERIFY'), ('VERIFIER', 'STEP.WITNESS'), ('VERIFIER', 'RECORD.READ'),
  ('DISPENSER', 'DISPENSE.EXECUTE'), ('DISPENSER', 'STEP.SIGN_PERFORMED'), ('DISPENSER', 'RECORD.READ'),
  ('SHIFT_SUPERVISOR', 'STEP.SUPERVISE'), ('SHIFT_SUPERVISOR', 'DEVIATION.APPROVE_INLINE'), ('SHIFT_SUPERVISOR', 'ALARM.ACKNOWLEDGE'),
  ('SHIFT_SUPERVISOR', 'RECORD.READ'),
  ('STAGE_RESPONSIBLE', 'RECORD.PRODUCTION_APPROVE'), ('STAGE_RESPONSIBLE', 'RECORD.READ'),
  ('HEAD_OF_PRODUCTION', 'RECORD.PRODUCTION_APPROVE'), ('HEAD_OF_PRODUCTION', 'RECORD.READ'),
  ('QA_SHOP_FLOOR', 'QA.FLOOR_APPROVE'), ('QA_SHOP_FLOOR', 'STEP.WITNESS'), ('QA_SHOP_FLOOR', 'IAM.ALERT_ACKNOWLEDGE'),
  ('QA_SHOP_FLOOR', 'RECORD.READ'),
  ('WAREHOUSE_LABELLING', 'MATERIAL.HANDLE'), ('WAREHOUSE_LABELLING', 'LABELLING.ISSUE'), ('WAREHOUSE_LABELLING', 'RECORD.READ'),
  ('MAINTENANCE_TECHNICIAN', 'LOGBOOK.ENTRY'), ('MAINTENANCE_TECHNICIAN', 'LOGBOOK.SIGN'), ('MAINTENANCE_TECHNICIAN', 'RECORD.READ'),
  ('STATUS_DISPLAY', 'RECORD.READ'),
  ('QA_REVIEWER', 'RECORD.QA_REVIEW'), ('QA_REVIEWER', 'RECORD.AUDIT_TRAIL_REVIEW'), ('QA_REVIEWER', 'RECORD.READ'),
  ('HEAD_OF_QC', 'QC.RESULT_APPROVE'), ('HEAD_OF_QC', 'RECORD.READ'),
  ('QC_ANALYST', 'QC.RESULT_RECORD'), ('QC_ANALYST', 'RECORD.READ'),
  ('AUTHORISED_PERSON', 'RELEASE.MANUFACTURER'), ('AUTHORISED_PERSON', 'RECORD.READ'),
  ('US_QCU_SIGNER', 'RELEASE.US_DISPOSITION'), ('US_QCU_SIGNER', 'RECORD.READ'),
  ('EU_QP', 'RELEASE.EU_QP_CERTIFY'), ('EU_QP', 'RECORD.READ'),
  ('TRAINING_COORDINATOR', 'TRAINING.MANAGE'), ('TRAINING_COORDINATOR', 'QUALIFICATION.RECORD'), ('TRAINING_COORDINATOR', 'RECORD.READ'),
  ('SYSTEM_ADMINISTRATOR', 'IAM.PERSON_MANAGE'), ('SYSTEM_ADMINISTRATOR', 'IAM.IDENTITY_VERIFY'), ('SYSTEM_ADMINISTRATOR', 'IAM.ACCOUNT_MANAGE'),
  ('SYSTEM_ADMINISTRATOR', 'IAM.CREDENTIAL_ISSUE'), ('SYSTEM_ADMINISTRATOR', 'IAM.GRANT_REQUEST'), ('SYSTEM_ADMINISTRATOR', 'IAM.GRANT_APPROVE'),
  ('SYSTEM_ADMINISTRATOR', 'IAM.GRANT_REVOKE'), ('SYSTEM_ADMINISTRATOR', 'IAM.ROLE_MANAGE'), ('SYSTEM_ADMINISTRATOR', 'IAM.DEVICE_MANAGE'),
  ('SYSTEM_ADMINISTRATOR', 'IAM.POLICY_MANAGE'), ('SYSTEM_ADMINISTRATOR', 'IAM.UNLOCK'), ('SYSTEM_ADMINISTRATOR', 'IAM.ALERT_ACKNOWLEDGE'),
  ('SYSTEM_ADMINISTRATOR', 'SYSTEM.CONFIGURE'), ('SYSTEM_ADMINISTRATOR', 'RECORD.READ'),
  ('PROCESS_OWNER', 'IAM.GRANT_APPROVE'), ('PROCESS_OWNER', 'IAM.ACCESS_RECERTIFY'), ('PROCESS_OWNER', 'IAM.BREAK_GLASS_APPROVE'),
  ('PROCESS_OWNER', 'IAM.CERTIFICATION_RECORD'), ('PROCESS_OWNER', 'IAM.DELEGATION_APPROVE'), ('PROCESS_OWNER', 'SYSTEM.PERIODIC_REVIEW'),
  ('PROCESS_OWNER', 'RECORD.READ'),
  ('CSV_DI_LEAD', 'VALIDATION.MANAGE'), ('CSV_DI_LEAD', 'RECORD.READ'), ('CSV_DI_LEAD', 'RECORD.EXPORT'),
  ('AUDITOR_READONLY', 'RECORD.READ'), ('AUDITOR_READONLY', 'RECORD.EXPORT'),
  ('CONTRACT_GIVER_REVIEWER', 'RECORD.READ'),
  ('SERVICE_ACCOUNT', 'INTERFACE.WRITE'), ('SERVICE_ACCOUNT', 'RECORD.READ'),
  ('VENDOR_SUPPORT', 'SYSTEM.VENDOR_SUPPORT'), ('VENDOR_SUPPORT', 'RECORD.READ')
) as seed (r, p);

-- Catalogue helpers --------------------------------------------------------------------------

create function iam.role_permission_live_at(p_added timestamptz, p_removed timestamptz, p_at timestamptz) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_added <= p_at and (p_removed is null or p_at < p_removed)
$$;

-- Does the role hold, at p_at, at least one permission of the domain (or effect)?
create function iam.role_has_domain(p_role text, p_domain text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (select 1 from iam.role_permission rp join iam.permission p on p.code = rp.permission_code
                 where rp.role_code = p_role and p.domain = p_domain and iam.role_permission_live_at(rp.added_at, rp.removed_at, p_at))
$$;

create function iam.role_has_effect(p_role text, p_effects text[], p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (select 1 from iam.role_permission rp join iam.permission p on p.code = rp.permission_code
                 where rp.role_code = p_role and p.effect = any (p_effects) and iam.role_permission_live_at(rp.added_at, rp.removed_at, p_at))
$$;

create function iam.role_permissions_at(p_role text, p_at timestamptz) returns text[]
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce(array_agg(rp.permission_code order by rp.permission_code), '{}')
  from iam.role_permission rp
  where rp.role_code = p_role and iam.role_permission_live_at(rp.added_at, rp.removed_at, p_at)
$$;

create function iam.catalogue_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_table_name = 'permission' then
    if new.code <> old.code or new.domain <> old.domain or new.effect <> old.effect then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-007 a permission''s code, domain and effect never change';
    end if;
  elsif tg_table_name = 'role' then
    if new.code <> old.code or new.role_group <> old.role_group or new.account_kinds <> old.account_kinds
       or new.is_kernel <> old.is_kernel or new.created_at <> old.created_at then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-007 a role''s code, group, account kinds and origin never change';
    end if;
  end if;
  return new;
end
$$;
create trigger aa_permission_guard before update on iam.permission for each row execute function iam.catalogue_guard();
create trigger aa_role_guard before update on iam.role for each row execute function iam.catalogue_guard();

-- ---------------------------------------------------------------------------------------------
-- Role grants
-- ---------------------------------------------------------------------------------------------

create table iam.role_grant (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  person_id             uuid not null,
  role_code             text not null references iam.role (code),
  scope_site            text check (scope_site is null or btrim(scope_site) <> ''),
  scope_area            text check (scope_area is null or btrim(scope_area) <> ''),
  scope_product         text check (scope_product is null or btrim(scope_product) <> ''),
  valid_from            timestamptz not null,
  valid_to              timestamptz,
  reason                text not null check (btrim(reason) <> ''),
  status                text not null check (status in ('REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED')),
  requested_by_person   uuid not null,
  requested_by_account  uuid not null,
  requested_at          timestamptz not null default clock_timestamp(),
  decided_by_person     uuid,
  decided_by_account    uuid,
  decided_at            timestamptz,
  decision_reason       text,
  revoked_by_person     uuid,
  revoked_by_account    uuid,
  revoked_at            timestamptz,
  revocation_reason     text,
  foreign key (account_id, person_id) references iam.account (id, person_id),
  check (scope_area is null or scope_site is not null),
  check (valid_to is null or valid_to > valid_from),
  check (status = 'REQUESTED' or (decided_by_person is not null and decided_at is not null)),
  check (status <> 'REVOKED' or (revoked_by_person is not null and revoked_at is not null and btrim(coalesce(revocation_reason, '')) <> '')),
  -- Requester, approver and grantee are three different persons; nobody revokes their own grant.
  check (requested_by_person <> person_id),
  check (decided_by_person is null or (decided_by_person <> person_id and decided_by_person <> requested_by_person)),
  check (revoked_by_person is null or revoked_by_person <> person_id)
);
create index role_grant_account on iam.role_grant (account_id);
create index role_grant_person on iam.role_grant (person_id);
create index role_grant_role on iam.role_grant (role_code);

create function iam.grant_held_at(p_status text, p_decided_at timestamptz, p_valid_from timestamptz, p_valid_to timestamptz,
                                  p_revoked_at timestamptz, p_at timestamptz) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_status in ('APPROVED', 'REVOKED') and p_decided_at <= p_at and p_valid_from <= p_at
     and (p_valid_to is null or p_at < p_valid_to) and (p_revoked_at is null or p_at < p_revoked_at)
$$;

-- A grant is live when it is approved and not revoked or expired: held now or later.
create function iam.grant_is_live(p_status text, p_valid_to timestamptz, p_revoked_at timestamptz) returns boolean
language sql volatile set search_path = pg_catalog, pg_temp as $$
  select p_status = 'APPROVED' and p_revoked_at is null and (p_valid_to is null or p_valid_to > clock_timestamp())
$$;

-- Static checks for one account and role (DI-14, DI-18, INV-11). p_exclude is the grant being
-- checked, so it is not counted against itself. Locks the person row, so two concurrent
-- approvals for the same person are checked one after the other.
create function iam.check_static_segregation(p_account uuid, p_role text, p_exclude uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_acc  iam.account%rowtype;
  v_role iam.role%rowtype;
  v_now  timestamptz := clock_timestamp();
begin
  select * into v_acc from iam.account where id = p_account;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-022 unknown account';
  end if;
  perform 1 from iam.person where id = v_acc.person_id for update;
  select * into v_role from iam.role where code = p_role;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-030 unknown role %s', p_role);
  end if;
  if v_acc.status = 'DISABLED' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-026 a disabled account receives no grants';
  end if;
  -- DI-14: shared and display accounts can never create, change, sign, verify or acknowledge.
  if (v_acc.is_generic or v_acc.kind = 'READONLY_DISPLAY') and iam.role_has_effect(p_role, array['WRITE', 'SIGN', 'ACKNOWLEDGE', 'ADMINISTER'], v_now) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-034 DI-14: account %s is generic or a read-only display and cannot hold role %s, which writes, signs, verifies, acknowledges or administers',
                       v_acc.login_name, p_role);
  end if;
  -- DI-14: service and integration accounts never sign or acknowledge.
  if v_acc.kind in ('SERVICE', 'INTEGRATION') and iam.role_has_effect(p_role, array['SIGN', 'ACKNOWLEDGE'], v_now) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-035 DI-14: service or integration account %s cannot hold role %s, which signs or acknowledges', v_acc.login_name, p_role);
  end if;
  -- DI-18: break-glass accounts never act on GMP records.
  if v_acc.is_break_glass and (iam.role_has_domain(p_role, 'GMP', v_now) or iam.role_has_effect(p_role, array['SIGN', 'ACKNOWLEDGE'], v_now)) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-036 DI-18: break-glass account %s cannot hold role %s', v_acc.login_name, p_role);
  end if;
  if not v_acc.kind = any (v_role.account_kinds) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-036 role %s is not for %s accounts', p_role, v_acc.kind);
  end if;
  -- INV-11 / DI-18: never an administrator and a GMP role for the same person, anywhere.
  if iam.role_has_domain(p_role, 'ADMINISTRATION', v_now) and exists (
       select 1 from iam.role_grant g
       where g.person_id = v_acc.person_id and g.id <> coalesce(p_exclude, '00000000-0000-0000-0000-000000000000'::uuid)
         and iam.grant_is_live(g.status, g.valid_to, g.revoked_at) and iam.role_has_domain(g.role_code, 'GMP', v_now)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-033 INV-11/DI-18: the person already holds a GMP role and cannot also hold administrator role %s', p_role);
  end if;
  if iam.role_has_domain(p_role, 'GMP', v_now) and exists (
       select 1 from iam.role_grant g
       where g.person_id = v_acc.person_id and g.id <> coalesce(p_exclude, '00000000-0000-0000-0000-000000000000'::uuid)
         and iam.grant_is_live(g.status, g.valid_to, g.revoked_at) and iam.role_has_domain(g.role_code, 'ADMINISTRATION', v_now)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-033 INV-11/DI-18: the person already holds an administrator role and cannot also hold GMP role %s', p_role);
  end if;
end
$$;

create function iam.role_grant_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_person uuid;
begin
  select a.person_id into v_person from iam.account a where a.id = new.account_id;
  if v_person is distinct from new.person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-031 the grant''s person must be the account''s person';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'REQUESTED' or new.decided_by_person is not null or new.decided_at is not null
       or new.revoked_by_person is not null or new.revoked_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-037 a grant starts as a request; a second person approves it';
    end if;
    new.requested_at := clock_timestamp();
  else
    if new.id <> old.id or new.account_id <> old.account_id or new.person_id <> old.person_id or new.role_code <> old.role_code
       or new.scope_site is distinct from old.scope_site or new.scope_area is distinct from old.scope_area
       or new.scope_product is distinct from old.scope_product or new.valid_from <> old.valid_from
       or new.valid_to is distinct from old.valid_to or new.reason <> old.reason
       or new.requested_by_person <> old.requested_by_person or new.requested_by_account <> old.requested_by_account
       or new.requested_at <> old.requested_at then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-038 what was requested and approved never changes; revoke and request again';
    end if;
    if old.status = 'REQUESTED' and new.status in ('APPROVED', 'REJECTED') then
      new.decided_at := clock_timestamp();
      if new.revoked_by_person is not null or new.revoked_at is not null then
        raise exception using errcode = 'P0001', message = 'EBMR-IAM-037 a decision does not revoke';
      end if;
    elsif old.status = 'APPROVED' and new.status = 'REVOKED' then
      if new.decided_by_person <> old.decided_by_person or new.decided_by_account <> old.decided_by_account
         or new.decided_at <> old.decided_at or new.decision_reason is distinct from old.decision_reason then
        raise exception using errcode = 'P0001', message = 'EBMR-IAM-038 the approval of a grant never changes';
      end if;
      new.revoked_at := clock_timestamp();
    else
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-037 a grant cannot go from %s to %s', old.status, new.status);
    end if;
  end if;
  if new.status in ('REQUESTED', 'APPROVED') then
    perform iam.check_static_segregation(new.account_id, new.role_code, new.id);
  end if;
  return new;
end
$$;
create trigger aa_role_grant_guard before insert or update on iam.role_grant for each row execute function iam.role_grant_guard();

-- Adding a permission to a role re-checks every live holder, and a role never mixes
-- administration and GMP permissions (INV-11 cannot be bypassed through the catalogue).
create function iam.role_permission_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_perm iam.permission%rowtype;
  g      record;
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.role_code <> old.role_code or new.permission_code <> old.permission_code or new.added_at <> old.added_at
       or old.removed_at is not null or new.removed_at is null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-007 a role permission can only be removed, once';
    end if;
    new.removed_at := clock_timestamp();
    return new;
  end if;
  new.added_at := clock_timestamp();
  new.removed_at := null;
  select * into v_perm from iam.permission where code = new.permission_code;
  if v_perm.domain = 'GMP' and iam.role_has_domain(new.role_code, 'ADMINISTRATION', new.added_at)
     or v_perm.domain = 'ADMINISTRATION' and iam.role_has_domain(new.role_code, 'GMP', new.added_at) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-033 INV-11/DI-18: role %s cannot combine administration and GMP permissions (%s)', new.role_code, new.permission_code);
  end if;
  for g in
    select r.* from iam.role_grant r
    where r.role_code = new.role_code and (r.status = 'REQUESTED' or iam.grant_is_live(r.status, r.valid_to, r.revoked_at))
  loop
    declare
      v_acc iam.account%rowtype;
    begin
      select * into v_acc from iam.account where id = g.account_id;
      perform 1 from iam.person where id = g.person_id for update;
      if (v_acc.is_generic or v_acc.kind = 'READONLY_DISPLAY') and v_perm.effect <> 'READ' then
        raise exception using errcode = 'P0001',
          message = format('EBMR-IAM-034 DI-14: generic or display account %s holds role %s; %s cannot be added', v_acc.login_name, new.role_code, new.permission_code);
      end if;
      if v_acc.kind in ('SERVICE', 'INTEGRATION') and v_perm.effect in ('SIGN', 'ACKNOWLEDGE') then
        raise exception using errcode = 'P0001',
          message = format('EBMR-IAM-035 DI-14: service account %s holds role %s; %s cannot be added', v_acc.login_name, new.role_code, new.permission_code);
      end if;
      if v_acc.is_break_glass and (v_perm.domain = 'GMP' or v_perm.effect in ('SIGN', 'ACKNOWLEDGE')) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-IAM-036 DI-18: break-glass account %s holds role %s; %s cannot be added', v_acc.login_name, new.role_code, new.permission_code);
      end if;
      if v_perm.domain in ('GMP', 'ADMINISTRATION') and exists (
           select 1 from iam.role_grant o
           where o.person_id = g.person_id and o.id <> g.id and iam.grant_is_live(o.status, o.valid_to, o.revoked_at)
             and iam.role_has_domain(o.role_code, case v_perm.domain when 'GMP' then 'ADMINISTRATION' else 'GMP' end, new.added_at)) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-IAM-033 INV-11/DI-18: a holder of role %s would hold administrator and GMP permissions if %s were added',
                           new.role_code, new.permission_code);
      end if;
    end;
  end loop;
  return new;
end
$$;
create trigger aa_role_permission_guard before insert or update on iam.role_permission for each row execute function iam.role_permission_guard();

-- ---------------------------------------------------------------------------------------------
-- Grant functions (DI-16: requester, approver, date and reason recorded; requester is not approver)
-- ---------------------------------------------------------------------------------------------

create function iam.request_role_grant(p_account uuid, p_role text, p_scope jsonb, p_valid_from timestamptz, p_valid_to timestamptz,
                                       p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.GRANT_REQUEST', '{}'::jsonb);
  v_scope jsonb := iam.check_scope(p_scope);
  v_id    uuid;
begin
  insert into iam.role_grant (account_id, person_id, role_code, scope_site, scope_area, scope_product, valid_from, valid_to, reason,
                              status, requested_by_person, requested_by_account)
  select a.id, a.person_id, p_role, v_scope ->> 'site', v_scope ->> 'area', v_scope ->> 'product',
         coalesce(p_valid_from, clock_timestamp()), p_valid_to, p_reason, 'REQUESTED',
         (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid
  from iam.account a where a.id = p_account
  returning id into v_id;
  if v_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-022 unknown account';
  end if;
  return v_id;
end
$$;

create function iam.grant_scope(p_grant uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object('site', g.scope_site, 'area', g.scope_area, 'product', g.scope_product))
  from iam.role_grant g where g.id = p_grant
$$;

create function iam.decide_role_grant(p_grant uuid, p_approve boolean, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
begin
  if not exists (select 1 from iam.role_grant where id = p_grant) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-031 unknown grant';
  end if;
  v_actor := iam.require_permission('IAM.GRANT_APPROVE', iam.grant_scope(p_grant));
  update iam.role_grant
     set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
         decided_by_person = (v_actor ->> 'person_id')::uuid,
         decided_by_account = (v_actor ->> 'account_id')::uuid,
         decision_reason = p_reason
   where id = p_grant;
end
$$;

-- Internal revocation used by revoke_role_grant, recertification and leaver processing.
create function iam.revoke_grant_internal(p_grant uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
begin
  update iam.role_grant
     set status = 'REVOKED', revoked_by_person = (v_actor ->> 'person_id')::uuid,
         revoked_by_account = (v_actor ->> 'account_id')::uuid, revocation_reason = p_reason
   where id = p_grant and status = 'APPROVED' and revoked_at is null;
end
$$;

-- Revocation is effective immediately: the grant stops holding at the revocation instant, and
-- the next command or authority evaluation of that account sees it.
create function iam.revoke_role_grant(p_grant uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.GRANT_REVOKE', '{}'::jsonb);
  if not exists (select 1 from iam.role_grant where id = p_grant and status = 'APPROVED') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-037 only an approved grant can be revoked';
  end if;
  perform iam.revoke_grant_internal(p_grant, p_reason);
end
$$;

-- Customer roles and permission bundles (CONFIG), under the same static checks.
create function iam.create_role(p_code text, p_name text, p_group text, p_description text, p_account_kinds text[]) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ROLE_MANAGE', '{}'::jsonb);
  insert into iam.role (code, name, role_group, description, account_kinds, is_kernel)
  values (p_code, p_name, p_group, p_description, p_account_kinds, false);
end
$$;

create function iam.add_role_permission(p_role text, p_permission text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ROLE_MANAGE', '{}'::jsonb);
  insert into iam.role_permission (role_code, permission_code) values (p_role, p_permission);
end
$$;

create function iam.remove_role_permission(p_role text, p_permission text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ROLE_MANAGE', '{}'::jsonb);
  update iam.role_permission set removed_at = clock_timestamp()
   where role_code = p_role and permission_code = p_permission and removed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-030 the role does not hold that permission';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Point-in-time access list (DI-16): who held which role, permissions and scope at instant T,
-- with the access-request record (requester, approver, times, reason) behind each row.
-- ---------------------------------------------------------------------------------------------

create function iam.access_list(p_at timestamptz default null) returns table (
  person_id uuid, legal_name text, account_id uuid, login_name text, account_kind text, account_status text, effective boolean,
  role_code text, role_name text, permissions text[], scope_site text, scope_area text, scope_product text, grant_id uuid,
  valid_from timestamptz, valid_to timestamptz, requested_by_person uuid, requested_at timestamptz, approved_by_person uuid,
  approved_at timestamptz, reason text, revoked_at timestamptz)
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  with t as (select coalesce(p_at, clock_timestamp()) as at)
  select g.person_id, iam.person_name_at(g.person_id, t.at), g.account_id, a.login_name, a.kind, iam.account_status_at(a.id, t.at),
         iam.account_status_at(a.id, t.at) = 'ACTIVE' and iam.person_status_at(g.person_id, t.at) = 'ACTIVE',
         g.role_code, r.name, iam.role_permissions_at(g.role_code, t.at), g.scope_site, g.scope_area, g.scope_product, g.id,
         g.valid_from, g.valid_to, g.requested_by_person, g.requested_at, g.decided_by_person, g.decided_at, g.reason, g.revoked_at
  from t
  join iam.role_grant g on iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, t.at)
  join iam.account a on a.id = g.account_id
  join iam.role r on r.code = g.role_code
  order by 2, a.login_name, g.role_code
$$;

-- ---------------------------------------------------------------------------------------------
-- Access recertification (DI-16: reviewer, outcome, each user's last activity; interval policy)
-- ---------------------------------------------------------------------------------------------

create table iam.access_recertification (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references iam.account (id),
  reviewer_person   uuid not null,
  reviewer_account  uuid not null,
  outcome           text not null check (outcome in ('CONFIRMED', 'REVOKED')),
  comment           text not null check (btrim(comment) <> ''),
  grants_reviewed   uuid[] not null,
  last_activity_at  timestamptz,
  recorded_at       timestamptz not null default clock_timestamp(),
  next_due_at       timestamptz not null
);
create index access_recertification_account on iam.access_recertification (account_id, recorded_at desc);

create function iam.recertification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  new.recorded_at := clock_timestamp();
  new.next_due_at := new.recorded_at + make_interval(months => iam.policy_int('recertification.interval_months')::int);
  if new.reviewer_person = (select person_id from iam.account where id = new.account_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-003 nobody recertifies their own access';
  end if;
  return new;
end
$$;
create trigger aa_recertification_guard before insert on iam.access_recertification for each row execute function iam.recertification_guard();

create function iam.recertify_account(p_account uuid, p_outcome text, p_comment text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := iam.require_permission('IAM.ACCESS_RECERTIFY', '{}'::jsonb);
  v_grants uuid[];
  v_last   timestamptz;
  v_id     uuid;
  g        uuid;
begin
  if not exists (select 1 from iam.account where id = p_account) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-022 unknown account';
  end if;
  select coalesce(array_agg(r.id order by r.id), '{}') into v_grants
  from iam.role_grant r where r.account_id = p_account and iam.grant_is_live(r.status, r.valid_to, r.revoked_at);
  select max(sa.last_activity_at) into v_last
  from iam.session s join iam.session_activity sa on sa.session_id = s.id where s.account_id = p_account;
  insert into iam.access_recertification (account_id, reviewer_person, reviewer_account, outcome, comment, grants_reviewed,
                                          last_activity_at, next_due_at)
  values (p_account, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_outcome, p_comment, v_grants, v_last,
          clock_timestamp())
  returning id into v_id;
  if p_outcome = 'REVOKED' then
    foreach g in array v_grants loop
      perform iam.revoke_grant_internal(g, 'access recertification: ' || p_comment);
    end loop;
  end if;
  return v_id;
end
$$;

-- Accounts whose recertification is due at p_at (never recertified: due one interval after creation).
create function iam.recertification_due(p_at timestamptz default null) returns table (
  account_id uuid, login_name text, person_id uuid, last_recertified_at timestamptz, due_at timestamptz, overdue boolean)
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  with t as (select coalesce(p_at, clock_timestamp()) as at),
  last as (
    select distinct on (r.account_id) r.account_id, r.recorded_at, r.next_due_at
    from iam.access_recertification r order by r.account_id, r.recorded_at desc)
  select a.id, a.login_name, a.person_id, l.recorded_at,
         coalesce(l.next_due_at, a.created_at + make_interval(months => iam.policy_int('recertification.interval_months')::int)),
         coalesce(l.next_due_at, a.created_at + make_interval(months => iam.policy_int('recertification.interval_months')::int)) <= t.at
  from t cross join iam.account a
  left join last l on l.account_id = a.id
  where a.status in ('ACTIVE', 'SUSPENDED')
  order by 5
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit registration, protection, privileges
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('iam.permission', 'iam_permission', 'code', false);
select kernel.register_audited_table('iam.role', 'iam_role', 'code', false);
select kernel.register_audited_table('iam.role_permission', 'iam_role', 'role_code', false);
select kernel.register_audited_table('iam.role_grant', 'account', 'account_id', false);
select kernel.register_audited_table('iam.access_recertification', 'account', 'account_id', true);
select iam.protect_rows('iam.permission');
select iam.protect_rows('iam.role');
select iam.protect_rows('iam.role_permission');
select iam.protect_rows('iam.role_grant');

grant select on iam.permission, iam.role, iam.role_permission, iam.role_grant, iam.access_recertification to ebmr_app;
grant execute on function iam.role_permission_live_at(timestamptz, timestamptz, timestamptz), iam.role_has_domain(text, text, timestamptz),
                          iam.role_has_effect(text, text[], timestamptz), iam.role_permissions_at(text, timestamptz),
                          iam.grant_held_at(text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz),
                          iam.grant_is_live(text, timestamptz, timestamptz), iam.grant_scope(uuid),
                          iam.request_role_grant(uuid, text, jsonb, timestamptz, timestamptz, text),
                          iam.decide_role_grant(uuid, boolean, text), iam.revoke_role_grant(uuid, text),
                          iam.create_role(text, text, text, text, text[]), iam.add_role_permission(text, text),
                          iam.remove_role_permission(text, text), iam.access_list(timestamptz),
                          iam.recertify_account(uuid, text, text), iam.recertification_due(timestamptz) to ebmr_app;

reset role;
