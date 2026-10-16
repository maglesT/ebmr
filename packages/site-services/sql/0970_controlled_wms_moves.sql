-- Site services: a WMS move of a controlled API lot needs dual custody (Phase 6 slice 6e; draft control IN-53; default
-- D-P6e-6; docs/build-plan/phase-6/slice-6e-0-interfaces.md).
--
-- Handbook: modules/site-services.md
--
-- site.apply_wms_stock_move is re-created from its definition in 0911 with one addition: when the lot's material is in
-- effect a controlled material of some product (plant.material_is_controlled, recipe-core 1031), the move needs a
-- CONFIRMED TRANSFER custody record of the lot from and to the same locations and of exactly the quantity sent, not used
-- before (recipe.controlled_transfer_for, recipe-core 1032); the move uses it (recipe.controlled_custody_use). A move
-- without one already happened, so it is never refused: it is recorded with the problem, the integration alarm and the
-- lot location exception of 0911 (D-P6a-7), which blocks the lot's release and issue until QA closes it with a
-- deviation. Lots of other materials are moved exactly as before. The function bodies are bound when they run, so the
-- recipe-core objects created after this migration are found. The search path gains plant and recipe.

set local role ebmr_owner;

create or replace function site.apply_wms_stock_move(p jsonb, p_message uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, plant, recipe, pg_temp as $$
declare
  v_site  text := site.actor_site();
  v_ad    iam.integration_adapter := iam.current_integration_adapter();
  l       site.material_lot;
  v_prob  text;
  v_move  uuid;
  v_alarm uuid;
  v_exc   uuid;
  v_cust  uuid;
  v_ctl   text;
begin
  select * into l from site.material_lot where site_code = v_site and lot_code = p ->> 'lotNumber';
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-002 the WMS moved lot %s, which site %s does not hold (DI-31: wrong identity)', p ->> 'lotNumber', v_site);
  end if;
  perform site.lock_lot(l.id);
  if p -> 'quantity' ->> 'unit' is distinct from l.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-003 the WMS moved lot %s in %s; the lot is stocked in %s (DI-31)', l.lot_code, p -> 'quantity' ->> 'unit', l.unit);
  end if;
  v_prob := site.location_move_problem(l.id, p ->> 'toLocationKind');
  -- IN-53: a lot of a controlled material moves only under dual custody (a CONFIRMED TRANSFER record, used once).
  if plant.material_is_controlled(l.material_code) then
    v_cust := recipe.controlled_transfer_for(l.id, p ->> 'fromLocation', p ->> 'toLocation', p -> 'quantity' ->> 'value', p -> 'quantity' ->> 'unit');
    if v_cust is null then
      v_ctl := format('lot %s of controlled API %s moved from %s to %s without a transfer record signed by two custodians (IN-53)',
                      l.lot_code, l.material_code, p ->> 'fromLocation', p ->> 'toLocation');
      v_prob := case when v_prob is null then v_ctl else v_prob || '; ' || v_ctl end;
    end if;
  end if;
  insert into site.lot_location_move (lot_id, site_code, from_location, to_location, to_kind, quantity_value, quantity_unit, moved_at,
                                      inbound_message_id, lot_state, problem)
  values (l.id, v_site, p ->> 'fromLocation', p ->> 'toLocation', p ->> 'toLocationKind', p -> 'quantity' ->> 'value', p -> 'quantity' ->> 'unit',
          platform.epoch_us_to_timestamptz(p ->> 'movedAt'), p_message, site.lot_state(l.id), v_prob)
  returning id into v_move;
  if v_cust is not null then
    insert into recipe.controlled_custody_use (custody_id, move_id) values (v_cust, v_move);
  end if;
  if v_prob is not null then
    v_alarm := platform.raise_integration_alarm(v_ad, 'OUT_OF_RANGE', 'MAJOR', p_message,
      jsonb_build_object('rule', case when v_ctl is null then 'PR-46' else 'PR-46, IN-53' end, 'lotId', l.id, 'lotCode', l.lot_code, 'toLocation', p ->> 'toLocation',
                         'toLocationKind', p ->> 'toLocationKind', 'problem', v_prob));
    insert into site.lot_location_exception (lot_id, move_id, problem, alarm_id) values (l.id, v_move, v_prob, v_alarm) returning id into v_exc;
  end if;
  return jsonb_build_object('moveId', v_move, 'lotId', l.id, 'problem', v_prob, 'exceptionId', v_exc, 'alarmId', v_alarm);
end
$$;
revoke all on function site.apply_wms_stock_move(jsonb, uuid) from public;

reset role;
