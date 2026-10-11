-- LIMS-lite and deviation-lite after the slice 5 review (Phase 3 slice 5a; IN-20, PR-19, PR-50).
--
-- HIGH 1 (IN-20): a failing lot result counted as resolved on any OOS conclusion with an assignable cause, so a lot could
-- be released on, say, an equipment or process cause. Default taken: an approved failure is resolved only when BOTH
--   * its OOS record (kind OOS, linked to the lot, 0740 site.link_lot_test_oos) was concluded by QA with an assignable
--     cause of category LABORATORY_ERROR (a confirmed laboratory error); that conclusion is the invalidation of the
--     result; and
--   * an approved passing replacement result exists: a later, current, QC-approved PASS result of the same lot, test and
--     purpose.
-- Any other conclusion leaves the failure standing: the lot is not released (release, release for further processing
-- and retest all read this rule) and goes the rejection and deviation route. The same rule holds for the invalidation
-- of a batch result: site.deviation_ref_problem (use INVALIDATION) accepts only an OOS or investigation record concluded
-- with an assignable cause of category LABORATORY_ERROR.
-- MEDIUM 2 (PR-50): the QA person who recorded a finding of a deviation-lite record neither concludes nor closes it
-- (EBMR-SITE-312), checked by the command and not only by the signature service.
--
-- Replaced from their latest definitions: site.lot_test_failure_resolved and site.lot_lims_release_problem (0740),
-- site.deviation_ref_problem and site.assert_deviation_qa_signature (0730). CREATE OR REPLACE keeps owners and grants.

set local role ebmr_owner;

-- As 0740_lims_lite.sql; a confirmed laboratory error and an approved passing replacement (header).
create or replace function site.lot_test_failure_resolved(p_result uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.lot_test_oos o join site.deviation_conclusion c on c.deviation_id = o.deviation_id
                  where o.result_id = r.id and c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR'
                    and site.deviation_state(o.deviation_id) in ('CONCLUDED', 'CLOSED'))
     and exists (select 1 from site.lot_test_result n
                  where n.lot_id = r.lot_id and n.test_code = r.test_code and n.purpose = r.purpose and n.id <> r.id
                    and n.recorded_at > r.recorded_at and n.verdict = 'PASS' and site.lot_test_state(n.id) = 'APPROVED')
  from site.lot_test_result r where r.id = p_result
$$;

-- As 0740_lims_lite.sql; the message names the rule (header).
create or replace function site.lot_lims_release_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  r site.lot_test_result;
begin
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
  return null;
end
$$;

-- As 0730_deviation_lite.sql; an invalidation only on a confirmed laboratory error (header).
create or replace function site.deviation_ref_problem(p_ref text, p_use text, p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d      site.deviation;
  v_b    jsonb;
  v_st   text;
  c      site.deviation_conclusion;
begin
  if p_use is null or p_use not in ('LINK', 'DISPOSITION', 'INVALIDATION', 'REPROCESSING') then
    return format('%s is not a use of a deviation reference (LINK, DISPOSITION, INVALIDATION, REPROCESSING)', coalesce(p_use, 'NULL'));
  end if;
  if btrim(coalesce(p_ref, '')) = '' then
    return 'names no deviation-lite reference (D-S2-2)';
  end if;
  v_b := site.subject_identity('BATCH', p_batch);
  if v_b is null then
    return format('batch %s is not a GMP batch of this installation; a deviation reference is checked for GMP batches (D-S5-2)', coalesce(p_batch::text, 'NULL'));
  end if;
  select * into d from site.deviation where ref = btrim(p_ref);
  if not found then
    return format('%s is not a deviation-lite record of this installation (D-S2-2; PR-49)', btrim(p_ref));
  end if;
  if d.site_code <> v_b ->> 'siteCode' then
    return format('%s was raised at site %s, not at the batch''s site %s (PR-49)', d.ref, d.site_code, v_b ->> 'siteCode');
  end if;
  v_st := site.deviation_state(d.id);
  if v_st = 'CANCELLED' then
    return format('%s was cancelled (D-S5-1)', d.ref);
  end if;
  if not exists (select 1 from site.deviation_link l where l.deviation_id = d.id and l.subject_kind = 'BATCH' and l.subject_id = p_batch) then
    return format('%s is not linked to batch %s; link the batch to the record first (PR-49)', d.ref, v_b ->> 'batchNumber');
  end if;
  if p_use in ('INVALIDATION', 'REPROCESSING') then
    if p_use = 'INVALIDATION' and d.kind not in ('OOS', 'INVESTIGATION') then
      return format('%s is a %s record; a result is invalidated only on an OOS or investigation record (IN-20; DI-24)', d.ref, d.kind);
    end if;
    select * into c from site.deviation_conclusion x where x.deviation_id = d.id;
    if not found then
      return format('%s is %s: it has no QA-signed conclusion yet (IN-20)', d.ref, v_st);
    end if;
    if p_use = 'INVALIDATION' and not (c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR') then
      return format('%s was concluded %s; a result is invalidated only on a concluded, confirmed laboratory error (assignable cause in the category LABORATORY_ERROR) (IN-20; DI-24)',
                    d.ref, case when c.assignable_cause then format('with an assignable cause of category %s', c.root_cause_category) else 'without an assignable cause' end);
    end if;
  end if;
  return null;
end
$$;

-- As 0730_deviation_lite.sql; the investigator who recorded a finding does not conclude or close (header).
create or replace function site.assert_deviation_qa_signature(d site.deviation, p_signature uuid, p_meaning text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_prob text;
begin
  perform esig.assert_signature(p_signature, p_meaning, 'deviation', d.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-308 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-308 %s is recorded by the QA person who signed it', p_meaning);
  end if;
  -- The investigator who recorded a finding of the record neither concludes nor closes it (PR-50; slice 5 review).
  if exists (select 1 from site.deviation_finding f where f.deviation_id = d.id and f.recorded_by_person::text = v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-312 this person recorded a finding of %s; its conclusion and closure are by another QA person than the investigator (PR-50; outline 7.2 S7)', d.ref);
  end if;
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; its conclusion, closure and cancellation are by QA other than the initiator (PR-50; outline 7.2 S7)', d.ref);
  end if;
end
$$;

reset role;
