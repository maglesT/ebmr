-- Plant, part 5: clearances of rooms and lines and the start of a batch stage in a room or a packaging order on a line
-- (outline 5.2.8; Phase 3 slice 1 plan item 2).
--
-- Controls: INV-15, IN-21, PR-26, PR-34 (a start needs a passed clearance of the required type recorded after the
-- previous occupancy or order); S23, S24 (the clearance is performed by one person and verified, with a signature, by a
-- different person; previous product, batch and order recorded); PR-35 (one active packaging order per line); IN-26
-- (b)(c), PR-25 (a second open batch of a different product in a room only when the room is segregated with a recorded
-- risk justification; highly potent products only in negative-pressure-cascade rooms).
--
-- Required clearance type (L-29):
--   LINE   PACKAGING_ORDER for every order, keyed on the packaging order and the artwork set, even for the same bulk batch
--   ROOM   PRODUCT_CHANGE when there was no previous batch or it was another product (the room's last cleaning MAJOR);
--          CAMPAIGN for the same product inside an open room campaign within its limits (a PRODUCT_CHANGE clearance,
--          being the fuller one, is accepted too)
--
-- Writers (SECURITY DEFINER; refuse administrators, then check the permission):
--   record_clearance       STEP.EXECUTE     the performer (the command's validated person)
--   verify_clearance       STEP.VERIFY      the verifier, with signature VERIFIED on aggregate plant_clearance
--   start_area_occupancy   STEP.EXECUTE
--   end_area_occupancy     STEP.EXECUTE
-- Out of service, return to service and marking a clean area dirty are plain transitions of machine area_status
-- (platform.transition; permission LOGBOOK.ENTRY and a reason).

set local role ebmr_owner;

create function plant.latest_occupancy(p_area uuid) returns plant.area_occupancy
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select * from plant.area_occupancy where area_id = p_area order by started_at desc, id desc limit 1
$$;

-- The clearance type a start of p_product (and, on a line, p_order) in the area requires now. {type, reason, campaign_id}.
create function plant.required_clearance(p_area uuid, p_product text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  a      plant.area;
  v_prev plant.area_occupancy := plant.latest_occupancy(p_area);
  v_camp jsonb;
begin
  select * into a from plant.area where id = p_area;
  if a.kind = 'LINE' then
    return jsonb_build_object('type', 'PACKAGING_ORDER', 'reason', 'every packaging order on a line (L-29)');
  end if;
  if v_prev.id is null then
    return jsonb_build_object('type', 'PRODUCT_CHANGE', 'reason', 'first batch in the room');
  end if;
  if v_prev.product_code <> p_product then
    return jsonb_build_object('type', 'PRODUCT_CHANGE', 'reason', format('product change from %s', v_prev.product_code));
  end if;
  v_camp := plant.campaign_check(null, p_area, p_product, null);
  if (v_camp ->> 'ok')::boolean then
    return jsonb_build_object('type', 'CAMPAIGN', 'reason', 'same product inside the open campaign', 'campaign_id', v_camp ->> 'campaign_id');
  end if;
  return jsonb_build_object('type', 'PRODUCT_CHANGE', 'reason', format('same product, but %s', v_camp ->> 'reason'));
end
$$;

-- The performer records the clearance done before the next batch (or order) in the room or line. The previous
-- product, batch, order and artwork set come from the area's latest occupancy.
create function plant.record_clearance(p_area_code text, p_type text, p_next_batch text, p_next_product text,
                                       p_next_order text default null, p_next_artwork_set text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  a       plant.area;
  v_state text;
  v_prev  plant.area_occupancy;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', p_next_product));
  a := plant.area_by_code(p_area_code, true);
  perform plant.require_product(p_next_product);
  v_state := plant.state_of('plant_area', a.id);
  if not (v_state in ('CLEAN', 'CLEARED_FOR_BATCH') or (v_state = 'IN_USE' and a.segregated)) then
    perform plant.fail(format('%s is %s: a clearance is recorded in a CLEAN area (or alongside a batch in a segregated room) (IN-21; EBMR-PLANT-100)',
                              a.code, v_state));
  end if;
  if a.kind = 'LINE' and (p_type <> 'PACKAGING_ORDER' or plant.is_blank(p_next_order) or plant.is_blank(p_next_artwork_set)) then
    perform plant.fail('A line clearance is a PACKAGING_ORDER clearance naming the packaging order and the artwork set (L-29, PR-34; EBMR-PLANT-101)');
  end if;
  if a.kind = 'ROOM' and (p_type not in ('PRODUCT_CHANGE', 'CAMPAIGN') or p_next_order is not null or p_next_artwork_set is not null) then
    perform plant.fail('A room clearance is a PRODUCT_CHANGE or CAMPAIGN clearance, without a packaging order (EBMR-PLANT-101)');
  end if;
  v_prev := plant.latest_occupancy(a.id);
  insert into plant.clearance (area_id, clearance_type, previous_occupancy_id, previous_product, previous_batch, previous_order, previous_artwork_set,
                               next_product, next_batch, next_order, next_artwork_set, performed_by, performed_account)
  values (a.id, p_type, v_prev.id, v_prev.product_code, v_prev.batch_ref, v_prev.packaging_order, v_prev.artwork_set,
          p_next_product, p_next_batch, nullif(btrim(p_next_order), ''), nullif(btrim(p_next_artwork_set), ''),
          plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

-- The verifier signs VERIFIED on the clearance (aggregate plant_clearance) and records the result here in their own
-- command; they are not the performer (S23, S24). A PASSED clearance of a CLEAN area moves it to CLEARED_FOR_BATCH.
create function plant.verify_clearance(p_clearance uuid, p_result text, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  c        plant.clearance_status;
  v_person uuid;
  v_signer uuid;
begin
  perform iam.assert_not_administrator();
  select * into c from plant.clearance_status where id = p_clearance;
  if c.id is null then
    perform plant.fail(format('Unknown clearance %s (EBMR-PLANT-102)', p_clearance));
  end if;
  perform iam.require_permission('STEP.VERIFY', jsonb_build_object('product', c.next_product));
  v_person := plant.actor_person();
  perform 1 from plant.area where id = c.area_id for update;
  select * into c from plant.clearance_status where id = p_clearance;
  if c.result is not null then
    perform plant.fail(format('Clearance %s is already verified (EBMR-PLANT-102)', p_clearance));
  end if;
  if p_result not in ('PASSED', 'FAILED') then
    perform plant.fail('A clearance is verified as PASSED or FAILED (EBMR-PLANT-103)');
  end if;
  if v_person = c.performed_by then
    perform plant.fail('A clearance is verified by a person other than the one who performed it (S23, S24; EBMR-PLANT-104)');
  end if;
  perform platform.verify_signature(p_signature, 'VERIFIED', 'plant_clearance', p_clearance::text);
  select signer_person into v_signer from esig.signature where id = p_signature;
  if v_signer is distinct from v_person then
    perform plant.fail('The verification signature is the verifier''s own (EBMR-PLANT-105)');
  end if;
  if c.performed_at <= coalesce(plant.area_last_occupancy_event(c.area_id), '-infinity'::timestamptz) then
    perform plant.fail('A batch started or ended, or a cleaning was verified, in the area after this clearance was performed: record a new clearance (INV-15; EBMR-PLANT-106)');
  end if;
  insert into plant.clearance_verification (clearance_id, result, verified_by, signature_id) values (p_clearance, p_result, v_person, p_signature);
  if p_result = 'PASSED' and plant.state_of('plant_area', c.area_id) = 'CLEAN' then
    perform plant.move('area_status', 'plant_area', c.area_id, 'CLEAR');
  end if;
end
$$;

create function plant.clearance_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
  select coalesce((
    select jsonb_build_object(
      'exists', true,
      'aggregate_id', c.id::text,
      'content_version', 1,
      'content', jsonb_build_object(
        'area', a.code, 'area_kind', a.kind, 'type', c.clearance_type,
        'previous', jsonb_build_object('product', c.previous_product, 'batch', c.previous_batch, 'order', c.previous_order,
                                       'artwork_set', c.previous_artwork_set, 'occupancy_id', c.previous_occupancy_id),
        'next', jsonb_build_object('product', c.next_product, 'batch', c.next_batch, 'order', c.next_order, 'artwork_set', c.next_artwork_set),
        'performed_by', c.performed_by, 'performed_at', recipe.utc_text(c.performed_at)),
      'state', coalesce((select v.result from plant.clearance_verification v where v.clearance_id = c.id), 'PERFORMED'),
      'scope', jsonb_build_object('product', c.next_product),
      'entered_by', jsonb_build_array(c.performed_by))
    from plant.clearance c join plant.area a on a.id = c.area_id where c.id::text = p_id), '{"exists": false}'::jsonb)
$$;

select esig.register_content_provider('plant_clearance', 'plant.clearance_content(text)',
  'A clearance of a room or line: type, previous and next product, batch, order and artwork set, performer (outline 5.2.8; S23, S24)');
select esig.register_signed_table('plant.clearance', 'plant_clearance', 'id',
  array['area_id', 'clearance_type', 'previous_occupancy_id', 'previous_product', 'previous_batch', 'previous_order', 'previous_artwork_set',
        'next_product', 'next_batch', 'next_order', 'next_artwork_set', 'performed_by', 'performed_at']);

-- Starts a batch stage in a room or a packaging order on a line. Refused unless the area is cleared for it by a passed,
-- verified, unused clearance of the required type recorded after the previous occupancy, for this batch and product
-- (and on a line this order and artwork set); IN-26 room eligibility applies.
create function plant.start_area_occupancy(p_area_code text, p_batch_ref text, p_product text, p_stage text,
                                           p_order text default null, p_artwork_set text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  a        plant.area;
  p        plant.product;
  v_state  text;
  v_other  plant.area_occupancy_status;
  v_prev   plant.area_occupancy;
  v_req    jsonb;
  v_after  timestamptz;
  c        plant.clearance_status;
  v_clean  plant.cleaning_status;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', p_product));
  a := plant.area_by_code(p_area_code, true);
  p := plant.require_product(p_product);
  if plant.is_blank(p_batch_ref) or plant.is_blank(p_stage) then
    perform plant.fail('A start in a room or line names the batch and the stage (EBMR-PLANT-120)');
  end if;
  if a.kind = 'LINE' and (plant.is_blank(p_order) or plant.is_blank(p_artwork_set)) then
    perform plant.fail('A start on a line names the packaging order and its artwork set (L-29; EBMR-PLANT-121)');
  end if;
  if a.kind = 'ROOM' and (p_order is not null or p_artwork_set is not null) then
    perform plant.fail('Packaging orders run on lines (EBMR-PLANT-121)');
  end if;
  -- IN-26 (c): a highly potent product only in a room with a negative pressure cascade.
  if p.highly_potent and not a.negative_pressure then
    perform plant.fail(format('%s is highly potent: it is processed only in a room with a negative pressure cascade, and %s is not one (IN-26 (c); EBMR-PLANT-122)',
                              p.code, a.code));
  end if;
  v_state := plant.state_of('plant_area', a.id);
  if v_state = 'IN_USE' then
    select * into v_other from plant.area_occupancy_status where area_id = a.id and ended_at is null order by started_at limit 1;
    if a.kind = 'LINE' then
      perform plant.fail(format('%s already runs packaging order %s: one active packaging order per line (PR-35; EBMR-PLANT-123)', a.code, v_other.packaging_order));
    end if;
    if not a.segregated then
      if exists (select 1 from plant.area_occupancy_status where area_id = a.id and ended_at is null and product_code <> p_product) then
        perform plant.fail(format('%s holds open batch %s of %s: a second batch of another product is allowed only in a segregated room (IN-26 (b), PR-25; EBMR-PLANT-124)',
                                  a.code, v_other.batch_ref, v_other.product_code));
      end if;
      perform plant.fail(format('%s is in use by batch %s: release, clean and clear it first (INV-15; EBMR-PLANT-125)', a.code, v_other.batch_ref));
    end if;
  elsif v_state <> 'CLEARED_FOR_BATCH' then
    perform plant.fail(format('%s is %s%s: a batch starts only in a room or line cleared for it (IN-21, INV-15; EBMR-PLANT-126)', a.code, v_state,
                              case v_state when 'DIRTY' then ' (to be cleaned)' when 'CLEANING' then ' (cleaning not verified)'
                                           when 'CLEAN' then ' (no passed clearance)' else '' end));
  end if;
  v_req := plant.required_clearance(a.id, p_product);
  v_after := coalesce(plant.area_last_occupancy_event(a.id), '-infinity'::timestamptz);
  select * into c from plant.clearance_status x
  where x.area_id = a.id and x.result = 'PASSED' and x.performed_at > v_after
    and not exists (select 1 from plant.area_occupancy o where o.clearance_id = x.id)
    and x.next_batch = p_batch_ref and x.next_product = p_product
    and x.next_order is not distinct from nullif(btrim(p_order), '') and x.next_artwork_set is not distinct from nullif(btrim(p_artwork_set), '')
    and (x.clearance_type = v_req ->> 'type' or (v_req ->> 'type' = 'CAMPAIGN' and x.clearance_type = 'PRODUCT_CHANGE'))
  order by x.verified_at desc, x.id desc limit 1;
  if c.id is null then
    perform plant.fail(format('%s has no passed %s clearance for batch %s of %s%s recorded and verified since its last occupancy or cleaning (%s) (INV-15, PR-26, PR-34; EBMR-PLANT-127)',
                              a.code, v_req ->> 'type', p_batch_ref, p_product,
                              case when p_order is not null then format(', order %s, artwork set %s', p_order, p_artwork_set) else '' end,
                              v_req ->> 'reason'));
  end if;
  -- A product change in a room follows a MAJOR cleaning (full clearance and cleaning, outline 5.2.8).
  if v_state = 'CLEARED_FOR_BATCH' and v_req ->> 'type' = 'PRODUCT_CHANGE' then
    select * into v_clean from plant.cleaning_status where area_id = a.id and verified_at is not null order by verified_at desc, id desc limit 1;
    if v_clean.level is distinct from 'MAJOR' then
      perform plant.fail(format('%s: a product change needs a MAJOR cleaning of the area; the last one was %s (IN-26 (a); EBMR-PLANT-128)',
                                a.code, coalesce(v_clean.level, 'none')));
    end if;
  end if;
  v_prev := plant.latest_occupancy(a.id);
  insert into plant.area_occupancy (area_id, exclusive, previous_occupancy_id, batch_ref, product_code, stage, packaging_order, artwork_set,
                                    clearance_id, started_by)
  values (a.id, not a.segregated, case when not a.segregated then v_prev.id end,
          p_batch_ref, p_product, p_stage, nullif(btrim(p_order), ''), nullif(btrim(p_artwork_set), ''), c.id, plant.actor_person())
  returning id into v_id;
  if v_state = 'CLEARED_FOR_BATCH' then
    perform plant.move('area_status', 'plant_area', a.id, 'START');
  end if;
  return v_id;
end
$$;

-- Ends a batch stage or packaging order; when no batch is left the area becomes DIRTY.
create function plant.end_area_occupancy(p_occupancy uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  o     plant.area_occupancy_status;
begin
  perform iam.assert_not_administrator();
  select * into o from plant.area_occupancy_status where id = p_occupancy;
  if o.id is null then
    perform plant.fail(format('Unknown occupancy %s (EBMR-PLANT-129)', p_occupancy));
  end if;
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', o.product_code));
  perform 1 from plant.area where id = o.area_id for update;
  select * into o from plant.area_occupancy_status where id = p_occupancy;
  if o.ended_at is not null then
    perform plant.fail(format('Occupancy %s has ended (EBMR-PLANT-129)', p_occupancy));
  end if;
  insert into plant.area_occupancy_end (occupancy_id, ended_by) values (p_occupancy, plant.actor_person());
  if not exists (select 1 from plant.area_occupancy_status where area_id = o.area_id and ended_at is null) then
    perform plant.move('area_status', 'plant_area', o.area_id, 'RELEASE');
  end if;
end
$$;

grant execute on function
  plant.record_clearance(text, text, text, text, text, text), plant.verify_clearance(uuid, text, uuid),
  plant.start_area_occupancy(text, text, text, text, text, text), plant.end_area_occupancy(uuid),
  plant.required_clearance(uuid, text)
to ebmr_app;

reset role;
