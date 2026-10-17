-- Site services: internal receiving codes after a lot code typed by stores (Phase 6 mutation campaign, defect M6-D1;
-- PR-17).
--
-- Handbook: modules/site-services.md
--
--   Site services 0910 numbered the generated receiving codes (GR<yymmdd>-<nnnn>) from the count of the day's codes of
--   that shape, but advanced the counter for every batch, also for one whose lot code stores typed. After a delivery in
--   which a typed code was not on the last batch, the next generated code of the day already existed and every later
--   receipt that day failed on the unique lot code (it failed safe: no record was written, receiving stopped).
--   site.receive_supplier_batches now takes the next number from the highest generated code of the day, advances it only
--   for a batch without a typed code, and skips a code the site already holds (a typed code in the generated shape), so
--   codes stay unique and are never reused; gaps are allowed. The number is no longer cut to four digits past 9999.
--   Every other check of the function is unchanged.
--
-- Messages: none new.

set local role ebmr_owner;

create or replace function site.receive_supplier_batches(p jsonb, p_message uuid, p_source text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, kernel, platform, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  v_site   text := site.actor_site();
  m        site.erp_material;
  b        jsonb;
  v_id     uuid;
  v_code   text;
  v_qty    numeric;
  v_exp    timestamptz;
  v_ret    timestamptz;
  v_ok     boolean;
  v_lots   jsonb := '[]'::jsonb;
  v_day    text;
  v_n      integer;
  v_master jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'deliveryId', '') !~ '^[!-~]{1,64}$'
     or coalesce(p ->> 'supplierCode', '') !~ '^[!-~]{1,64}$'
     or jsonb_typeof(p -> 'batches') is distinct from 'array' or jsonb_array_length(p -> 'batches') not between 1 and 100 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-914 a delivery names its id, the material, the supplier and one to 100 supplier batches (PR-17)';
  end if;
  m := site.erp_material_current(p ->> 'materialCode');
  if m.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-171 material %s is not in the ERP material master; a lot is received only for a known material (PR-17)', coalesce(p ->> 'materialCode', 'NULL'));
  end if;
  if not site.lot_is_purchased(m.material_kind) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-172 material %s is %s in the material master; only a purchased material is received (PR-17, IN-24 (a))', m.material_code, m.material_kind);
  end if;
  if exists (select 1 from site.material_lot l where l.site_code = v_site and l.material_code = m.material_code and l.material_kind <> m.material_kind)
     or (m.material_kind is distinct from 'EXCIPIENT'
         and exists (select 1 from site.vendor_route v where v.site_code = v_site and v.material_code = m.material_code)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-105 material %s is already known at site %s as another kind than %s', m.material_code, v_site, m.material_kind);
  end if;
  if (select count(distinct x ->> 'supplierLot') from jsonb_array_elements(p -> 'batches') x) <> jsonb_array_length(p -> 'batches') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-914 each supplier batch appears once in a delivery: it becomes one lot (PR-17)';
  end if;
  if exists (select 1 from site.lot_receipt r where r.site_code = v_site and r.delivery_id = p ->> 'deliveryId') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-914 delivery %s was already received at site %s', p ->> 'deliveryId', v_site);
  end if;
  -- The item master is flagged when its mirror is old, never blocking (D-P6a-3).
  v_master := platform.mirror_fresh_or_raise('ERP_ITEM_MASTER');
  if not coalesce((v_master ->> 'stale')::boolean, false) then
    v_master := null;
  end if;
  -- Internal receiving codes are numbered per site and day (PR-17: each lot of each shipment its own code).
  perform pg_advisory_xact_lock(hashtextextended('lot_receipt_code:' || v_site, 0));
  v_day := to_char(clock_timestamp() at time zone coalesce(kernel.site_zone(), 'UTC'), 'YYMMDD');
  -- The next number follows the highest generated code of the day (M6-D1: not a count, which a typed code threw off).
  select coalesce(max(substring(l.lot_code from '-([0-9]+)$')::integer), 0) into v_n
    from site.material_lot l where l.site_code = v_site and l.lot_code ~ ('^GR' || v_day || '-[0-9]{4,9}$');
  for b in select * from jsonb_array_elements(p -> 'batches') loop
    if jsonb_typeof(b) <> 'object' or coalesce(b ->> 'supplierLot', '') !~ '^[!-~]{1,64}$' or coalesce(b ->> 'manufacturerCode', '') !~ '^[!-~]{1,64}$'
       or coalesce(b ->> 'containers', '') !~ '^[1-9][0-9]{0,5}$' or coalesce(b ->> 'value', '') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$'
       or coalesce(b ->> 'expiresAt', '') !~ site.instant_text_pattern()
       or (b ? 'retestAt' and coalesce(b ->> 'retestAt', '') !~ site.instant_text_pattern()) or (b ? 'lotCode' and coalesce(b ->> 'lotCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$') then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-914 a supplier batch names its supplier batch number, manufacturer, number of containers, quantity (decimal text) and expiry (PR-17)';
    end if;
    if b ->> 'unit' is distinct from m.unit then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-915 supplier batch %s is in %s; material %s is stocked in %s and the eBMR does not convert a received quantity (DI-31)',
                         b ->> 'supplierLot', coalesce(b ->> 'unit', 'no unit'), m.material_code, m.unit);
    end if;
    v_qty := (b ->> 'value')::numeric;
    if v_qty <= 0 then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-915 supplier batch %s has no quantity (INV-13)', b ->> 'supplierLot');
    end if;
    v_exp := (b ->> 'expiresAt')::timestamptz;
    v_ret := (b ->> 'retestAt')::timestamptz;
    if v_ret is not null and v_ret > v_exp then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-914 supplier batch %s has its retest after its expiry (PR-18)', b ->> 'supplierLot');
    end if;
    if v_exp <= clock_timestamp() then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-104 supplier batch %s is received with an expiry instant in the future (PR-18)', b ->> 'supplierLot');
    end if;
    if b ->> 'lotCode' is not null then
      v_code := b ->> 'lotCode';
    else
      -- A typed code never advances the number; a code already held (typed in the generated shape) is skipped, never reused.
      loop
        v_n := v_n + 1;
        v_code := 'GR' || v_day || '-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
        exit when not exists (select 1 from site.material_lot l where l.site_code = v_site and l.lot_code = v_code);
      end loop;
    end if;
    v_id := gen_random_uuid();
    insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, supplier_lot, received_quantity,
                                   unit, retest_at, expires_at, received_by_person, received_by_account, correlation_id)
    values (v_id, v_site, v_code, m.material_code, m.material_name, m.material_kind, p ->> 'supplierCode', b ->> 'supplierLot', v_qty,
            m.unit, v_ret, v_exp, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
    perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
    v_ok := site.manufacturer_approved(v_site, m.material_code, b ->> 'manufacturerCode');
    insert into site.lot_receipt (lot_id, site_code, delivery_id, delivery_note_name, supplier_code, supplier_lot, manufacturer_code, containers,
                                  received_value, received_unit, remarks, manufacturer_approved, source, inbound_message_id, item_master_freshness,
                                  recorded_by_person, recorded_by_account, correlation_id)
    values (v_id, v_site, p ->> 'deliveryId', nullif(btrim(coalesce(p ->> 'deliveryNoteName', '')), ''), p ->> 'supplierCode', b ->> 'supplierLot',
            b ->> 'manufacturerCode', (b ->> 'containers')::integer, b ->> 'value', b ->> 'unit', nullif(btrim(coalesce(p ->> 'remarks', '')), ''), v_ok,
            p_source, p_message, v_master, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
    v_lots := v_lots || jsonb_build_object('lotId', v_id, 'lotCode', v_code, 'supplierLot', b ->> 'supplierLot',
                                           'manufacturerCode', b ->> 'manufacturerCode', 'manufacturerApproved', v_ok);
  end loop;
  return jsonb_build_object('deliveryId', p ->> 'deliveryId', 'siteCode', v_site, 'lots', v_lots, 'itemMasterStale', v_master is not null);
end
$$;
revoke all on function site.receive_supplier_batches(jsonb, uuid, text) from public;

reset role;
