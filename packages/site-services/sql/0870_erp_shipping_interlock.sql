-- Site services: the ERP shipping interlock (Phase 4 slice 4b; INV-42, IN-05 (a), DI-39 quarantine interlock; outline 4.6
-- ERP / WMS "Shipping rule", 5.2.6, 5.2.9; plan docs/build-plan/phase-4/phase-4-plan.md slice 4b).
--
-- The ERP stub asks before it ships (site.shipment_problems, read) and records the shipment through
-- site.erp_record_shipment (INTERFACE.WRITE, role ERP_INTERFACE). A trigger on site.erp_shipment evaluates the interlock
-- again for every row, whoever writes it, under the locks of the lot (site.lock_lot) and of its evidence epochs (the LOT
-- epoch and each release batch's BATCH epoch: a deviation link, a lot status change or any other release evidence bumps
-- them, so a concurrent link either commits first and is seen, or waits for the shipment). A shipment is refused when:
--   * the lot is no finished lot, or the market (IN, US, EU) is not in the lot's market set now (recipe.market_set);
--   * the lot has no current manufacturer release: recipe.manufacturer_release_state is not RELEASED, or the lot is not
--     RELEASED in the lot register (a suspended, held, recalled or rejected lot never ships);
--   * a post-release link is open: a deviation linked to the lot or to a batch of its evidence set at or after the
--     manufacturer release that is neither CLOSED nor CANCELLED, or CLOSED with a CONFIRMED impact (D-2a-9); or a
--     disposition blocker of the kernel (an unassessed incident, a DI investigation, a hold) on the lot or a batch placed
--     at or after the release;
--   * US: the US disposition (recipe.disposition_state) is not RELEASED;
--   * EU: the EU disposition is neither AWAITING_QP_CERTIFICATION nor CERTIFIED; the consignee is not the EU importer the
--     technical agreement names for the product (recipe.eu_importer_of); or, before CERTIFIED, the goods are not shipped
--     as quarantined goods (D-4b-3: after certification the importer may receive them as released goods; the ERP never
--     sets the EU saleable status);
--   * the unit is not the lot's, or the quantity is not positive or exceeds what is left of the lot after earlier
--     shipments.
-- The release model is recipe-core's, found when the interlock runs (site services apply before recipe-core: the pattern
-- of site.guard_manufacturer_decision, 0860); without it the interlock refuses (fails closed).
--
--   site.erp_shipment            insert-only, audited (aggregate erp_shipment, keyed by the lot): what shipped, to whom,
--                                for which market, in quarantine or not, and the states the interlock saw.
--   site.shipment_problems(lot, market, consignee, quarantine, quantity, unit) text[]   the ERP's question; empty = allowed.
--   site.erp_record_shipment(p jsonb) uuid   INTERFACE.WRITE.
-- Messages: EBMR-SHP-001 to EBMR-SHP-019.

set local role ebmr_owner;

create table site.erp_shipment (
  id                   uuid primary key default gen_random_uuid(),
  shipment_no          text not null unique check (shipment_no ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  lot_id               uuid not null references site.material_lot (id),
  market               text not null check (market in ('IN', 'US', 'EU')),
  consignee_code       text not null check (consignee_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  consignee_name       text not null check (btrim(consignee_name) <> '' and length(consignee_name) <= 200),
  quantity             numeric not null check (quantity > 0),
  unit                 text not null check (unit ~ '^[!-~]{1,32}$'),
  quarantine           boolean not null,
  eu_importer_id       uuid,
  manufacturer_state   text not null,
  disposition_state    text not null,
  erp_reference        text not null check (btrim(erp_reference) <> '' and length(erp_reference) <= 64),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  correlation_id       uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  check (market <> 'EU' or eu_importer_id is not null)
);
create index erp_shipment_lot on site.erp_shipment (lot_id);
revoke all on site.erp_shipment from public;
grant select on site.erp_shipment to ebmr_app;

select platform.enforce_db_time('site.erp_shipment', array['recorded_at']);
select kernel.register_audited_table('site.erp_shipment', 'erp_shipment', 'lot_id', true);

-- recipe-core's text answer for the lot (and market), or NULL when the release model is not installed.
create function site.release_model_text(p_function text, p_lot uuid, p_market text) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v text;
begin
  if p_function not in ('manufacturer_release_state', 'disposition_state') then
    raise exception using errcode = 'P0001', message = format('EBMR-SHP-001 %s is not a release-model read', p_function);
  end if;
  if p_function = 'manufacturer_release_state' then
    if to_regprocedure('recipe.manufacturer_release_state(uuid)') is null then
      return null;
    end if;
    execute 'select recipe.manufacturer_release_state($1)' into v using p_lot;
  else
    if to_regprocedure('recipe.disposition_state(uuid, text)') is null then
      return null;
    end if;
    execute 'select recipe.disposition_state($1, $2)' into v using p_lot, p_market;
  end if;
  return v;
end
$$;

-- Why the lot may not ship now to this consignee for this market; empty when it may (INV-42).
create function site.shipment_problems(p_lot uuid, p_market text, p_consignee text, p_quarantine boolean, p_quantity numeric, p_unit text)
returns text[]
language plpgsql stable security definer set search_path = pg_catalog, site, records, pg_temp as $$
declare
  f          site.finished_lot;
  l          site.material_lot;
  v_out      text[] := '{}';
  v_markets  text[];
  v_mfr      text;
  v_state    text;
  v_disp     text;
  v_released timestamptz;
  v_batches  uuid[] := '{}';
  v_importer jsonb;
  v_left     numeric;
  b          uuid;
  d          record;
  x          record;
begin
  select * into f from site.finished_lot where lot_id = p_lot;
  if f.lot_id is null then
    return array[format('%s is no finished lot', coalesce(p_lot::text, 'NULL'))];
  end if;
  select * into l from site.material_lot where id = p_lot;
  if to_regprocedure('recipe.market_set(text, uuid)') is null or to_regprocedure('recipe.manufacturer_decision(uuid)') is null
     or to_regprocedure('recipe.release_batches(uuid)') is null or to_regprocedure('recipe.eu_importer_of(uuid)') is null then
    return array['the release model is not installed: nothing ships (INV-42)'];
  end if;
  if p_market is null or p_market not in ('IN', 'US', 'EU') then
    return array[format('%s is not a market (IN, US or EU)', coalesce(p_market, 'NULL'))];
  end if;
  execute 'select recipe.market_set(''LOT'', $1)' into v_markets using p_lot;
  if not (p_market = any (coalesce(v_markets, '{}'))) then
    v_out := v_out || format('market %s is not in the market set of lot %s (%s)', p_market, l.lot_code, array_to_string(coalesce(v_markets, '{}'), ', '));
  end if;

  -- A current manufacturer release (IN-05 (a)): RELEASED in the release model and in the lot register.
  v_mfr := site.release_model_text('manufacturer_release_state', p_lot, null);
  v_state := site.lot_state(p_lot);
  if v_mfr is distinct from 'RELEASED' or v_state is distinct from 'RELEASED' then
    v_out := v_out || format('lot %s has no current manufacturer release (release %s, lot %s): nothing ships before the AP''s release or while it is not current (INV-42, IN-05 (a))',
                             l.lot_code, coalesce(v_mfr, 'none'), coalesce(v_state, 'none'));
  end if;

  -- Open post-release links (INV-42).
  execute 'select (recipe.manufacturer_decision($1)).recorded_at' into v_released using p_lot;
  if v_released is not null then
    execute 'select recipe.release_batches($1)' into v_batches using p_lot;
    v_batches := coalesce(v_batches, '{}');
    for d in select distinct y.deviation_id, x2.ref, site.deviation_state(y.deviation_id) as st
               from site.deviation_link y join site.deviation x2 on x2.id = y.deviation_id
              where ((y.subject_kind = 'LOT' and y.subject_id = p_lot) or y.batch_id = any (v_batches) or (y.subject_kind = 'BATCH' and y.subject_id = any (v_batches)))
                and y.linked_at >= v_released
              order by 2 loop
      if d.st not in ('CLOSED', 'CANCELLED') then
        v_out := v_out || format('deviation %s was linked after the release and is %s: an open post-release link (INV-42)', d.ref, d.st);
      elsif d.st = 'CLOSED' and exists (
              select 1 from site.deviation_link y join site.deviation_impact i on i.link_id = y.id
               where y.deviation_id = d.deviation_id and i.impact = 'CONFIRMED'
                 and ((y.subject_kind = 'LOT' and y.subject_id = p_lot) or y.batch_id = any (v_batches))) then
        v_out := v_out || format('deviation %s, linked after the release, was closed with a CONFIRMED impact (D-2a-9, INV-42)', d.ref);
      end if;
    end loop;
    for x in select 'lot ' || l.lot_code as subject, o.* from records.open_blockers('material_lot', p_lot::text) o
             union all
             select 'batch ' || bb::text, o.* from unnest(v_batches) bb, records.open_blockers('batch', bb::text) o loop
      if x.blocks_disposition and x.since >= v_released then
        v_out := v_out || format('%s %s on %s was opened after the release: an open post-release link (INV-42)', lower(x.blocker_kind), x.reference, x.subject);
      end if;
    end loop;
  end if;

  -- The market's own disposition.
  v_disp := case when p_market = 'IN' then v_mfr else site.release_model_text('disposition_state', p_lot, p_market) end;
  if p_market = 'US' and v_disp is distinct from 'RELEASED' then
    v_out := v_out || format('the US disposition of lot %s is %s: a US consignee receives it only after the quality unit released it (INV-42)', l.lot_code, coalesce(v_disp, 'none'));
  elsif p_market = 'EU' then
    if v_disp is null or v_disp not in ('AWAITING_QP_CERTIFICATION', 'CERTIFIED') then
      v_out := v_out || format('the EU disposition of lot %s is %s: it ships to the EU only awaiting QP certification or certified (INV-42)', l.lot_code, coalesce(v_disp, 'none'));
    end if;
    execute 'select recipe.eu_importer_of($1)' into v_importer using p_lot;
    if v_importer is null then
      v_out := v_out || format('no EU importer is named for product %s: an EU lot ships only to the importer of the technical agreement (INV-42)', f.product_code);
    elsif p_consignee is distinct from v_importer ->> 'code' then
      v_out := v_out || format('consignee %s is not the EU importer %s named in the technical agreement (INV-42)', coalesce(p_consignee, 'none'), v_importer ->> 'code');
    end if;
    if v_disp is distinct from 'CERTIFIED' and p_quarantine is not true then
      v_out := v_out || 'until the QP certifies it, an EU lot ships only as quarantined goods (INV-42, DI-39)';
    end if;
  end if;

  -- Quantity.
  if p_quantity is null or p_quantity <= 0 or p_unit is distinct from l.unit then
    v_out := v_out || format('a shipment is a positive quantity in the lot''s unit %s', l.unit);
  else
    v_left := l.received_quantity - coalesce((select sum(s.quantity) from site.erp_shipment s where s.lot_id = p_lot), 0);
    if p_quantity > v_left then
      v_out := v_out || format('lot %s has %s %s left to ship, not %s', l.lot_code, v_left, l.unit, p_quantity);
    end if;
  end if;
  return v_out;
end
$$;

-- Every row of site.erp_shipment, whoever writes it: the interlock under the lot and epoch locks; the states seen are
-- stamped on the row (the row never states its own).
create function site.erp_shipment_interlock() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob     text[];
  v_batches  uuid[];
  b          uuid;
  v_importer jsonb;
begin
  perform site.lock_lot(new.lot_id);
  if to_regprocedure('recipe.lock_epoch(text, uuid)') is not null and to_regprocedure('recipe.release_batches(uuid)') is not null then
    execute 'select recipe.lock_epoch(''LOT'', $1)' using new.lot_id;
    execute 'select recipe.release_batches($1)' into v_batches using new.lot_id;
    foreach b in array coalesce(v_batches, '{}') loop
      execute 'select recipe.lock_epoch(''BATCH'', $1)' using b;
    end loop;
  end if;
  v_prob := site.shipment_problems(new.lot_id, new.market, new.consignee_code, new.quarantine, new.quantity, new.unit);
  if cardinality(v_prob) > 0 then
    raise exception using errcode = 'P0001', message = format('EBMR-SHP-002 shipment %s refused: %s', new.shipment_no, array_to_string(v_prob, '; '));
  end if;
  new.manufacturer_state := site.release_model_text('manufacturer_release_state', new.lot_id, null);
  new.disposition_state := case when new.market = 'IN' then new.manufacturer_state else site.release_model_text('disposition_state', new.lot_id, new.market) end;
  if new.market = 'EU' then
    execute 'select recipe.eu_importer_of($1)' into v_importer using new.lot_id;
    new.eu_importer_id := (v_importer ->> 'importer_id')::uuid;
  else
    new.eu_importer_id := null;
  end if;
  return new;
end
$$;
create trigger a1_interlock before insert on site.erp_shipment for each row execute function site.erp_shipment_interlock();

-- p: {shipmentNo, lotId, market, consigneeCode, consigneeName, quantity (decimal text), unit, quarantine, erpReference}
create function site.erp_record_shipment(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'shipmentNo', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'
     or coalesce(p ->> 'lotId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p ->> 'market', '') not in ('IN', 'US', 'EU') or coalesce(p ->> 'consigneeCode', '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$'
     or btrim(coalesce(p ->> 'consigneeName', '')) = '' or jsonb_typeof(p -> 'quantity') is distinct from 'string'
     or (p ->> 'quantity') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$' or coalesce(p ->> 'unit', '') !~ '^[!-~]{1,32}$'
     or jsonb_typeof(p -> 'quarantine') is distinct from 'boolean' or btrim(coalesce(p ->> 'erpReference', '')) = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SHP-001 a shipment names its number, lot, market (IN, US or EU), consignee code and name, quantity (decimal text) and unit, whether it is quarantined, and the ERP reference';
  end if;
  if exists (select 1 from site.erp_shipment s where s.shipment_no = p ->> 'shipmentNo') then
    raise exception using errcode = 'P0001', message = format('EBMR-SHP-003 shipment %s is already recorded', p ->> 'shipmentNo');
  end if;
  insert into site.erp_shipment (shipment_no, lot_id, market, consignee_code, consignee_name, quantity, unit, quarantine, manufacturer_state,
                                 disposition_state, erp_reference, recorded_by_person, recorded_by_account, correlation_id)
  values (p ->> 'shipmentNo', (p ->> 'lotId')::uuid, p ->> 'market', p ->> 'consigneeCode', btrim(p ->> 'consigneeName'), (p ->> 'quantity')::numeric,
          p ->> 'unit', (p ->> 'quarantine')::boolean, 'PENDING', 'PENDING', btrim(p ->> 'erpReference'),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function site.release_model_text(text, uuid, text), site.shipment_problems(uuid, text, text, boolean, numeric, text),
  site.erp_shipment_interlock(), site.erp_record_shipment(jsonb) from public;
grant execute on function site.shipment_problems(uuid, text, text, boolean, numeric, text), site.erp_record_shipment(jsonb) to ebmr_app;

reset role;
