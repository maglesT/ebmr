-- Recipe core, Phase 3 slice 3a, review backlog #5 (slice 2b quick review; DI-17, IN-21): plant transitions evaluate
-- the batch's product.
--
-- An operator whose STEP.EXECUTE grant is limited to a product could not start or end a press use or open, close, hold
-- or charge a container: the plant commands check STEP.EXECUTE with the batch's product, but the state transitions
-- they then make (equipment_cleanliness START_USE and END_USE, the output_container events and its creation; machine
-- permission step.execute) were evaluated by the kernel's authority adapter with the session's location scope only, so
-- a product-limited grant never matched and the command failed closed. Default taken (the backlog's): those
-- transitions also evaluate the product. plant.transition_scope gives, for the permission step.execute on an aggregate
-- of type plant_equipment (the product of the unit's latest use: the use a START_USE starts is inserted before the move,
-- the one an END_USE ends is still the latest) or output_container (the container's product), {"product": <code>},
-- and '{}' for any other permission or aggregate. It is registered as the kernel's SCOPE hook (kernel 1150,
-- ADR-0018), which iam.platform_authority merges into the location scope; the kernel's own function is not changed
-- here. A grant limited to another product is refused as before; a grant without a product limit matches as before.
--
-- The function is owned by ebmr_owner, private, with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- #5: the product a plant transition's permission is evaluated for (header).
create function plant.transition_scope(p_permission text, p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_product text;
begin
  if lower(coalesce(p_permission, '')) <> 'step.execute' or p_aggregate_id is null
     or p_aggregate_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{}'::jsonb;
  end if;
  if p_aggregate_type = 'plant_equipment' then
    select u.product_code into v_product from plant.equipment_use u
     where u.equipment_id = p_aggregate_id::uuid order by u.started_at desc, u.id desc limit 1;
  elsif p_aggregate_type = 'output_container' then
    select c.product_code into v_product from plant.output_container c where c.id = p_aggregate_id::uuid;
  end if;
  return case when v_product is null then '{}'::jsonb else jsonb_build_object('product', v_product) end;
end
$$;
revoke all on function plant.transition_scope(text, text, text) from public;

select platform.register_hook('SCOPE', 'plant.transition_scope(text, text, text)');

reset role;
