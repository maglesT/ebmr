-- SITE-995 residual (lead, 11 November 2026): the retest refusals read right for a lot without an expiry date (an in-house
-- intermediate kept without dates, or with a retest date only; site-services 1736).
--
-- Handbook: modules/site-services.md
--
--   site.record_lot_retest(lot, retest_at, results)  CREATE OR REPLACE of 0752 (EXECUTE stays the owner's only, 0761):
--       EBMR-SITE-180 for a lot with neither date says it was kept without dates and is not retested to a date (it said
--       "its use ends at its expiry"); EBMR-SITE-185 names the expiry as "none" when the lot has none. Wording only:
--       every rule and code is as in 0752.
-- Messages: EBMR-SITE-180 to EBMR-SITE-185 (unchanged codes).

set local role ebmr_owner;

create or replace function site.record_lot_retest(p_lot uuid, p_retest_at timestamptz, p_results uuid[]) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  l        site.material_lot;
  m        site.erp_material;
  v_since  timestamptz;
  v_cur    timestamptz;
  r        site.lot_test_result;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', l.site_code));
  if site.lot_state(l.id) in ('CONSUMED', 'DESTROYED', 'REJECTED', 'RETURNED', 'RECALLED') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-180 lot %s is %s; it is not retested', l.lot_code, site.lot_state(l.id));
  end if;
  v_cur := site.lot_retest_at(l.id);
  if v_cur is null then
    raise exception using errcode = 'P0001',
      message = case when l.expires_at is null
                     then format('EBMR-SITE-180 lot %s has no retest date and no expiry date: it was kept without dates, so it is not retested to a date (PR-18)', l.lot_code)
                     else format('EBMR-SITE-180 lot %s has no retest date; its use ends at its expiry (PR-18)', l.lot_code) end;
  end if;
  if clock_timestamp() >= l.expires_at then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-181 lot %s expired at %s; an expired lot is never retested into use (PR-18)', l.lot_code, site.utc_text(l.expires_at));
  end if;
  v_since := coalesce((select x.decided_at from site.lot_retest x where x.lot_id = l.id order by x.decided_at desc, x.id desc limit 1), l.received_at);
  if p_results is null or cardinality(p_results) < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-182 a retest decision names the approved passing retest results it rests on (PR-18, D-S5-3)';
  end if;
  for r in select x.* from site.lot_test_result x where x.id = any (p_results) loop
    if r.lot_id <> l.id or r.purpose <> 'RETEST' or r.verdict <> 'PASS' or site.lot_test_state(r.id) <> 'APPROVED' or r.recorded_at <= v_since then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-182 result %s is not a current, QC-approved, passing retest result of lot %s recorded since its last retest basis (PR-18, D-S5-3)', r.id, l.lot_code);
    end if;
  end loop;
  if (select count(*) from site.lot_test_result x where x.id = any (p_results)) <> cardinality(array(select distinct unnest(p_results))) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-182 a retest decision names only results of the lot (PR-18)';
  end if;
  if exists (select 1 from site.lot_test_result x
              where x.lot_id = l.id and x.purpose = 'RETEST' and x.recorded_at > v_since and site.lot_test_is_current(x.id)
                and (not exists (select 1 from site.lot_test_approval a where a.result_id = x.id)
                     or (x.verdict = 'FAIL' and not site.lot_test_failure_resolved(x.id)))) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-183 lot %s has a retest result that is not approved, or an approved failure without an OOS record concluded with an assignable cause (PR-18, IN-20)', l.lot_code);
  end if;
  m := site.erp_material_current(l.material_code);
  if m.id is null or m.max_retest_months is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-184 the material master gives material %s no maximum retest interval; its lots are not retested to a new date (D-S5-3)', l.material_code);
  end if;
  if p_retest_at is null or p_retest_at <= clock_timestamp() or p_retest_at > l.expires_at
     or p_retest_at > clock_timestamp() + make_interval(months => m.max_retest_months) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-185 the new retest instant is in the future, never after the lot''s expiry (%s) and at most %s months from now (the material master''s maximum) (PR-18, D-S5-3)',
                       coalesce(site.utc_text(l.expires_at), 'none'), m.max_retest_months);
  end if;
  insert into site.lot_retest (lot_id, retest_at, result_ids, decided_by_person, decided_by_account, correlation_id)
  values (l.id, p_retest_at, array(select distinct unnest(p_results) order by 1), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke execute on function site.record_lot_retest(uuid, timestamptz, uuid[]) from public;

reset role;
