-- Site services: the ERP/WMS adapter's receiving command, corrections of interface-captured receipt values and the
-- issue gate (Phase 6 slice 6a, builder A; DI-31, DI-26, PR-17 clauses 2 to 4, PR-46, INV-26; D-P6a-A-1, D-P6a-A-4,
-- D-P6a-A-10, D-P6a-A-11).
--
-- Handbook: modules/site-services.md
--
--   site.erp_wms_receive(envelope) jsonb   the ERP_WMS adapter's one receiving command (INTERFACE.WRITE through
--        platform.accept_inbound_detail, kernel 1180). The message row and the domain command that applies its payload
--        share this transaction, so a message is applied whole or not at all (DI-31). A DUPLICATE applies nothing. Per
--        message type (the contract @ebmr/integration-sdk/adapter, systems/erp-wms.ts):
--          erp.production_order -> site.erp_receive_order (the site is the adapter's; strength required)
--          erp.material_master  -> site.erp_receive_material (QA confirms a new or changed master, 0802)
--          erp.product_master   -> site.erp_receive_product
--          wms.goods_receipt    -> site.receive_supplier_batches (one lot per supplier batch, PR-17; the expiry date is
--                                  the start of that day in the site's zone, D-P6a-A-10)
--          wms.stock_move       -> site.apply_wms_stock_move (PR-46; a move against the rule: alarm and exception)
--          wms.lot_status       -> site.apply_wms_lot_status (the lot-status mirror; a late report is STALE)
--          erp.shipment         -> kept as the accepted message; distribution records are slice 6d (D-P6a-A-11)
--        A payload that does not have its type's fields is refused (EBMR-ERP-001, MALFORMED); the domain's own codes
--        classify the rest (the contract's refusalCodes).
--   site.correct_lot_receipt_value(lot, field, value, reason)  MATERIAL.HANDLE, a person with a reason: a value of a
--        receipt that came from the WMS (containers, supplierLot, manufacturerCode, deliveryNoteName) changes only here,
--        recorded in platform.inbound_override (kernel 1181) with the original kept; site.lot_receipt_effective now
--        applies the latest correction of each field and lists them (DI-31, DI-26).
--   The issue gate (trigger zz_issue_gate before insert on site.lot_reservation and site.lot_consumption): a lot is
--        reserved or consumed only with a complete receipt record (EBMR-SITE-917), an approved manufacturer
--        (EBMR-SITE-918), no open location exception (EBMR-SITE-920) and, when the site mirrors lot status from the WMS,
--        a fresh mirror (EBMR-INT-010) that holds it RELEASED (EBMR-SITE-922). Every writer goes through it.
--
-- Messages: EBMR-ERP-001, EBMR-SITE-917, EBMR-SITE-920, EBMR-SITE-922, EBMR-SITE-923.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Payload shapes (checked before any cast; the adapter checks them too, with the contract's schemas)
-- ---------------------------------------------------------------------------------------------

create function site.erp_source_value_ok(v jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_typeof(v) = 'object' and (select count(*) from jsonb_object_keys(v)) = 2
     and coalesce(v ->> 'value', '') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' and coalesce(v ->> 'unit', '') ~ '^[!-~]{1,16}$'
$$;

-- A real calendar date YYYY-MM-DD (the pattern alone lets 2027-02-30 through).
create function site.calendar_date_ok(p text) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if coalesce(p, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
    return false;
  end if;
  return to_char(p::date, 'YYYY-MM-DD') = p;
exception when others then
  return false;
end
$$;

-- NULL when the payload has the fields of its message type in their shapes, else what is wrong.
create function site.erp_payload_problem(p_type text, p jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, site, pg_temp as $$
declare
  code constant text := '^[!-~]{1,64}$';
  us   constant text := '^(0|[1-9][0-9]{0,17})$';
  x    jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then
    return 'the payload is not a JSON object';
  end if;
  case p_type
    when 'erp.production_order' then
      if coalesce(p ->> 'orderNumber', '') !~ code or coalesce(p ->> 'productCode', '') !~ code or btrim(coalesce(p ->> 'strength', '')) = ''
         or not site.erp_source_value_ok(p -> 'plannedQuantity') or coalesce(p ->> 'plannedStart', '') !~ us
         or jsonb_typeof(p -> 'bom') is distinct from 'array' or jsonb_array_length(p -> 'bom') < 1 then
        return 'a production order has orderNumber, productCode, strength, plannedQuantity {value, unit}, plannedStart and a BOM';
      end if;
      for x in select * from jsonb_array_elements(p -> 'bom') loop
        if jsonb_typeof(x) is distinct from 'object' or coalesce(x ->> 'materialCode', '') !~ code or not site.erp_source_value_ok(x -> 'quantity') then
          return 'a BOM line has materialCode and quantity {value, unit}';
        end if;
      end loop;
    when 'erp.material_master' then
      if coalesce(p ->> 'materialCode', '') !~ code or btrim(coalesce(p ->> 'name', '')) = '' or coalesce(p ->> 'baseUnit', '') !~ '^[!-~]{1,16}$'
         or coalesce(p ->> 'materialKind', '') = '' or (p ? 'maxRetestMonths' and coalesce(p ->> 'maxRetestMonths', '') !~ '^[1-9][0-9]{0,2}$') then
        return 'a material master has materialCode, name, baseUnit and materialKind (maxRetestMonths in whole months when given)';
      end if;
    when 'erp.product_master' then
      if coalesce(p ->> 'productCode', '') !~ code or btrim(coalesce(p ->> 'name', '')) = '' or btrim(coalesce(p ->> 'strength', '')) = ''
         or jsonb_typeof(p -> 'betaLactam') is distinct from 'boolean' or coalesce(p ->> 'shelfLifeMonths', '') !~ '^[1-9][0-9]{0,2}$' then
        return 'a product master has productCode, name, strength, betaLactam (true or false) and shelfLifeMonths';
      end if;
    when 'wms.goods_receipt' then
      if coalesce(p ->> 'deliveryId', '') !~ code or coalesce(p ->> 'materialCode', '') !~ code or coalesce(p ->> 'supplierCode', '') !~ code
         or coalesce(p ->> 'receivedAt', '') !~ us or jsonb_typeof(p -> 'supplierBatches') is distinct from 'array'
         or jsonb_array_length(p -> 'supplierBatches') not between 1 and 100 then
        return 'a goods receipt has deliveryId, materialCode, supplierCode, receivedAt and one to 100 supplierBatches';
      end if;
      for x in select * from jsonb_array_elements(p -> 'supplierBatches') loop
        if jsonb_typeof(x) is distinct from 'object' or coalesce(x ->> 'supplierLot', '') !~ code or coalesce(x ->> 'manufacturerCode', '') !~ code
           or coalesce(x ->> 'containers', '') !~ '^[1-9][0-9]{0,5}$' or not site.erp_source_value_ok(x -> 'quantity')
           or not site.calendar_date_ok(x ->> 'expiryDate') or (x ? 'retestDate' and x -> 'retestDate' <> 'null'::jsonb and not site.calendar_date_ok(x ->> 'retestDate')) then
          return 'a supplier batch has supplierLot, manufacturerCode, containers, quantity {value, unit} and expiryDate (a lot is received only with its expiry, PR-18)';
        end if;
      end loop;
    when 'wms.stock_move' then
      if coalesce(p ->> 'lotNumber', '') !~ code or coalesce(p ->> 'fromLocation', '') !~ code or coalesce(p ->> 'toLocation', '') !~ code
         or coalesce(p ->> 'toLocationKind', '') not in ('QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS')
         or not site.erp_source_value_ok(p -> 'quantity') or coalesce(p ->> 'movedAt', '') !~ us then
        return 'a stock move has lotNumber, fromLocation, toLocation, toLocationKind, quantity {value, unit} and movedAt';
      end if;
    when 'wms.lot_status' then
      if coalesce(p ->> 'lotNumber', '') !~ code or coalesce(p ->> 'status', '') not in ('QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED') then
        return 'a lot status has lotNumber and status QUARANTINE, RELEASED, REJECTED or BLOCKED';
      end if;
    when 'erp.shipment' then
      if coalesce(p ->> 'shipmentId', '') !~ code or coalesce(p ->> 'lotNumber', '') !~ code or not site.erp_source_value_ok(p -> 'quantity') then
        return 'a shipment has shipmentId, lotNumber and quantity {value, unit}';
      end if;
    else
      return format('message type %s is not an ERP/WMS message', coalesce(p_type, 'NULL'));
  end case;
  return null;
end
$$;

-- The start of a calendar date in the site's zone (an expiry or retest date as an instant; D-P6a-A-10).
create function site.site_date_start(p_date text) returns timestamptz
language sql stable set search_path = pg_catalog, pg_temp as $$
  select case when p_date is null then null else (p_date::date)::timestamp at time zone coalesce(kernel.site_zone(), 'UTC') end
$$;

-- ---------------------------------------------------------------------------------------------
-- The receiving command
-- ---------------------------------------------------------------------------------------------

create function site.erp_wms_receive(p_envelope jsonb) returns jsonb
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
      v_app := jsonb_build_object('kept', true);
  end case;
  return r || jsonb_build_object('applied', v_app);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Corrections of interface-captured receipt values
-- ---------------------------------------------------------------------------------------------

create or replace function site.lot_receipt_effective(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
  with c as (
    select distinct on (o.field) o.field, o.corrected_value
      from platform.inbound_override o where o.record_kind = 'lot_receipt' and o.record_id = p_lot
     order by o.field, o.corrected_at desc, o.id desc
  )
  select jsonb_build_object('lotId', r.lot_id, 'siteCode', r.site_code, 'deliveryId', r.delivery_id,
                            'deliveryNoteName', coalesce((select c.corrected_value from c where c.field = 'deliveryNoteName'), r.delivery_note_name),
                            'supplierCode', r.supplier_code,
                            'supplierLot', coalesce((select c.corrected_value from c where c.field = 'supplierLot'), r.supplier_lot),
                            'manufacturerCode', coalesce((select c.corrected_value from c where c.field = 'manufacturerCode'), r.manufacturer_code),
                            'containers', coalesce((select c.corrected_value from c where c.field = 'containers'), r.containers::text),
                            'receivedValue', r.received_value, 'receivedUnit', r.received_unit, 'remarks', r.remarks,
                            'manufacturerApprovedAtReceipt', r.manufacturer_approved, 'source', r.source, 'inboundMessageId', r.inbound_message_id,
                            'corrections', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'field', o.field, 'originalValue', o.original_value,
                                                                                         'correctedValue', o.corrected_value, 'reason', o.reason,
                                                                                         'correctedBy', o.corrected_by_person,
                                                                                         'correctedAtUs', platform.timestamptz_to_epoch_us(o.corrected_at))
                                                                      order by o.corrected_at, o.id)
                                                       from platform.inbound_override o where o.record_kind = 'lot_receipt' and o.record_id = p_lot), '[]'::jsonb))
    from site.lot_receipt r where r.lot_id = p_lot
$$;

create function site.correct_lot_receipt_value(p_lot uuid, p_field text, p_value text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  l      site.material_lot;
  r      site.lot_receipt;
  v_now  jsonb;
begin
  perform site.require_actor();
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  select * into r from site.lot_receipt where lot_id = l.id;
  if not found or r.source <> 'INTERFACE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-923 lot %s has no receipt captured from the WMS; only an interface-captured value is corrected here (DI-31)', l.lot_code);
  end if;
  if p_field is null or p_field not in ('containers', 'supplierLot', 'manufacturerCode', 'deliveryNoteName') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-923 %s is not a correctable receipt value (containers, supplierLot, manufacturerCode, deliveryNoteName)', coalesce(p_field, 'NULL'));
  end if;
  if (p_field = 'containers' and coalesce(p_value, '') !~ '^[1-9][0-9]{0,5}$')
     or (p_field in ('supplierLot', 'manufacturerCode') and coalesce(p_value, '') !~ '^[!-~]{1,64}$')
     or (p_field = 'deliveryNoteName' and (btrim(coalesce(p_value, '')) = '' or length(p_value) > 500)) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-923 %s is not a valid %s', coalesce(p_value, 'NULL'), p_field);
  end if;
  v_now := site.lot_receipt_effective(l.id);
  return platform.record_inbound_override(r.inbound_message_id, 'lot_receipt', l.id, p_field, v_now ->> p_field, null, p_value, null, p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The issue gate
-- ---------------------------------------------------------------------------------------------

create function site.issue_gate_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob text;
  v_exc  site.lot_location_exception;
begin
  v_prob := site.receipt_problem(p_lot);
  if v_prob is not null then
    return 'EBMR-SITE-917 ' || v_prob;
  end if;
  v_prob := site.manufacturer_problem(p_lot);
  if v_prob is not null then
    return 'EBMR-SITE-918 ' || v_prob;
  end if;
  v_exc := site.lot_open_location_exception(p_lot);
  if v_exc.id is not null then
    return format('EBMR-SITE-920 the lot is blocked by an open location exception (%s); QA closes it with a deviation first (PR-46, D-P6a-7)', v_exc.problem);
  end if;
  v_prob := site.erp_lot_status_problem(p_lot);
  if v_prob is not null then
    return 'EBMR-SITE-922 ' || v_prob;
  end if;
  return null;
end
$$;

create function site.issue_gate() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob text := site.issue_gate_problem(new.lot_id);
begin
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = v_prob;
  end if;
  return new;
end
$$;

create trigger zz_issue_gate before insert on site.lot_reservation for each row execute function site.issue_gate();
create trigger zz_issue_gate before insert on site.lot_consumption for each row execute function site.issue_gate();

grant execute on function site.erp_wms_receive(jsonb), site.erp_payload_problem(text, jsonb), site.correct_lot_receipt_value(uuid, text, text, text),
                          site.issue_gate_problem(uuid)
  to ebmr_app;

reset role;
