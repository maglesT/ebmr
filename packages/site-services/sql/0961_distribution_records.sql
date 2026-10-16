-- Site services: distribution records from the ERP/WMS adapter (Phase 6 slice 6d; controls PR-57, IN-07, IN-29; plan
-- "Slice 6d" (distribution records, PR-57); defaults D-P6d-0-6 and D-P6d-0-7 in docs/build-plan/phase-6/slice-6d-0-interfaces.md).
--
-- Handbook: modules/site-services.md
--
--   site.erp_shipment gains the distribution-record fields (new columns; 0870 is not edited): the consignee's address, the
--       shipping date, the lot number, the product name, strength and dosage form, and the inbound message a row came
--       from. The product fields and the lot number are never typed: a trigger (a0_distribution_fields, before 0870's
--       interlock) takes them from the lot and its finished-lot row, and the dosage form from the batch's master through
--       recipe-core's resolver (site.lot_dosage_form; NULL until recipe-core is installed). A row the ERP/WMS adapter writes
--       carries the address and the shipping date (check erp_shipment_distribution_complete); a row from the Phase 4 ERP
--       stub route (site.erp_record_shipment) may lack the address and its shipping date is the recording time; the
--       genealogy and the mock recall list such a record as incomplete (D-P6d-0-7).
--   site.erp_apply_shipment(payload, message, envelope) jsonb   (owner only) the adapter's erp.shipment: the finished lot
--       of this site by its lot number, the market (the payload's, or the lot's only market), quarantine (false unless
--       the payload says so), and the row inserted through the interlock (INV-42) in the receiving command's transaction
--       (DI-31). Refusals: EBMR-ERP-020 malformed shipment (MALFORMED); -021 no finished lot of this site has the number
--       (WRONG_IDENTITY); -022 a shipping date in the future (OUT_OF_RANGE); EBMR-SHP-003 the shipment number is recorded
--       already (DUPLICATE); the interlock's EBMR-SHP-002 and -004 (OUT_OF_RANGE).
--   site.erp_wms_receive (re-created from 0916): erp.shipment now applies the shipment (6a kept the message only,
--       D-P6a-A-11); every other message type as 0916.
--
-- Messages: EBMR-ERP-020 to EBMR-ERP-022.

set local role ebmr_owner;

alter table site.erp_shipment
  add column consignee_address  text check (consignee_address is null or (btrim(consignee_address) <> '' and length(consignee_address) <= 500)),
  add column shipped_at         timestamptz,
  add column lot_code           text,
  add column product_name       text,
  add column strength           text,
  add column dosage_form        text,
  add column inbound_message_id uuid unique references platform.inbound_message (id),
  add constraint erp_shipment_distribution_complete
    check (inbound_message_id is null or (consignee_address is not null and shipped_at is not null));

-- The dosage form of a lot's batch, from recipe-core's resolver, or NULL when recipe-core is not installed.
create function site.lot_dosage_form(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v text;
begin
  if to_regprocedure('recipe.lot_dosage_form(uuid)') is null then
    return null;
  end if;
  execute 'select recipe.lot_dosage_form($1)' into v using p_lot;
  return v;
end
$$;

-- Every row, whoever writes it: the lot number and the product fields come from the lot, never from the writer.
create function site.erp_shipment_distribution_fields() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l site.material_lot;
  f site.finished_lot;
begin
  select * into l from site.material_lot where id = new.lot_id;
  select * into f from site.finished_lot where lot_id = new.lot_id;
  new.lot_code := l.lot_code;
  new.product_name := l.material_name;
  new.strength := f.strength;
  new.dosage_form := site.lot_dosage_form(new.lot_id);
  new.shipped_at := coalesce(new.shipped_at, clock_timestamp());
  return new;
end
$$;
revoke all on function site.erp_shipment_distribution_fields() from public;
create trigger a0_distribution_fields before insert on site.erp_shipment for each row execute function site.erp_shipment_distribution_fields();

create function site.erp_apply_shipment(p jsonb, p_message uuid, p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_ctx     jsonb := site.require_actor();
  l         site.material_lot;
  f         site.finished_lot;
  v_market  text;
  v_shipped timestamptz;
  v_id      uuid;
begin
  if coalesce(p ->> 'shipmentId', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$' or coalesce(p ->> 'lotNumber', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'
     or coalesce(p ->> 'consigneeCode', '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$'
     or btrim(coalesce(p ->> 'consigneeName', '')) = '' or length(p ->> 'consigneeName') > 200
     or btrim(coalesce(p ->> 'consigneeAddress', '')) = '' or length(p ->> 'consigneeAddress') > 500
     or not site.erp_source_value_ok(p -> 'quantity') or (p -> 'quantity' ->> 'value')::numeric <= 0
     or coalesce(p ->> 'shippedAt', '') !~ '^(0|[1-9][0-9]{0,18})$'
     or (p ? 'market' and coalesce(p ->> 'market', '') not in ('IN', 'US', 'EU'))
     or (p ? 'quarantine' and jsonb_typeof(p -> 'quarantine') is distinct from 'boolean') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ERP-020 a shipment names its number, the lot number, the consignee''s code (capitals, digits and hyphens), name and address, a positive quantity {value, unit} and the shipping time; a market is IN, US or EU (PR-57)';
  end if;
  select * into l from site.material_lot where site_code = site.actor_site() and lot_code = p ->> 'lotNumber';
  select * into f from site.finished_lot where lot_id = l.id;
  if f.lot_id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-021 no finished lot of site %s has the number %s; a shipment names a finished lot of this site (PR-57)', site.actor_site(), p ->> 'lotNumber');
  end if;
  v_market := p ->> 'market';
  if v_market is null then
    if cardinality(f.markets) <> 1 then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ERP-020 lot %s is made for the markets %s; the shipment names its market (PR-57)', l.lot_code, array_to_string(f.markets, ', '));
    end if;
    v_market := f.markets[1];
  end if;
  v_shipped := platform.epoch_us_to_timestamptz(p ->> 'shippedAt');
  if v_shipped > clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = 'P0001', message = format('EBMR-ERP-022 shipment %s is dated in the future; a distribution record states when the goods left (PR-57)', p ->> 'shipmentId');
  end if;
  if exists (select 1 from site.erp_shipment s where s.shipment_no = p ->> 'shipmentId') then
    raise exception using errcode = 'P0001', message = format('EBMR-SHP-003 shipment %s is already recorded', p ->> 'shipmentId');
  end if;
  insert into site.erp_shipment (shipment_no, lot_id, market, consignee_code, consignee_name, consignee_address, quantity, unit, quarantine, manufacturer_state,
                                 disposition_state, erp_reference, shipped_at, inbound_message_id, recorded_by_person, recorded_by_account, correlation_id)
  values (p ->> 'shipmentId', l.id, v_market, p ->> 'consigneeCode', btrim(p ->> 'consigneeName'), btrim(p ->> 'consigneeAddress'),
          (p -> 'quantity' ->> 'value')::numeric, p -> 'quantity' ->> 'unit', coalesce((p ->> 'quarantine')::boolean, false), 'PENDING', 'PENDING',
          left(coalesce(p_envelope ->> 'sourceRecordId', p ->> 'shipmentId'), 64), v_shipped, p_message,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('shipmentId', v_id, 'shipmentNo', p ->> 'shipmentId', 'lotId', l.id, 'market', v_market);
end
$$;
revoke all on function site.erp_apply_shipment(jsonb, uuid, jsonb) from public;

-- As 0916; erp.shipment applies the shipment (header).
create or replace function site.erp_wms_receive(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  r       jsonb;
  v_msg   uuid;
  v_type  text := p_envelope ->> 'messageType';
  p       jsonb := p_envelope -> 'payload';
  v_prob  text;
  v_app   jsonb;
  v_ts    timestamptz;
begin
  perform platform.require_actor();
  perform platform.authorize('interface.write', 'integration_adapter', (iam.current_integration_adapter()).code);
  r := platform.accept_inbound_detail(p_envelope);
  if r ->> 'outcome' <> 'ACCEPTED' then
    return r || jsonb_build_object('applied', null);
  end if;
  v_msg := (r ->> 'messageId')::uuid;
  v_prob := site.erp_payload_problem(v_type, p);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-ERP-001 malformed %s payload: %s (DI-31)', v_type, v_prob);
  end if;
  v_ts := platform.epoch_us_to_timestamptz(p_envelope ->> 'sourceTimestamp');
  case v_type
    when 'erp.production_order' then
      v_app := jsonb_build_object('orderId', site.erp_receive_order(jsonb_build_object(
        'orderNo', p ->> 'orderNumber', 'siteCode', site.actor_site(), 'productCode', p ->> 'productCode', 'strength', p ->> 'strength',
        'batchSize', p -> 'plannedQuantity' ->> 'value', 'batchSizeUnit', p -> 'plannedQuantity' ->> 'unit',
        'bom', (select jsonb_agg(jsonb_build_object('materialCode', b ->> 'materialCode', 'quantity', b -> 'quantity' ->> 'value', 'unit', b -> 'quantity' ->> 'unit') order by o)
                  from jsonb_array_elements(p -> 'bom') with ordinality x(b, o)),
        'erpReference', p_envelope ->> 'sourceRecordId')));
    when 'erp.material_master' then
      v_app := jsonb_build_object('versionId', site.erp_receive_material(jsonb_strip_nulls(jsonb_build_object(
        'materialCode', p ->> 'materialCode', 'materialName', p ->> 'name', 'materialKind', p ->> 'materialKind', 'unit', p ->> 'baseUnit',
        'maxRetestMonths', p -> 'maxRetestMonths', 'erpReference', p_envelope ->> 'sourceRecordId'))));
    when 'erp.product_master' then
      v_app := jsonb_build_object('versionId', site.erp_receive_product(jsonb_strip_nulls(jsonb_build_object(
        'productCode', p ->> 'productCode', 'strength', p ->> 'strength', 'productName', p ->> 'name', 'betaLactam', p -> 'betaLactam',
        'shelfLifeMonths', p ->> 'shelfLifeMonths', 'reprocessingPermitted', p -> 'reprocessingPermitted', 'erpReference', p_envelope ->> 'sourceRecordId'))));
    when 'wms.goods_receipt' then
      v_app := site.receive_supplier_batches(jsonb_build_object(
        'deliveryId', p ->> 'deliveryId', 'materialCode', p ->> 'materialCode', 'supplierCode', p ->> 'supplierCode',
        'deliveryNoteName', p ->> 'deliveryNoteName',
        'batches', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'supplierLot', b ->> 'supplierLot', 'manufacturerCode', b ->> 'manufacturerCode', 'containers', b ->> 'containers',
                      'value', b -> 'quantity' ->> 'value', 'unit', b -> 'quantity' ->> 'unit',
                      'expiresAt', to_char(site.site_date_start(b ->> 'expiryDate') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                      'retestAt', to_char(site.site_date_start(b ->> 'retestDate') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) order by o)
                      from jsonb_array_elements(p -> 'supplierBatches') with ordinality x(b, o))),
        v_msg, 'INTERFACE');
    when 'wms.stock_move' then
      v_app := site.apply_wms_stock_move(p, v_msg);
    when 'wms.lot_status' then
      v_app := site.apply_wms_lot_status(p, v_msg, v_ts);
    when 'erp.shipment' then
      v_app := site.erp_apply_shipment(p, v_msg, p_envelope);
  end case;
  return r || jsonb_build_object('applied', v_app);
end
$$;

revoke all on function site.erp_wms_receive(jsonb) from public;
grant execute on function site.erp_wms_receive(jsonb), site.lot_dosage_form(uuid) to ebmr_app;

reset role;
