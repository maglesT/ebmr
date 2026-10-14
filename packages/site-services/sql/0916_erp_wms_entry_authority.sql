-- Site services: the ERP/WMS adapter's app-callable functions check their permission where they are entered (Phase 6
-- slice 6a, review fix; DI-17, DI-31; defect P6a-R1).
--
-- Handbook: modules/site-services.md
--
--   The five functions the ERP_WMS adapter calls (site.erp_outbound_pending, site.erp_outbound_delivered,
--   site.erp_outbound_failed, site.erp_wms_receive, site.wms_location_question) were gated only inside a helper
--   (site.require_erp_wms_adapter, 0912) or inside the kernel's inbound framework, so the DI-17 scan of app-callable
--   writers could not see the gate. Each now calls platform.authorize('interface.write', ...) itself, as the kernel's
--   inbound functions do (1180); the helper still checks that the adapter speaks for ERP_WMS. Refusals are unchanged
--   (the explicit check runs after, or is the same as, the one that refused before).
--   site.location_move_problem (0911) writes nothing: it is declared STABLE, as the other *_problem reads are.
--   Bodies otherwise as 0911, 0912, 0913 and 0915.

set local role ebmr_owner;

create or replace function site.erp_outbound_pending(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_ad iam.integration_adapter := site.require_erp_wms_adapter();
begin
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'EBMR-ERP-011 the delivery limit is between 1 and 1000';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('messageId', m.id, 'topic', m.topic, 'lotId', m.lot_id, 'payload', m.payload,
                                        'attempts', (select count(*) from site.erp_outbound_attempt a where a.message_id = m.id)::text,
                                        'createdAtUs', platform.timestamptz_to_epoch_us(m.created_at)) order by m.created_at, m.id)
      from (select * from site.erp_outbound_message m
             where not exists (select 1 from site.erp_outbound_delivery d where d.message_id = m.id)
             order by m.created_at, m.id limit p_limit) m), '[]'::jsonb);
end
$$;

create or replace function site.erp_outbound_delivered(p_message uuid, p_erp_reference text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_ad   iam.integration_adapter := site.require_erp_wms_adapter();
  m      site.erp_outbound_message;
  v_done integer;
begin
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  select * into m from site.erp_outbound_message where id = p_message;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ERP-011 there is no outbound message %s', coalesce(p_message::text, 'NULL'));
  end if;
  if coalesce(p_erp_reference, '') !~ '^[!-~]{1,128}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-ERP-011 a delivery names the ERP''s reference for the message';
  end if;
  insert into site.erp_outbound_delivery (message_id, adapter_id, adapter_code, topic, lot_id, erp_reference)
  values (m.id, v_ad.id, v_ad.code, m.topic, m.lot_id, p_erp_reference)
  on conflict (message_id) do nothing;
  get diagnostics v_done = row_count;
  if v_done = 1 and m.topic = 'erp.stock_block' then
    perform 1 from site.material_lot where id = m.lot_id for update;
    insert into site.erp_stock_block_delivery (request_id, lot_id, kind, delivered_by_person, delivered_by_account)
    select r.id, r.lot_id, r.kind, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid
      from site.erp_stock_block_request r where r.id = (m.payload ->> 'requestId')::uuid
    on conflict (request_id) do nothing;
  end if;
  return v_done = 1;
end
$$;

create or replace function site.erp_outbound_failed(p_message uuid, p_error text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  v_ad    iam.integration_adapter := site.require_erp_wms_adapter();
  m       site.erp_outbound_message;
  v_no    integer;
  v_alarm uuid;
begin
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  select * into m from site.erp_outbound_message where id = p_message for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ERP-011 there is no outbound message %s', coalesce(p_message::text, 'NULL'));
  end if;
  if btrim(coalesce(p_error, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ERP-011 a failed delivery is recorded with its error';
  end if;
  if exists (select 1 from site.erp_outbound_delivery d where d.message_id = m.id) then
    return 0;
  end if;
  select coalesce(max(attempt_no), 0) + 1 into v_no from site.erp_outbound_attempt where message_id = m.id;
  if v_no = 1 then
    v_alarm := platform.raise_integration_alarm(v_ad, 'TRANSPORT', 'MINOR', null,
      jsonb_build_object('direction', 'OUTBOUND', 'messageId', m.id, 'topic', m.topic, 'error', left(p_error, 500)));
  end if;
  insert into site.erp_outbound_attempt (message_id, attempt_no, error, alarm_id) values (m.id, v_no, left(p_error, 2000), v_alarm);
  return v_no;
end
$$;

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
      v_app := jsonb_build_object('kept', true);
  end case;
  return r || jsonb_build_object('applied', v_app);
end
$$;

create or replace function site.wms_location_question(p_lot_code text, p_location_kind text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_site text;
  v_lot  uuid;
  v_ad   iam.integration_adapter := site.require_erp_wms_adapter();
begin
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  v_site := site.actor_site();
  select l.id into v_lot from site.material_lot l where l.site_code = v_site and l.lot_code = p_lot_code;
  if v_lot is null then
    return format('the eBMR holds no lot %s at site %s (PR-46)', coalesce(p_lot_code, 'NULL'), v_site);
  end if;
  if p_location_kind is null or p_location_kind not in ('QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS') then
    return format('%s is not a location kind the eBMR knows (QUARANTINE, RELEASED, REJECTED, PRODUCTION, RETURNS) (PR-46)', coalesce(p_location_kind, 'NULL'));
  end if;
  return site.location_move_problem(v_lot, p_location_kind);
end
$$;

create or replace function site.location_move_problem(p_lot uuid, p_location_kind text) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l        site.material_lot;
  v_state  text;
  v_dates  text;
  v_allow  text[];
  v_exc    site.lot_location_exception;
begin
  if p_location_kind is null or p_location_kind not in ('QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-919 %s is not a location kind (QUARANTINE, RELEASED, REJECTED, PRODUCTION, RETURNS)', coalesce(p_location_kind, 'NULL'));
  end if;
  select * into l from site.material_lot where id = p_lot;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-919 unknown lot %s', p_lot);
  end if;
  v_state := site.lot_state(l.id);
  v_dates := site.lot_dates_problem(l);
  v_allow := case
    when v_state in ('RELEASED', 'RELEASED_FOR_FURTHER_PROCESSING') and v_dates is null then array['QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS']
    when v_state in ('QUARANTINE', 'ON_HOLD', 'RELEASED', 'RELEASED_FOR_FURTHER_PROCESSING') then array['QUARANTINE', 'REJECTED', 'RETURNS']
    when v_state in ('REJECTED', 'RECALLED') then array['REJECTED', 'RETURNS']
    else array[]::text[] end;
  v_exc := site.lot_open_location_exception(l.id);
  if v_exc.id is not null and p_location_kind not in ('QUARANTINE', 'REJECTED', 'RETURNS') then
    return format('lot %s is blocked by an open location exception (%s) until QA closes it with a deviation (PR-46)', l.lot_code, v_exc.problem);
  end if;
  if p_location_kind = any (v_allow) then
    return null;
  end if;
  if cardinality(v_allow) = 0 then
    return format('lot %s is %s: it has no stock to move (PR-46)', l.lot_code, v_state);
  end if;
  return format('lot %s is %s%s: it may go only to a %s location, not to %s (PR-46)', l.lot_code, v_state,
                case when v_dates is not null and v_state in ('RELEASED', 'RELEASED_FOR_FURTHER_PROCESSING') then ' but ' || v_dates else '' end,
                array_to_string(v_allow, ', ', ''), p_location_kind);
end
$$;

reset role;
