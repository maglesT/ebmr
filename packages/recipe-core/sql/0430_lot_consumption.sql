-- Recipe core, batch side of material consumption (build outline 5.2.9 consumption guard; controls INV-13,
-- INV-14 input side, IN-24 (c), PR-18; Phase 3 slice 1 plan, defaults D-S1-1, D-S1-2, D-S1-4).
--
-- The site's consumption guard (site.consume_reservation, site-services 0712) is not executable by the application:
-- the identity-test rule depends on the consuming batch's market set, which only the edition's own batch record
-- holds. recipe.consume_lot reads the batch's number and market set from recipe.batch_execution (never from the
-- caller) and passes them to the site, so a dispensing step cannot claim an India-only market set to consume a
-- vendor-history lot into a batch for other markets. Single-database deployment (D-S1-1): the reservation and the
-- consumption are in this one transaction. The tablet dispensing and charge-in blocks call this in slice 3 (D-S1-4).

set local role ebmr_owner;

create function recipe.consume_lot(p_batch uuid, p_reservation uuid, p_material_code text, p_quantity numeric, p_unit text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  b recipe.batch_execution;
begin
  if kernel.current_actor() is null then
    raise exception using errcode = 'P0001',
      message = 'No validated command: material is consumed inside a command started with kernel.begin_command (INV-07; EBMR-RCP-430)';
  end if;
  perform iam.assert_not_administrator();
  -- Dispensing against a batch (DI-17), at the actor's location like the execution writers; the site checks it again
  -- in the lot's site.
  perform iam.require_permission('DISPENSE.EXECUTE', iam.actor_location_scope());
  select * into b from recipe.batch_execution where id = p_batch for share;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s: material is consumed only into an issued batch (INV-14; EBMR-RCP-431)', p_batch);
  end if;
  return site.consume_reservation(p_reservation, b.id, b.batch_number, b.market_set, p_material_code, p_quantity, p_unit)
         || jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'market_set', to_jsonb(b.market_set));
end
$$;

grant execute on function recipe.consume_lot(uuid, uuid, text, numeric, text) to ebmr_app;

reset role;
