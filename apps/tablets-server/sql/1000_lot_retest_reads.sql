-- Tablets: the GMP lot reads take the lot's retest instant from site.lot_retest_at (Phase 3 slice 5a step 3; site
-- services 0752; backlog slice 1 #5; PR-18). A lot QC retested through approved results (site.record_lot_retest) has a
-- new retest instant; the block and the first-expiring rule read it, not the receipt's.
--   * tab.lot_facts, replaced from its latest definition (0801): retestAtUs on GMP from site.lot_retest_at.
--   * tab.tb01_first_expiring, replaced from its latest definition (0843): the GMP lots before their retest instant from
--     site.lot_retest_at, and ordered by it. The sandbox branches are unchanged.
-- Nothing else changes. CREATE OR REPLACE keeps the owner and grants.

set local role ebmr_owner;

-- As 0801_gmp_execution_lots.sql; retestAtUs from site.lot_retest_at.
create or replace function tab.lot_facts(p_code text, p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, platform, kernel, pg_temp as $$
declare
  v_site    text;
  v_markets text[];
  v_id      uuid;
  v_state   text;
  v_tested  boolean;
  l         record;
begin
  if p_code is null then
    return null;
  end if;
  if kernel.installation_kind() = 'SANDBOX' then
    return (select jsonb_build_object(
                     'lotCode', s.lot_code, 'materialCode', s.material_code, 'materialName', s.material_name, 'status', s.status,
                     'expiresAtUs', case when s.expires_at is null then null else platform.epoch_micros(s.expires_at)::text end,
                     'retestAtUs', case when s.retest_at is null then null else platform.epoch_micros(s.retest_at)::text end,
                     'identityTested', s.identity_tested)
              from tab.sandbox_lot s where s.lot_code = p_code);
  end if;
  if p_batch is not null then
    select b.site, b.markets into v_site, v_markets from recipe.stub_batch b where b.id = p_batch;
  end if;
  if v_site is not null then
    select m.id into v_id from site.material_lot m where m.site_code = v_site and m.lot_code = p_code;
  elsif (select count(*) from site.material_lot m where m.lot_code = p_code) = 1 then
    select m.id into v_id from site.material_lot m where m.lot_code = p_code;
  end if;
  if v_id is null then
    return null;
  end if;
  select * into l from site.material_lot m where m.id = v_id;
  v_state := site.lot_state(v_id);
  if v_markets is not null then
    v_tested := (select x.p_problem is null from site.identity_rule_problem((select m from site.material_lot m where m.id = v_id), v_markets) x);
  else
    v_tested := exists (select 1 from site.lot_identity_result r where r.lot_id = v_id and r.result = 'PASS')
                and not exists (select 1 from site.lot_identity_result r where r.lot_id = v_id and r.result = 'FAIL');
  end if;
  return jsonb_build_object(
    'lotCode', l.lot_code, 'materialCode', l.material_code, 'materialName', l.material_name,
    'status', case when v_state = any (site.usable_lot_states()) then 'RELEASED'
                   when v_state in ('QUARANTINE', 'ON_HOLD', 'RECALLED', 'REJECTED', 'RETURNED') then v_state
                   else 'REJECTED' end,
    'expiresAtUs', platform.epoch_micros(l.expires_at)::text,
    'retestAtUs', case when site.lot_retest_at(v_id) is null then null else platform.epoch_micros(site.lot_retest_at(v_id))::text end,
    'identityTested', coalesce(v_tested, false));
end
$$;

-- As 0843_tb01_entry_guards.sql; the GMP retest instant from site.lot_retest_at.
create or replace function tab.tb01_first_expiring(p_batch uuid, p_material text, p_exclude text[], p_now timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, kernel, pg_temp as $$
declare
  v_site    text;
  v_markets text[];
  v_code    text;
begin
  select b.site, b.markets into v_site, v_markets from recipe.stub_batch b where b.id = p_batch;
  if v_markets is null then
    select b.market_set into v_markets from recipe.batch_execution b where b.id = p_batch;
  end if;
  if kernel.installation_kind() = 'SANDBOX' then
    select l.lot_code into v_code from tab.sandbox_lot l
     where l.material_code = p_material and l.status = 'RELEASED' and not (l.lot_code = any (coalesce(p_exclude, '{}')))
       and (l.expires_at is null or l.expires_at > p_now) and (l.retest_at is null or l.retest_at > p_now)
       and (l.identity_tested or coalesce(v_markets <@ array['IN'], true))
     order by l.expires_at nulls last, l.retest_at nulls last, l.registered_at, l.lot_code limit 1;
    return v_code;
  end if;
  select l.lot_code into v_code from site.material_lot l
   where l.site_code = v_site and l.material_code = p_material and not (l.lot_code = any (coalesce(p_exclude, '{}')))
     and site.lot_state(l.id) = any (site.usable_lot_states())
     and l.expires_at > p_now and (site.lot_retest_at(l.id) is null or site.lot_retest_at(l.id) > p_now)
     and (select x.p_problem is null from site.identity_rule_problem(l, coalesce(v_markets, array['IN'])) x)
     and (site.lot_available(l.id) > 0
          or exists (select 1 from site.lot_reservation r where r.lot_id = l.id and r.batch_id = p_batch and site.reservation_is_open(r)
                                                             and site.reservation_remaining(r.id) > 0))
   order by l.expires_at, site.lot_retest_at(l.id) nulls last, l.received_at, l.lot_code limit 1;
  return v_code;
end
$$;

reset role;
