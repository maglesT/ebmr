-- Retest of a material lot through approved LIMS-lite results (Phase 3 slice 5a step 3; slice 5 plan D-S5-3; backlog
-- slice 1 #5; controls PR-18, IN-24 (a)(b)).
--
-- A lot past its retest instant was unusable for good: nothing could give it a new one. Now:
--   site.lot_retest                  insert-only: QC's decision of a new retest instant for a lot, naming the approved
--                                    passing RETEST results it rests on
--   site.record_lot_retest(lot, at, results)   QC.RESULT_APPROVE at the lot's site. Refused unless every named result
--                                    is a current, approved, passing RETEST result of this lot recorded since the lot's
--                                    last retest basis (receipt or the previous retest decision), no approved RETEST
--                                    failure since then is unresolved, the lot is not expired and not in a final state,
--                                    and the new instant is in the future, never after the lot's expiry and never beyond
--                                    the material master's maximum retest interval from now (a material without one
--                                    has no retest decision: refused, fail closed)
--   site.lot_retest_at(lot)          the lot's retest instant now: the latest decision's, else the receipt's
-- Replaced from their latest definitions to read site.lot_retest_at instead of the receipt's retest instant:
-- site.lot_dates_problem (0710), site.reserve_lot (0712), the view site.material_lot_usage (0712). Nothing else changes.
-- Messages: EBMR-SITE-180 to 189.

set local role ebmr_owner;

create table site.lot_retest (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null references site.material_lot (id),
  retest_at            timestamptz not null,
  result_ids           uuid[] not null check (cardinality(result_ids) >= 1),
  decided_by_person    uuid not null,
  decided_by_account   uuid not null,
  decided_at           timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index lot_retest_lot on site.lot_retest (lot_id, decided_at desc);
revoke all on site.lot_retest from public;

select platform.enforce_db_time('site.lot_retest', array['decided_at']);
select kernel.register_audited_table('site.lot_retest', 'material_lot', 'lot_id', true);

create function site.lot_retest_at(p_lot uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce((select r.retest_at from site.lot_retest r where r.lot_id = l.id order by r.decided_at desc, r.id desc limit 1), l.retest_at)
  from site.material_lot l where l.id = p_lot
$$;

create function site.record_lot_retest(p_lot uuid, p_retest_at timestamptz, p_results uuid[]) returns uuid
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
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-180 lot %s has no retest date; its use ends at its expiry (PR-18)', l.lot_code);
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
                       site.utc_text(l.expires_at), m.max_retest_months);
  end if;
  insert into site.lot_retest (lot_id, retest_at, result_ids, decided_by_person, decided_by_account, correlation_id)
  values (l.id, p_retest_at, array(select distinct unnest(p_results) order by 1), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- As 0710_material_lots.sql; the retest instant from site.lot_retest_at.
create or replace function site.lot_dates_problem(l site.material_lot) returns text
language sql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when clock_timestamp() >= l.expires_at
      then format('lot %s expired at %s (PR-18)', l.lot_code, site.utc_text(l.expires_at))
    when site.lot_retest_at(l.id) is not null and clock_timestamp() >= site.lot_retest_at(l.id)
      then format('lot %s was due for retest at %s and must be retested before use (PR-18)', l.lot_code, site.utc_text(site.lot_retest_at(l.id)))
  end
$$;

-- As 0712_material_lot_commands.sql; the retest instant from site.lot_retest_at.
create or replace function site.reserve_lot(p_lot uuid, p_batch_id uuid, p_batch_number text, p_edition text, p_quantity numeric, p_unit text,
                                            p_expires_at timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  l        site.material_lot;
  v_state  platform.aggregate_state;
  v_prob   text;
  v_avail  numeric;
  v_id     uuid;
  v_retest timestamptz;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  select * into v_state from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = l.id;
  if not (v_state.state = any (site.usable_lot_states())) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-141 lot %s is %s: only a released lot is reserved (INV-13, PR-18)', l.lot_code, v_state.state);
  end if;
  v_prob := site.lot_dates_problem(l);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-142 ' || v_prob;
  end if;
  if p_quantity is null or p_quantity <= 0 or p_unit is distinct from l.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-143 a reservation is a positive quantity in the lot''s unit %s (INV-13)', l.unit);
  end if;
  v_retest := site.lot_retest_at(l.id);
  if p_expires_at is null or p_expires_at <= clock_timestamp() or p_expires_at > l.expires_at
     or (v_retest is not null and p_expires_at > v_retest) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-144 a reservation expires in the future and no later than the lot''s retest or expiry instant (%s)',
                       site.utc_text(coalesce(least(v_retest, l.expires_at), l.expires_at)));
  end if;
  v_avail := site.lot_available(l.id);
  if p_quantity > v_avail then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-145 lot %s has %s %s available after open reservations; %s %s cannot be reserved (INV-13)', l.lot_code, v_avail, l.unit,
                       p_quantity, p_unit);
  end if;
  insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person,
                                    reserved_by_account)
  values (l.id, p_batch_id, p_batch_number, p_edition, p_quantity, p_unit, p_expires_at, v_state.version, (v_ctx ->> 'person_id')::uuid,
          (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- As 0712_material_lot_commands.sql; the retest instant from site.lot_retest_at.
create or replace view site.material_lot_usage as
  select l.id as lot_id, l.site_code, l.lot_code, l.material_code, l.material_name, l.material_kind, s.state, s.version as state_version,
         case when s.state in ('CONSUMED', 'DESTROYED', 'REJECTED', 'RETURNED', 'RECALLED') then s.state
              when clock_timestamp() >= l.expires_at then 'EXPIRED'
              when site.lot_retest_at(l.id) is not null and clock_timestamp() >= site.lot_retest_at(l.id) then 'RETEST_DUE'
              else s.state end as usage_status,
         site.lot_quantity(l.id) as quantity, l.unit, site.lot_available(l.id) as available, site.lot_retest_at(l.id) as retest_at, l.expires_at,
         site.lot_release_route(l.id) as release_route
  from site.material_lot l
  join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id;

revoke all on site.lot_retest from ebmr_app;
grant select on site.lot_retest, site.material_lot_usage to ebmr_app;
grant execute on function site.record_lot_retest(uuid, timestamptz, uuid[]), site.lot_retest_at(uuid) to ebmr_app;

reset role;
