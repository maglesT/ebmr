-- Site services: the site side of a dispensing consumption is authorised in the lot's site with the batch's product
-- (Phase 6 exit review 6jc-R16, the rest; IN-04, DI-21, DI-17, INV-13).
--
-- Handbook: modules/site-services.md
--
-- site.consume_reservation (0712), called only by the edition's batch-side definer (recipe.consume_lot, which checks
-- DISPENSE.EXECUTE at the actor's location with the batch's product since recipe-core 1217), checked DISPENSE.EXECUTE
-- again in the lot's site only. A request without a product is matched by every product-limited requirement, so a
-- requirement limited to product A refused every consumption at the site. It now checks in the lot's site with the
-- batch's product as the site register knows the batch (site.subject_identity, 0730; the pattern of 0733 and 0841). A
-- batch the register does not know (a test run) keeps the lot's site only, the stricter scope. Replaced from its latest
-- definition (0712) with that one line; every other guard, message and error code is unchanged. CREATE OR REPLACE keeps
-- the owner and the privileges (still not executable by the application role).

set local role ebmr_owner;

create or replace function site.consume_reservation(p_reservation uuid, p_batch_id uuid, p_batch_number text, p_market_set text[],
                                         p_material_code text, p_quantity numeric, p_unit text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  r        site.lot_reservation;
  l        site.material_lot;
  v_state  platform.aggregate_state;
  v_prob   text;
  v_basis  text;
  v_left   numeric;
  v_id     uuid;
  v_qty    numeric;
  v_tr     jsonb;
begin
  perform iam.assert_not_administrator();
  select * into r from site.lot_reservation where id = p_reservation;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-160 no reservation %s: material is consumed only against a reservation (INV-13)', p_reservation);
  end if;
  l := site.lock_lot(r.lot_id);
  select * into r from site.lot_reservation where id = p_reservation for update;
  -- 6jc-R16: in the lot's site with the batch's product (its register identity; a batch the register does not know, a
  -- test run, keeps the lot's site only, where a product-limited requirement still applies).
  perform iam.require_permission('DISPENSE.EXECUTE', jsonb_build_object('site', l.site_code)
                                 || coalesce(jsonb_strip_nulls(jsonb_build_object('product', nullif(btrim(site.subject_identity('BATCH', p_batch_id) ->> 'productCode'), ''))), '{}'::jsonb));
  if p_material_code is null or p_material_code is distinct from l.material_code then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-161 wrong material: lot %s is %s, the step expects %s (PR-18)', l.lot_code, l.material_code, coalesce(p_material_code, 'NULL'));
  end if;
  if r.batch_id is distinct from p_batch_id or r.batch_number is distinct from p_batch_number then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-162 the reservation is for batch %s, not batch %s (INV-13)', r.batch_number, coalesce(p_batch_number, 'NULL'));
  end if;
  if exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-163 the reservation was revoked: %s (INV-13)',
      (select concat_ws(': ', x.cause, x.reason_text) from site.lot_reservation_revocation x where x.reservation_id = r.id));
  end if;
  if clock_timestamp() >= r.expires_at then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-164 the reservation expired at %s (INV-13)', site.utc_text(r.expires_at));
  end if;
  select * into v_state from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = l.id;
  if not (v_state.state = any (site.usable_lot_states())) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-165 lot %s is %s and cannot be used (INV-13, PR-18)', l.lot_code, v_state.state);
  end if;
  if v_state.version <> r.lot_state_version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-163 the status of lot %s changed after the reservation was granted; reserve it again (INV-13)', l.lot_code);
  end if;
  v_prob := site.lot_dates_problem(l);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-166 ' || v_prob;
  end if;
  if p_quantity is null or p_quantity <= 0 or p_unit is distinct from l.unit then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-167 a consumption is a positive quantity in the lot''s unit %s (INV-13)', l.unit);
  end if;
  v_left := site.reservation_remaining(r.id);
  if p_quantity > v_left then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-168 the reservation has %s %s left; %s %s cannot be consumed (INV-13)', v_left, l.unit, p_quantity, p_unit);
  end if;
  v_qty := site.lot_quantity(l.id);
  if p_quantity > v_qty then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-168 lot %s holds %s %s; %s %s cannot be consumed: a lot quantity is never negative (INV-13)', l.lot_code, v_qty, l.unit,
                       p_quantity, p_unit);
  end if;
  select x.p_problem, x.p_basis into v_prob, v_basis from site.identity_rule_problem(l, p_market_set) x;
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-169 ' || v_prob;
  end if;

  insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before,
                                    quantity_after, market_set, release_route, identity_basis, consumed_by_person, consumed_by_account, xact_id)
  values (l.id, r.id, p_batch_id, p_batch_number, r.edition, l.material_code, p_quantity, p_unit, v_qty, v_qty - p_quantity, p_market_set,
          site.lot_release_route(l.id), v_basis, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 0)
  returning id into v_id;
  if v_qty - p_quantity = 0 then
    v_tr := site.lot_transition(site.lock_lot(l.id), 'CONSUME', v_state.version, null, null);
  end if;
  return jsonb_build_object('consumption_id', v_id, 'lot_id', l.id, 'quantity_after', (v_qty - p_quantity)::text, 'identity_basis', v_basis,
                            'lot_state', coalesce(v_tr ->> 'to', v_state.state));
end
$$;

reset role;
