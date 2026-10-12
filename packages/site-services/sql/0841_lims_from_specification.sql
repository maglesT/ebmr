-- LIMS-lite judged against the approved specification (Phase 4 slice 2b; Phase 3 review backlog, slice 5 items; controls
-- IN-33, IN-20, PR-19, PR-45, DI-33).
--
--   * site.lot_test_result gains spec_test_id (the specification test the result is judged against) and revision_oos
--     (the OOS record a revision of a RELEASE result cites). A row trigger holds a result to its specification test:
--     the same test code, unit and limits (EBMR-SITE-414), so the stored limits are always the specification's.
--   * site.record_lot_test_result (CREATE OR REPLACE from 0740, its only definition): the limits are never typed
--     (EBMR-SITE-410); the test must be a test of the specification in effect for the lot's material at its site
--     (EBMR-SITE-411), whose unit and method the result takes (a unit or method sent must equal them, EBMR-SITE-412);
--     a revision of a RELEASE result cites an OOS record of the lot (kind OOS, not cancelled, linked to the lot;
--     EBMR-SITE-413). Everything else as 0740.
--   * site.lot_lims_release_problem (CREATE OR REPLACE from 0753): a lot is released (or released for further
--     processing) only when a specification is in effect for its material, every required test of it has a current
--     RELEASE result judged against it, and then 0753's checks; and a revised failing RELEASE result stands until the
--     OOS record its revision cites is concluded as a confirmed laboratory error (IN-20: a failure is not overwritten by
--     a later value). A lot with no results therefore no longer passes.
--   * site.record_qc_extra_testing_decision (CREATE OR REPLACE from 0733): a later decision keeps every test an earlier
--     decision of the batch named (EBMR-SITE-415): the latest no longer quietly drops tests.
--   * site.extra_testing_problem(batch, lot): why the extra tests QC decided for the batch were not run on the lot: each
--     named test must be a test of the lot's specification in effect with a current, QC-approved RELEASE result that
--     passes or whose failure is resolved (IN-20). NULL when there is no decision or NONE_REQUIRED (the absence of a
--     decision is recipe.reprocessing_release_problem's). For the release model (slice 3).
--
-- site.lot_test_failure_resolved is not changed here (slice 2a re-creates it for the renamed deviation states).
-- Messages: EBMR-SITE-410 to EBMR-SITE-416.

set local role ebmr_owner;

alter table site.lot_test_result add column spec_test_id uuid references site.specification_test (id);
alter table site.lot_test_result add column revision_oos uuid references site.deviation (id);
alter table site.lot_test_result add constraint lot_test_result_revision_oos check (revision_oos is null or revises is not null);

-- A result names the specification test it is judged against with its code, unit and limits (header).
create function site.lot_test_result_spec_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  t site.specification_test;
begin
  if new.spec_test_id is null then
    return new;
  end if;
  select * into t from site.specification_test where id = new.spec_test_id;
  if t.test_code is distinct from new.test_code or t.unit is distinct from new.unit
     or t.lower_limit is distinct from new.lower_limit or t.upper_limit is distinct from new.upper_limit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-414 a %s result carries the code, unit and limits of the specification test it is judged against (IN-33)', new.test_code);
  end if;
  return new;
end
$$;

create trigger a2_spec_check before insert on site.lot_test_result for each row execute function site.lot_test_result_spec_check();

-- As 0740_lims_lite.sql; limits from the specification, a RELEASE revision cites its OOS record (header).
create or replace function site.record_lot_test_result(p_lot uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  o      site.lot_test_result;
  t      site.specification_test;
  d      site.deviation;
  v_id   uuid;
  v_ver  text;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('QC.RESULT_RECORD', jsonb_build_object('site', l.site_code));
  if site.lot_state(l.id) in ('CONSUMED', 'DESTROYED') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-200 lot %s is %s; no result is recorded for it', l.lot_code, site.lot_state(l.id));
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the result details are required';
  end if;
  if p ? 'lowerLimit' or p ? 'upperLimit' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-410 the limits of a result are the approved specification''s; they are never typed (IN-33)';
  end if;
  if p ? 'value' and (jsonb_typeof(p -> 'value') is distinct from 'string' or (p ->> 'value') !~ '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the value of a result is an exact decimal written as text, e.g. "99.2" (DI-33)';
  end if;
  if not (p ? 'value') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 a result states its value; the verdict is computed from it and the specification''s limits (D-S5-3)';
  end if;
  if p ? 'verdict' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the verdict is computed by the database from the value and the limits; it is never typed (D-S5-3)';
  end if;
  if coalesce(p ->> 'purpose', '') not in ('RELEASE', 'RETEST') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the purpose of a result is RELEASE or RETEST';
  end if;
  t := site.lot_spec_test(l.id, p ->> 'testCode');
  if t.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-411 %s is no test of an approved specification in effect for material %s at site %s; QC adds it to the specification first (IN-33, PR-45)',
                       coalesce(p ->> 'testCode', 'NULL'), l.material_code, l.site_code);
  end if;
  if (p ? 'unit' and p ->> 'unit' is distinct from t.unit) or (p ? 'methodReference' and p ->> 'methodReference' is distinct from t.method_reference) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-412 the specification measures %s in %s by method %s; a result takes them from it (IN-33)', t.test_code, t.unit, t.method_reference);
  end if;
  if p ? 'revises' then
    select * into o from site.lot_test_result r where r.id = (p ->> 'revises')::uuid for update;
    if o.id is null or o.lot_id <> l.id or o.test_code is distinct from p ->> 'testCode' or o.purpose is distinct from p ->> 'purpose'
       or not site.lot_test_is_current(o.id) then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-202 a revision names the current result of the same lot, test and purpose (DI-33)';
    end if;
    if btrim(coalesce(p ->> 'revisionReason', '')) = '' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-202 a revision states the person''s own reason; the revised result stays visible (DI-22, DI-33)';
    end if;
    if o.purpose = 'RELEASE' then
      if coalesce(p ->> 'oosDeviationId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        d := null;
      else
        select * into d from site.deviation x where x.id = (p ->> 'oosDeviationId')::uuid;
      end if;
      if d.id is null or d.kind <> 'OOS' or d.site_code <> l.site_code or site.deviation_state(d.id) = 'CANCELLED'
         or not exists (select 1 from site.deviation_link x where x.deviation_id = d.id and x.subject_kind = 'LOT' and x.subject_id = l.id) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-SITE-413 a revision of a RELEASE result cites the OOS record of lot %s: a deviation-lite record of kind OOS at site %s, not cancelled, linked to the lot (IN-20, DI-33)',
                           l.lot_code, l.site_code);
      end if;
    elsif p ? 'oosDeviationId' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-413 only a revision of a RELEASE result cites an OOS record';
    end if;
  elsif p ? 'revisionReason' or p ? 'oosDeviationId' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-202 only a revision states a revision reason or an OOS record';
  end if;
  insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, revises, revision_reason,
                                    revision_oos, spec_test_id, recorded_by_person, recorded_by_account, correlation_id)
  values (l.id, t.test_code, t.method_reference, p ->> 'purpose', (p ->> 'value')::numeric, t.unit, t.lower_limit, t.upper_limit,
          o.id, case when o.id is not null then btrim(p ->> 'revisionReason') end, d.id, t.id,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id, verdict into v_id, v_ver;
  return jsonb_build_object('resultId', v_id, 'verdict', v_ver);
end
$$;

-- Whether OOS record p_dev was concluded by QA as a confirmed laboratory error (assignable cause, LABORATORY_ERROR).
create function site.oos_confirmed_lab_error(p_dev uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.deviation_conclusion c
                  where c.deviation_id = p_dev and c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR'
                    and site.deviation_state(p_dev) not in ('OPEN', 'UNDER_INVESTIGATION', 'CANCELLED'))
$$;

-- As 0753_review_lab_error_and_investigator.sql; the specification and its required tests first, revised failures after (header).
create or replace function site.lot_lims_release_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l      site.material_lot;
  v_spec uuid;
  t      site.specification_test;
  r      site.lot_test_result;
begin
  select * into l from site.material_lot where id = p_lot;
  if not found then
    return 'the lot does not exist';
  end if;
  v_spec := site.specification_in_effect(l.site_code, l.material_code);
  if v_spec is null then
    return format('no approved specification is in effect for material %s at site %s; a lot is released only against one (IN-33, PR-45)', l.material_code, l.site_code);
  end if;
  for t in select x.* from site.specification_test x where x.specification_id = v_spec and x.required order by x.test_code collate "C" loop
    if not exists (select 1 from site.lot_test_result y
                    where y.lot_id = p_lot and y.purpose = 'RELEASE' and y.spec_test_id = t.id and site.lot_test_is_current(y.id)) then
      return format('the required test %s of the specification in effect (version %s) has no current RELEASE result for the lot (PR-45, IN-33)',
                    t.test_code, (select s.version from site.specification s where s.id = v_spec));
    end if;
  end loop;
  for r in select x.* from site.lot_test_result x
            where x.lot_id = p_lot and x.purpose = 'RELEASE' and site.lot_test_is_current(x.id) order by x.recorded_at, x.id loop
    if not exists (select 1 from site.lot_test_approval a where a.result_id = r.id) then
      return format('the %s result %s %s of the lot is not approved by QC (PR-19, DI-33)', r.test_code, r.result_value, r.unit);
    end if;
    if r.verdict = 'FAIL' and not site.lot_test_failure_resolved(r.id) then
      return format('the approved %s result %s %s of the lot failed its limits; it stands unless its OOS record concluded a confirmed laboratory error (assignable cause, category LABORATORY_ERROR) and an approved passing replacement result of the test exists; otherwise the lot is rejected and goes the deviation route (PR-19, IN-20)',
                    r.test_code, r.result_value, r.unit);
    end if;
  end loop;
  for r in select x.* from site.lot_test_result x
            where x.lot_id = p_lot and x.purpose = 'RELEASE' and x.verdict = 'FAIL' and not site.lot_test_is_current(x.id) order by x.recorded_at, x.id loop
    if not exists (select 1 from site.lot_test_result n where n.revises = r.id and n.revision_oos is not null and site.oos_confirmed_lab_error(n.revision_oos)) then
      return format('the %s result %s %s of the lot failed its limits and was revised; the failure stands until the OOS record its revision cites is concluded as a confirmed laboratory error (IN-20, DI-33)',
                    r.test_code, r.result_value, r.unit);
    end if;
  end loop;
  return null;
end
$$;

-- As 0733_qc_extra_testing_decision.sql; a later decision keeps the tests an earlier one named (header).
create or replace function site.record_qc_extra_testing_decision(p_batch uuid, p_decision text, p_tests text[], p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_b     jsonb;
  v_tests text[] := site.qc_test_codes(p_tests);
  v_prev  text[];
  v_prob  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_b := site.subject_identity('BATCH', p_batch);
  if v_b is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-345 batch %s is not a GMP batch of this installation (PR-47)', coalesce(p_batch::text, 'NULL'));
  end if;
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', v_b ->> 'siteCode', 'product', v_b ->> 'productCode'));
  if p_decision is null or p_decision not in ('NONE_REQUIRED', 'EXTRA_TESTS') or v_tests is null
     or (p_decision = 'EXTRA_TESTS') <> (cardinality(v_tests) >= 1) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-346 the decision is NONE_REQUIRED (no tests) or EXTRA_TESTS with at least one test code (PR-47)';
  end if;
  perform pg_advisory_xact_lock(hashtext('site.qc_extra_testing'), hashtext(p_batch::text));
  select coalesce(array_agg(distinct t), '{}') into v_prev from site.qc_extra_testing_decision d, unnest(d.tests) t where d.batch_id = p_batch;
  if not (v_prev <@ v_tests) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-415 an earlier decision on the batch named the tests %s; a later decision keeps them all (PR-47)', array_to_string(v_prev, ', '));
  end if;
  perform esig.assert_signature(p_signature, 'QC_EXTRA_TESTING_DECIDED', 'qc_extra_testing', site.qc_extra_testing_aggregate_id(p_batch, p_decision, v_tests));
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-347 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-347 the decision is recorded by the QC person who signed it (PR-47)';
  end if;
  insert into site.qc_extra_testing_decision (batch_id, batch_number, edition, site_code, decision, tests, signature_id, decided_by_person, decided_by_account)
  values (p_batch, v_b ->> 'batchNumber', v_b ->> 'edition', v_b ->> 'siteCode', p_decision, v_tests, p_signature,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- PR-47 (header): why the extra tests QC decided for batch p_batch were not run on lot p_lot, or NULL.
create function site.extra_testing_problem(p_batch uuid, p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d      site.qc_extra_testing_decision;
  v_test text;
  t      site.specification_test;
  r      site.lot_test_result;
begin
  select * into d from site.qc_extra_testing_decision x where x.batch_id = p_batch order by x.decided_at desc, x.id desc limit 1;
  if d.id is null or d.decision = 'NONE_REQUIRED' then
    return null;
  end if;
  if not exists (select 1 from site.material_lot l where l.id = p_lot) then
    return 'the lot does not exist';
  end if;
  foreach v_test in array d.tests loop
    t := site.lot_spec_test(p_lot, v_test);
    if t.id is null then
      return format('QC decided the extra test %s for batch %s, and it is no test of the specification in effect for the lot: no limits to judge it by (PR-47, IN-33)', v_test, d.batch_number);
    end if;
    select x.* into r from site.lot_test_result x
     where x.lot_id = p_lot and x.purpose = 'RELEASE' and x.spec_test_id = t.id and site.lot_test_is_current(x.id)
     order by x.recorded_at desc, x.id desc limit 1;
    if r.id is null then
      return format('QC decided the extra test %s for batch %s, and the lot has no result of it (PR-47)', v_test, d.batch_number);
    end if;
    if not exists (select 1 from site.lot_test_approval a where a.result_id = r.id) then
      return format('the extra test %s of the lot is not approved by QC (PR-47, PR-19)', v_test);
    end if;
    if r.verdict = 'FAIL' and not site.lot_test_failure_resolved(r.id) then
      return format('the extra test %s of the lot failed its limits and the failure is not resolved (PR-47, IN-20)', v_test);
    end if;
  end loop;
  return null;
end
$$;

revoke all on function site.lot_test_result_spec_check(), site.oos_confirmed_lab_error(uuid), site.extra_testing_problem(uuid, uuid), site.lot_spec_test(uuid, text) from public;
grant execute on function site.extra_testing_problem(uuid, uuid) to ebmr_app;

reset role;
