-- Kernel, identity: the installation bootstrap writes TEST- labels in a sandbox, and records the site's own time zone
-- (Phase 2 exit, lead TODO T8 = decision C0-1; DI-05, INV-18, DI-27).
--
-- Why. iam.bootstrap_installation (0180) creates, besides the first administrator and process owner the pipeline names,
-- three labels of its own: the system person "Installation qualification" and the console devices BOOTSTRAP-CONSOLE-1
-- and BOOTSTRAP-CONSOLE-2. In a sandbox the reserved-identifier guard (0920, sandbox.guard_identifier on iam.person,
-- iam.issued_identifier and iam.device) accepts only TEST- labels there, so a sandbox could not be bootstrapped once
-- every kernel migration was applied. The test kit worked around it (decision C0-1): it applied the kernel migrations
-- before 0920, bootstrapped, then applied the rest, so the three labels predated the guard and were real-looking names
-- in a sandbox. A sandbox signature, audit entry or device list should never show a label that could be taken for a GMP
-- one (DI-05: test, training and simulation data are always marked).
--
-- Now, in a sandbox (kernel.installation_kind() = 'SANDBOX') the bootstrap writes:
--   * the system person "TEST-Installation qualification" (PERSON_LABEL pattern);
--   * the console devices TEST-BOOTSTRAP-CONSOLE-1 and TEST-BOOTSTRAP-CONSOLE-2 (DEVICE_LABEL pattern);
--   * the pipeline's context name "TEST-Installation pipeline".
-- The administrator's and owner's names and login names are the pipeline's; the guard refuses any that are not TEST-
-- labels in a sandbox (EBMR-SBX-022), as it does for every other person. A GMP installation keeps the labels of 0180.
-- So a sandbox is provisioned in one stage, with every migration applied, and bootstrapped afterwards, with the guard
-- in force from the start.
--
-- The same defect elsewhere (T10, DI-27): 0180 put p_site_zone (default 'Asia/Kolkata') unchecked into the actor
-- context the bootstrap installs and registers as validated for its transaction (iam.set_internal_actor validates no
-- context), so that context could declare an abbreviation such as IST, or a zone other than the site's (policy
-- site.zone, which kernel 0940 holds to an IANA name), which no other context may (EBMR-IAM-118). The audit entries
-- record the policy's zone (kernel.site_zone()), so nothing wrong was stored; the context itself was wrong. Now the
-- zone is the site policy's: omitted (null), it is taken from iam.policy_text('site.zone'); given, it must be exactly
-- that value, else EBMR-IAM-118 (the rule every actor context meets, kernel.validate_actor_context in 0190) and
-- nothing is written.
--
-- Everything else is as in 0180: refused once any grant is approved (EBMR-IAM-190), the same rows, audit events and
-- result. The function keeps its signature, owner (ebmr_owner), SECURITY DEFINER, pinned search_path and privileges
-- (none: only the deployment pipeline, as ebmr_owner, calls it); the default of p_site_zone becomes null (the site's
-- zone). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, INV-18, DI-27: the installation's first administrator and process owner, with TEST- labels in a sandbox.
create or replace function iam.bootstrap_installation(p_admin_name text, p_admin_login text, p_admin_verifier text, p_admin_console text,
                                                      p_owner_name text, p_owner_login text, p_owner_verifier text, p_owner_console text,
                                                      p_site text, p_evidence_ref text, p_site_zone text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil      uuid := '00000000-0000-0000-0000-000000000000';
  v_prev     jsonb := kernel.current_actor();
  v_sandbox  boolean := kernel.installation_kind() = 'SANDBOX';
  -- The labels the bootstrap writes itself: reserved TEST- labels in a sandbox (0920), the 0180 ones in GMP.
  v_label    text := case when v_sandbox then 'TEST-' else '' end;
  v_zone     text := iam.policy_text('site.zone');
  v_ctx      jsonb;
  v_iq       uuid;
  v_admin    uuid;
  v_owner    uuid;
  v_aacc     uuid := gen_random_uuid();
  v_oacc     uuid := gen_random_uuid();
  v_ag       uuid;
  v_og       uuid;
  v_alogin   text := iam.normalize_login_name(p_admin_login);
  v_ologin   text := iam.normalize_login_name(p_owner_login);
begin
  if exists (select 1 from iam.role_grant where status in ('APPROVED', 'REVOKED')) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-190 the installation is already bootstrapped';
  end if;
  -- DI-27: the audit entries of the bootstrap carry the site's zone, never another text.
  if p_site_zone is not null and p_site_zone is distinct from v_zone then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-118 DI-27: the actor context declares the time zone %s, but the site''s time zone (policy site.zone) is %s',
                       p_site_zone, coalesce(v_zone, 'NULL'));
  end if;
  perform iam.check_verifier(p_admin_verifier);
  perform iam.check_verifier(p_owner_verifier);
  v_ctx := jsonb_build_object('person_id', v_nil, 'account_id', v_nil, 'role_code', 'INSTALLATION_BOOTSTRAP', 'session_id', v_nil,
                              'source', 'SYSTEM', 'site_zone', v_zone, 'correlation_id', gen_random_uuid(),
                              'legal_name', v_label || 'Installation pipeline', 'reason_code', 'INSTALLATION_BOOTSTRAP',
                              'reason_text', 'installation bootstrap; IQ evidence ' || p_evidence_ref);
  perform iam.set_internal_actor(v_ctx);

  insert into iam.person (kind, legal_name) values ('SYSTEM', v_label || 'Installation qualification') returning id into v_iq;
  -- From here on the installation-qualification identity is the recorded actor (it requests the
  -- first grants and records the identity checks); approvals name the two bootstrap persons.
  v_ctx := v_ctx || jsonb_build_object('person_id', v_iq, 'legal_name', v_label || 'Installation qualification');
  perform iam.set_internal_actor(v_ctx);
  insert into iam.person (kind, legal_name) values ('NATURAL', btrim(p_admin_name)) returning id into v_admin;
  insert into iam.person (kind, legal_name) values ('NATURAL', btrim(p_owner_name)) returning id into v_owner;
  insert into iam.identity_verification (person_id, purpose, method, document_type, evidence_ref, verified_by_person, verified_by_account, occurred_at)
  values (v_admin, 'INITIAL', 'INSTALLATION_QUALIFICATION', 'IQ protocol', p_evidence_ref, v_iq, v_nil, clock_timestamp()),
         (v_owner, 'INITIAL', 'INSTALLATION_QUALIFICATION', 'IQ protocol', p_evidence_ref, v_iq, v_nil, clock_timestamp());
  insert into iam.issued_identifier (identifier, account_id) values (v_alogin, v_aacc), (v_ologin, v_oacc);
  insert into iam.account (id, person_id, login_name, kind) values (v_aacc, v_admin, v_alogin, 'HUMAN'), (v_oacc, v_owner, v_ologin, 'HUMAN');
  update iam.account set status = 'ACTIVE', status_reason = 'installation bootstrap' where id in (v_aacc, v_oacc);
  insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account)
  values (v_aacc, v_admin, 'SYSTEM_ADMINISTRATOR', clock_timestamp(), 'installation bootstrap', 'REQUESTED', v_iq, v_nil)
  returning id into v_ag;
  insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account)
  values (v_oacc, v_owner, 'PROCESS_OWNER', clock_timestamp(), 'installation bootstrap', 'REQUESTED', v_iq, v_nil)
  returning id into v_og;
  update iam.role_grant set status = 'APPROVED', decided_by_person = v_owner, decided_by_account = v_oacc, decision_reason = 'installation bootstrap'
   where id = v_ag;
  update iam.role_grant set status = 'APPROVED', decided_by_person = v_admin, decided_by_account = v_aacc, decision_reason = 'installation bootstrap'
   where id = v_og;
  perform iam.store_credential(v_aacc, 'PASSWORD', 'BOOTSTRAP', p_admin_verifier, v_ctx);
  perform iam.store_credential(v_oacc, 'PASSWORD', 'BOOTSTRAP', p_owner_verifier, v_ctx);
  -- The two administration consoles (PERSONAL devices) the first logins will come from.
  insert into iam.device (code, device_class, site_code, key_fingerprint, description, registered_by_person)
  values (v_label || 'BOOTSTRAP-CONSOLE-1', 'PERSONAL', p_site, iam.normalize_fingerprint(p_admin_console), 'administration console (installation)', v_iq),
         (v_label || 'BOOTSTRAP-CONSOLE-2', 'PERSONAL', p_site, iam.normalize_fingerprint(p_owner_console), 'process-owner console (installation)', v_iq);

  -- Only the context installed last is validated (ADR-0016): restore the caller's validated context
  -- (or none) through the kernel, so the installation actors above stop counting.
  perform kernel.set_actor_context(v_prev);
  return jsonb_build_object('admin_person_id', v_admin, 'admin_account_id', v_aacc, 'owner_person_id', v_owner, 'owner_account_id', v_oacc,
                            'installation_person_id', v_iq);
end
$$;

reset role;
