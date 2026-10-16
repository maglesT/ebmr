-- Recipe core: the controlled-substance register export (Phase 6 slice 6e; draft control IN-53; default D-P6e-3; as the
-- PQR extract of 0910: a versioned query, a stored result and its SHA-256).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.controlled_register_v1(material, from, to)  STABLE, no clock: every movement of the controlled material in the
--       period (UTC calendar days, inclusive): RECEIPT (a lot received), each CONFIRMED custody act (TRANSFER, RETURN,
--       DESTRUCTION) with both custodians, DISPENSE (each consumption into a batch, with the custodians of its record) and
--       LOT_DESTRUCTION (a whole lot destroyed in the lot register). The layout is generic (material, lot, UTC time,
--       movement, quantity, unit, batch, persons) until the statutory forms are verified (D-P6e-3). Every array is
--       ordered, so the same data gives the same jsonb text and the same hash.
--   recipe.controlled_register_extract  insert-only: the query version, the parameters, the result, its SHA-256, who ran it.
--   recipe.run_controlled_register(material, from, to) returns uuid   CONTROLLED.REGISTER, never an administrator.
--   recipe.controlled_register_reproduces(extract) boolean            the query run again gives the same hash.
-- Messages EBMR-CSM-050 to EBMR-CSM-059.

set local role ebmr_owner;

create function recipe.controlled_register_v1(p_material text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with mv as (
    select l.received_at as at, 'RECEIPT' as movement, l.id as ref, l.lot_code, l.received_quantity as quantity, l.unit, null::text as batch_number,
           jsonb_build_array(l.received_by_person) as persons, l.supplier_lot as detail
      from site.material_lot l where l.material_code = p_material
    union all
    select c.recorded_at, c.kind, c.id, l.lot_code, c.quantity, c.unit, b.batch_number,
           to_jsonb(recipe.controlled_custodians(c.id)), coalesce(c.from_location || ' -> ' || c.to_location, c.note)
      from recipe.controlled_custody c join site.material_lot l on l.id = c.lot_id left join recipe.batch_execution b on b.id = c.batch_id
     where c.material_code = p_material and c.kind <> 'DISPENSE' and recipe.controlled_custody_state(c.id) = 'CONFIRMED'
    union all
    select x.consumed_at, 'DISPENSE', x.id, l.lot_code, x.quantity, x.unit, x.batch_number,
           coalesce((select to_jsonb(recipe.controlled_custodians(u.custody_id)) from recipe.controlled_custody_use u where u.consumption_id = x.id),
                    jsonb_build_array(x.consumed_by_person)), null
      from site.lot_consumption x join site.material_lot l on l.id = x.lot_id where x.material_code = p_material
    union all
    select d.recorded_at, 'LOT_DESTRUCTION', d.id, l.lot_code, d.quantity, d.unit, null, jsonb_build_array(d.performed_by_person), d.method
      from site.lot_destruction d join site.material_lot l on l.id = d.lot_id where l.material_code = p_material)
  select jsonb_build_object(
    'queryVersion', 1, 'materialCode', p_material, 'from', p_from::text, 'to', p_to::text,
    'statusNote', 'Draft control IN-53: NDPS Act and Rules not verified; generic layout (D-P6e-3)',
    'rows', coalesce((select jsonb_agg(jsonb_build_object('at', site.utc_text(r.at), 'movement', r.movement, 'ref', r.ref, 'lot', r.lot_code,
                                                          'quantity', r.quantity::text, 'unit', r.unit, 'batch', r.batch_number, 'persons', r.persons,
                                                          'detail', r.detail)
                                       order by r.at, r.movement, r.ref)
                        from mv r where (r.at at time zone 'UTC')::date between p_from and p_to), '[]'::jsonb),
    'totals', coalesce((select jsonb_object_agg(t.movement, t.total) from (
                          select r.movement, sum(r.quantity)::text as total from mv r where (r.at at time zone 'UTC')::date between p_from and p_to group by r.movement) t),
                       '{}'::jsonb))
$$;

create function recipe.controlled_register_sha256(p_result jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(p_result::text, 'UTF8')), 'hex')
$$;

create table recipe.controlled_register_extract (
  id               uuid primary key default gen_random_uuid(),
  material_code    text not null,
  period_from      date not null,
  period_to        date not null,
  query_version    integer not null check (query_version = 1),
  result           jsonb not null,
  result_sha256    text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  run_by_person    uuid not null,
  run_by_account   uuid not null,
  role_code        text not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid not null,
  check (period_from <= period_to)
);
revoke all on recipe.controlled_register_extract from public;
grant select on recipe.controlled_register_extract to ebmr_app;
select platform.enforce_db_time('recipe.controlled_register_extract', array['recorded_at']);
select kernel.register_audited_table('recipe.controlled_register_extract', 'controlled_register_extract', 'id', true);
create trigger zz_immutable before update or delete on recipe.controlled_register_extract for each row execute function site.india_record_immutable();

create function recipe.run_controlled_register(p_material text, p_from date, p_to date) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_ctx    jsonb;
  v_result jsonb;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  v_ctx := iam.require_permission('CONTROLLED.REGISTER', '{}'::jsonb);
  if coalesce(p_material, '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$' or p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-050 a register export names the material and a period of at most ten years, from no later than to';
  end if;
  if not exists (select 1 from plant.controlled_product r where p_material = any (r.material_codes)) then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-051 %s was never flagged as a controlled material of a product (IN-53)', p_material);
  end if;
  v_result := recipe.controlled_register_v1(p_material, p_from, p_to);
  insert into recipe.controlled_register_extract (material_code, period_from, period_to, query_version, result, result_sha256, run_by_person, run_by_account,
                                                  role_code, correlation_id)
  values (p_material, p_from, p_to, 1, v_result, recipe.controlled_register_sha256(v_result), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          v_ctx ->> 'role_code', (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.controlled_register_reproduces(p_extract uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select recipe.controlled_register_sha256(recipe.controlled_register_v1(x.material_code, x.period_from, x.period_to)) = x.result_sha256
    from recipe.controlled_register_extract x where x.id = p_extract
$$;

revoke all on function recipe.controlled_register_v1(text, date, date), recipe.controlled_register_sha256(jsonb), recipe.run_controlled_register(text, date, date),
  recipe.controlled_register_reproduces(uuid) from public;
grant execute on function recipe.controlled_register_sha256(jsonb), recipe.run_controlled_register(text, date, date), recipe.controlled_register_reproduces(uuid) to ebmr_app;

reset role;
