-- LIMS-lite: the OOS record a RELEASE revision cites is about the revised test (Phase 4 slice 2 quick review, core
-- medium; controls IN-20, DI-33).
--
-- site.record_lot_test_result (0841) accepted any OOS record of the lot that was not cancelled, so a revision of an ASSAY
-- failure could cite an OOS opened about WATER, and that record's laboratory-error conclusion then unblocked the revised
-- ASSAY failure (site.lot_lims_release_problem reads the revision's revision_oos). Default taken: the cited record must
-- not be tied to a result of another test code, neither as a result's OOS link (site.lot_test_oos) nor as the OOS of an
-- earlier revision (revision_oos); a record tied to the revised result or its test, or to no test yet, is accepted (a
-- revision then ties it to the test). EBMR-SITE-416.
--
-- Re-created from 0841 (its latest definition, CREATE OR REPLACE keeps the owner and the grant); nothing else changes.

set local role ebmr_owner;

-- As 0841_lims_from_specification.sql; the cited OOS record is about the revised test (header).
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
      -- The OOS record is about this test: never one tied to a result of another test (header).
      if exists (select 1 from site.lot_test_oos x join site.lot_test_result y on y.id = x.result_id
                  where x.deviation_id = d.id and y.test_code <> o.test_code)
         or exists (select 1 from site.lot_test_result y where y.revision_oos = d.id and y.test_code <> o.test_code) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-SITE-416 OOS record %s is about another test than %s; a revision of a RELEASE result cites the OOS record of its own result or test (IN-20, DI-33)',
                           d.ref, o.test_code);
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

reset role;
