-- Recipe core, MBR life cycle (A3), part 5: the commands that create and edit MBR versions and
-- record their change-control references and verification evidence.
--
-- Every function is SECURITY DEFINER, refuses administrators first (iam.assert_not_administrator,
-- DI-18) and then checks the permission (iam.require_permission, DI-17) in the scope of the
-- product ({"product": <product code>}); installation-wide records (change records, risk
-- assessments) are checked in the empty scope. State changes other than the return to DRAFT are
-- made with platform.transition directly (the guards hold every condition).
--
--   define_family              MBR.AUTHOR          a new family (product, strength, batch sizes, form, edition)
--   create_version             MBR.AUTHOR          the first version of a family, in DRAFT
--   derive_version             MBR.AUTHOR          the next version, derived from an approved one (PR-06)
--   save_content               MBR.AUTHOR          a new content revision (DRAFT only; voids evidence)
--   set_draft_attributes       MBR.AUTHOR          change record, effective date, review due date (DRAFT only)
--   link_risk_assessment,
--   unlink_risk_assessment     MBR.AUTHOR          PR-07 links (DRAFT only)
--   record_evidence            MBR.AUTHOR          VALIDATOR, VERIFICATION, TEST_VECTORS, SANDBOX_RUN (DI-04)
--   return_to_draft            MBR.AUTHOR / MBR.CHECK / MBR.APPROVE by the state returned from
--   record_change_record, add_change_validation, add_change_regulatory, record_risk_assessment
--                              MBR.CHANGE_RECORD   QMS stand-ins (PR-04, PR-06, PR-07)

set local role ebmr_owner;

create function recipe.family_scope(p_family uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('product', f.product_code) from recipe.mbr_family f where f.id = p_family
$$;

create function recipe.version_scope(p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('product', f.product_code) from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id where v.id = p_version
$$;

-- p_def: {code, title, edition, recordKind, product: {code, name, strength, dosageForm}, batchSizes: [{id, quantity: {value, unit}}]}
create function recipe.define_family(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.AUTHOR', jsonb_build_object('product', p_def -> 'product' ->> 'code'));
  insert into recipe.mbr_family (code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                 created_by_person, created_by_account)
  values (p_def ->> 'code', p_def ->> 'title', p_def ->> 'edition', p_def ->> 'recordKind', p_def -> 'product' ->> 'code',
          p_def -> 'product' ->> 'name', p_def -> 'product' ->> 'strength', p_def -> 'product' ->> 'dosageForm',
          coalesce(p_def -> 'batchSizes', '[]'::jsonb), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- Shared by create_version and derive_version: the version row, draft cycle 1, content revision 1
-- and the state row at the machine's initial state (DRAFT).
create function recipe.insert_version(p_family uuid, p_derived_from uuid, p_content jsonb, p_content_hash text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, kernel, pg_temp as $$
declare
  v_id     uuid := gen_random_uuid();
  v_number integer;
  v_state  jsonb;
begin
  perform 1 from recipe.mbr_family where id = p_family for update;
  v_number := coalesce((select max(version_number) from recipe.mbr_version where family_id = p_family), 0) + 1;
  insert into recipe.mbr_version (id, family_id, version_number, author_person, author_account, derived_from)
  values (v_id, p_family, v_number, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', p_derived_from);
  insert into recipe.mbr_draft_entry (version_id, cycle, person_id, account_id, xact_id)
  values (v_id, 1, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 0);
  insert into recipe.mbr_content (version_id, revision, content, content_hash, reason, edited_by_person, edited_by_account)
  values (v_id, 1, p_content, p_content_hash, p_reason, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
  v_state := platform.create_aggregate_state('mbr_version', 'mbr_version', v_id);
  return jsonb_build_object('version_id', v_id, 'version_number', v_number, 'content_hash', p_content_hash,
                            'state', v_state ->> 'state', 'state_version', (v_state ->> 'version')::bigint);
end
$$;

-- The first version of a family. Once a version of the family was approved, later versions are
-- derived from an approved one (PR-06: an effective master changes only through a new version,
-- compared with its baseline).
create function recipe.create_version(p_family uuid, p_content jsonb, p_content_hash text, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_family where id = p_family) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR family %s (EBMR-RCP-010)', p_family);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.family_scope(p_family));
  if exists (select 1 from recipe.mbr_version v where v.family_id = p_family and recipe.version_was_approved(v.id)) then
    raise exception using errcode = 'P0001',
      message = 'This family already has an approved version: derive the next version from it so the change is compared with its baseline (PR-06; EBMR-RCP-025)';
  end if;
  return recipe.insert_version(p_family, null, p_content, p_content_hash, p_reason);
end
$$;

-- The next version, derived from a version that was approved (it may be retired since). Its first
-- content revision is the predecessor's content; the author edits it in DRAFT.
create function recipe.derive_version(p_from uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_from recipe.mbr_version;
  c      recipe.mbr_content;
begin
  perform iam.assert_not_administrator();
  select * into v_from from recipe.mbr_version where id = p_from;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_from);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_from));
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'A new version states why it is needed (PR-06; EBMR-RCP-027)';
  end if;
  if not recipe.version_was_approved(p_from) or recipe.version_state(p_from) not in ('APPROVED', 'RETIRED') then
    raise exception using errcode = 'P0001',
      message = format('Version %s is %s: a new version is derived only from an approved master (PR-06; EBMR-RCP-027)', v_from.version_number,
                       recipe.version_state(p_from));
  end if;
  c := recipe.current_content(p_from);
  return recipe.insert_version(v_from.family_id, p_from, c.content, c.content_hash, p_reason);
end
$$;

create function recipe.save_content(p_version uuid, p_content jsonb, p_content_hash text, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  c recipe.mbr_content;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  insert into recipe.mbr_content (version_id, revision, content, content_hash, reason, edited_by_person, edited_by_account)
  values (p_version, 0, p_content, p_content_hash, p_reason, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning * into c;
  return jsonb_build_object('version_id', p_version, 'revision', c.revision, 'content_hash', c.content_hash);
end
$$;

-- p_attrs: any of {"changeRecordId": uuid|null, "effectiveFrom": timestamptz|null, "reviewDue": "YYYY-MM-DD"|null}.
create function recipe.set_draft_attributes(p_version uuid, p_attrs jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v     recipe.mbr_version;
  v_ctx jsonb;
  k     text;
begin
  perform iam.assert_not_administrator();
  select * into v from recipe.mbr_version where id = p_version;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  for k in select jsonb_object_keys(coalesce(p_attrs, '{}'::jsonb)) loop
    if k not in ('changeRecordId', 'effectiveFrom', 'reviewDue') then
      raise exception using errcode = 'P0001', message = format('%s is not a draft attribute of an MBR version (EBMR-RCP-028)', k);
    end if;
  end loop;
  if p_attrs ? 'changeRecordId' then
    v.change_record_id := (p_attrs ->> 'changeRecordId')::uuid;
    if v.change_record_id is not null and not exists (select 1 from recipe.change_record where id = v.change_record_id) then
      raise exception using errcode = 'P0001', message = format('Unknown change record %s (PR-06; EBMR-RCP-060)', v.change_record_id);
    end if;
  end if;
  if p_attrs ? 'effectiveFrom' then
    v.effective_from := (p_attrs ->> 'effectiveFrom')::timestamptz;
  end if;
  if p_attrs ? 'reviewDue' then
    v.review_due := (p_attrs ->> 'reviewDue')::date;
  end if;
  v_ctx := recipe.push_reason('MBR_DRAFT_EDIT', 'draft attributes of the MBR version edited');
  update recipe.mbr_version set change_record_id = v.change_record_id, effective_from = v.effective_from, review_due = v.review_due
  where id = p_version;
  perform recipe.restore_actor(v_ctx);
end
$$;

create function recipe.link_risk_assessment(p_version uuid, p_risk_assessment uuid, p_subjects text[] default '{}') returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  if not exists (select 1 from recipe.risk_assessment where id = p_risk_assessment) then
    raise exception using errcode = 'P0001', message = format('Unknown risk assessment %s (PR-07; EBMR-RCP-061)', p_risk_assessment);
  end if;
  insert into recipe.mbr_risk_link (version_id, risk_assessment_id, action, subjects, person_id, account_id)
  values (p_version, p_risk_assessment, 'LINK', coalesce(p_subjects, '{}'), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
end
$$;

create function recipe.unlink_risk_assessment(p_version uuid, p_risk_assessment uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  if not exists (select 1 from recipe.current_risk_links(p_version) l where l.risk_assessment_id = p_risk_assessment) then
    raise exception using errcode = 'P0001', message = 'That risk assessment is not linked to this version (PR-07; EBMR-RCP-061)';
  end if;
  insert into recipe.mbr_risk_link (version_id, risk_assessment_id, action, subjects, person_id, account_id)
  values (p_version, p_risk_assessment, 'UNLINK', '{}', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
end
$$;

-- Records one piece of verification evidence for the version's current content (DI-04). The
-- database decides PASS or FAIL from the report (0120) and returns the stored row.
create function recipe.record_evidence(p_version uuid, p_kind text, p_report jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  e recipe.mbr_evidence;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  insert into recipe.mbr_evidence (version_id, content_hash, kind, result, tool_version, report, report_hash, person_id, account_id)
  values (p_version, repeat('0', 64), p_kind, 'FAIL', '', coalesce(p_report, '{}'::jsonb), repeat('0', 64),
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning * into e;
  return jsonb_build_object('evidence_id', e.id, 'kind', e.kind, 'mode', e.mode, 'result', e.result, 'content_hash', e.content_hash,
                            'report_hash', e.report_hash, 'problems', to_jsonb(e.problems));
end
$$;

-- Returns the version to DRAFT (outline 5.2.1 "returns to DRAFT with reason"): records the new draft
-- cycle, which supersedes every signature on the version through the e-signature module in this
-- transaction (DI-37, INV-09), then makes the RETURN transition. The command must carry a reason.
create function recipe.return_to_draft(p_version uuid, p_expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_state text := recipe.version_state(p_version);
  v_perm  text;
begin
  perform iam.assert_not_administrator();
  v_perm := case v_state when 'IN_VERIFICATION' then 'MBR.AUTHOR' when 'SUBMITTED' then 'MBR.CHECK' when 'CHECKED' then 'MBR.APPROVE' end;
  if v_perm is not null then
    perform iam.require_permission(v_perm, recipe.version_scope(p_version));
    insert into recipe.mbr_draft_entry (version_id, cycle, from_state, person_id, account_id, xact_id)
    values (p_version, 0, v_state, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 0);
  end if;
  -- In any other state the engine refuses the event (EBMR-PLAT-067) and nothing is recorded.
  return platform.transition('mbr_version', 'mbr_version', p_version, 'RETURN', p_expected_version, '{}'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- QMS stand-ins (Phase 2): change records and risk assessments
-- ---------------------------------------------------------------------------------------------

-- p_def: {number, title, changeClass, processImpacting, qmsReference?, validationRef?, validationDescription?}
create function recipe.record_change_record(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.CHANGE_RECORD', '{}'::jsonb);
  if jsonb_typeof(p_def -> 'processImpacting') is distinct from 'boolean' then
    raise exception using errcode = 'P0001', message = 'A change record states whether the change affects the process (PR-06; EBMR-RCP-060)';
  end if;
  insert into recipe.change_record (number, title, change_class, process_impacting, qms_reference, recorded_by_person, recorded_by_account)
  values (p_def ->> 'number', p_def ->> 'title', p_def ->> 'changeClass', (p_def ->> 'processImpacting')::boolean, p_def ->> 'qmsReference',
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  if coalesce(btrim(p_def ->> 'validationRef'), '') <> '' then
    insert into recipe.change_record_validation (change_record_id, validation_ref, description, recorded_by_person, recorded_by_account)
    values (v_id, p_def ->> 'validationRef', p_def ->> 'validationDescription', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
  end if;
  return v_id;
end
$$;

create function recipe.add_change_validation(p_change_record uuid, p_validation_ref text, p_description text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.CHANGE_RECORD', '{}'::jsonb);
  insert into recipe.change_record_validation (change_record_id, validation_ref, description, recorded_by_person, recorded_by_account)
  values (p_change_record, p_validation_ref, p_description, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- The regulatory assessment of the change for one market: its reporting category and, when the
-- market needs one, the variation, supplement or approval reference (PR-04).
create function recipe.add_change_regulatory(p_change_record uuid, p_market text, p_reporting_category text, p_reference text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.CHANGE_RECORD', '{}'::jsonb);
  insert into recipe.change_record_regulatory (change_record_id, market, reporting_category, regulatory_reference, recorded_by_person, recorded_by_account)
  values (p_change_record, p_market, p_reporting_category, nullif(btrim(coalesce(p_reference, '')), ''),
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- p_def: {code, version, title, riskClass, rationaleRef}
create function recipe.record_risk_assessment(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.CHANGE_RECORD', '{}'::jsonb);
  insert into recipe.risk_assessment (code, version, title, risk_class, rationale_ref, recorded_by_person, recorded_by_account)
  values (p_def ->> 'code', p_def ->> 'version', p_def ->> 'title', p_def ->> 'riskClass', p_def ->> 'rationaleRef',
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

grant execute on function recipe.family_scope(uuid), recipe.version_scope(uuid),
                          recipe.define_family(jsonb), recipe.create_version(uuid, jsonb, text, text), recipe.derive_version(uuid, text),
                          recipe.save_content(uuid, jsonb, text, text), recipe.set_draft_attributes(uuid, jsonb),
                          recipe.link_risk_assessment(uuid, uuid, text[]), recipe.unlink_risk_assessment(uuid, uuid),
                          recipe.record_evidence(uuid, text, jsonb), recipe.return_to_draft(uuid, bigint),
                          recipe.record_change_record(jsonb), recipe.add_change_validation(uuid, text, text),
                          recipe.add_change_regulatory(uuid, text, text, text), recipe.record_risk_assessment(jsonb) to ebmr_app;
-- insert_version stays private to the owner.

reset role;
