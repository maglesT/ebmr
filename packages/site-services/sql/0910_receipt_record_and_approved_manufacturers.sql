-- Site services: the complete receipt record, one lot per supplier batch and the approved-manufacturer register
-- (Phase 6 slice 6a, builder A; PR-17 clauses 2 to 4; DI-31 for receipts that arrive through the WMS adapter;
-- defaults D-P6a-A-3 to D-P6a-A-6).
--
-- Handbook: modules/site-services.md
--
--   site.approved_manufacturer        QA's register of approved manufacturers per material and site (insert-only): a
--                                     proposal with its basis (qualification or audit reference), effective only once
--                                     QA signed it (MANUFACTURER_APPROVED, site.approve_manufacturer), and withdrawn
--                                     with the person's reason (site.withdraw_manufacturer_approval). One approved row
--                                     per material and manufacturer at a time.
--   site.lot_receipt                  the receipt record of a purchased lot (one per lot, insert-only): delivery, name on
--                                     the delivery note, supplier, supplier (manufacturer's) batch, manufacturer, number
--                                     of containers, the quantity exactly as received (decimal text and unit), remarks,
--                                     whether the manufacturer was approved at receipt, the inbound message when it came
--                                     from the WMS (DI-31 provenance) and the item-master freshness flag (ERP_ITEM_MASTER
--                                     is flagged, never blocking).
--   site.lot_receipt_examination      the receiving examination of the containers (labels, damage, seals, contamination)
--                                     by a person, who is recorded as the examiner: ACCEPTABLE or DEFECTS_FOUND (then QC
--                                     decides; the lot cannot be issued).
--
-- Commands (every one refuses administrators, DI-18, and checks its permission in the site, DI-17):
--   site.receive_delivery(p)              MATERIAL.HANDLE  a delivery with one or more supplier batches: one lot per
--                                                          supplier batch, each with its receipt record (PR-17 clause 2)
--   site.record_lot_receipt(lot, p)       MATERIAL.HANDLE  the receipt record of a lot received with site.receive_lot
--   site.record_receipt_examination(lot, p) MATERIAL.HANDLE  the examination, by a person (HUMAN account) only
--   site.propose_approved_manufacturer(p) MATERIAL.QA_DISPOSITION
--   site.approve_manufacturer(id, sig)    MATERIAL.QA_DISPOSITION, with QA's MANUFACTURER_APPROVED signature
--   site.withdraw_manufacturer_approval(id, reason)  MATERIAL.QA_DISPOSITION
--   site.receive_supplier_batches(p, message, source)  owner only: the shared body (the WMS adapter's command, 0913)
-- Reads: site.manufacturer_approved(site, material, manufacturer), site.lot_receipt_effective(lot) (with corrections
-- of interface-captured values, 0913), site.receipt_problem(lot) (PR-17 clause 4), site.manufacturer_problem(lot)
-- (PR-17 clause 3).
--
-- Database rules:
--   * RELEASE and RELEASE_FOR_FURTHER_PROCESSING of a lot whose receipt names a manufacturer that is not approved now
--     are refused (trigger zz_manufacturer_approved on site.lot_status_command; EBMR-SITE-918): the label disagrees
--     with the approved list, so the lot is blocked and stays with QC (PR-17 clause 3).
--   * Issue (reservation and consumption) needs a complete receipt record and an approved manufacturer: the issue gate
--     of 0913 calls site.receipt_problem and site.manufacturer_problem (PR-17 clause 4; the approved-source check is
--     repeated at dispensing, the control's design choice).
--   * Lots made here (INTERMEDIATE from a batch, FINISHED, RETURNED) have no receipt and are not checked.
--
-- Messages: EBMR-SITE-910 to EBMR-SITE-918.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table site.approved_manufacturer (
  id                   uuid primary key default gen_random_uuid(),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  material_code        text not null check (material_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  manufacturer_code    text not null check (manufacturer_code ~ '^[!-~]{1,64}$'),
  manufacturer_name    text not null check (btrim(manufacturer_name) <> '' and length(manufacturer_name) <= 200),
  manufacturing_site   text check (manufacturing_site is null or (btrim(manufacturing_site) <> '' and length(manufacturing_site) <= 500)),
  basis                text not null check (length(btrim(basis)) >= 10 and length(basis) <= 2000),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  proposed_at          timestamptz not null default clock_timestamp()
);
create index approved_manufacturer_material on site.approved_manufacturer (site_code, material_code, manufacturer_code);
revoke all on site.approved_manufacturer from public;

create table site.approved_manufacturer_approval (
  approved_manufacturer_id  uuid primary key references site.approved_manufacturer (id),
  signature_id              uuid not null unique,
  approved_by_person        uuid not null,
  approved_by_account       uuid not null,
  approved_at               timestamptz not null default clock_timestamp()
);
revoke all on site.approved_manufacturer_approval from public;

create table site.approved_manufacturer_withdrawal (
  approved_manufacturer_id  uuid primary key references site.approved_manufacturer_approval (approved_manufacturer_id),
  reason                    text not null check (btrim(reason) <> ''),
  withdrawn_by_person       uuid not null,
  withdrawn_by_account      uuid not null,
  withdrawn_at              timestamptz not null default clock_timestamp()
);
revoke all on site.approved_manufacturer_withdrawal from public;

create table site.lot_receipt (
  lot_id                 uuid primary key references site.material_lot (id),
  site_code              text not null,
  delivery_id            text not null check (delivery_id ~ '^[!-~]{1,64}$'),
  delivery_note_name     text check (delivery_note_name is null or (btrim(delivery_note_name) <> '' and length(delivery_note_name) <= 500)),
  supplier_code          text not null check (supplier_code ~ '^[!-~]{1,64}$'),
  supplier_lot           text not null check (supplier_lot ~ '^[!-~]{1,64}$'),
  manufacturer_code      text not null check (manufacturer_code ~ '^[!-~]{1,64}$'),
  containers             integer not null check (containers between 1 and 999999),
  received_value         text not null check (received_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  received_unit          text not null check (received_unit ~ '^[!-~]{1,32}$'),
  remarks                text check (remarks is null or (btrim(remarks) <> '' and length(remarks) <= 2000)),
  manufacturer_approved  boolean not null,
  source                 text not null check (source in ('MANUAL', 'INTERFACE')),
  inbound_message_id     uuid references platform.inbound_message (id),
  item_master_freshness  jsonb,
  recorded_by_person     uuid not null,
  recorded_by_account    uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  correlation_id         uuid not null,
  check ((source = 'INTERFACE') = (inbound_message_id is not null))
);
-- One lot per supplier batch of a delivery (PR-17 clause 2); the same supplier batch in another delivery is another lot.
create unique index lot_receipt_supplier_batch on site.lot_receipt (site_code, delivery_id, supplier_lot);
create index lot_receipt_message on site.lot_receipt (inbound_message_id);
revoke all on site.lot_receipt from public;

create table site.lot_receipt_examination (
  lot_id               uuid primary key references site.lot_receipt (lot_id),
  containers_examined  integer not null check (containers_examined between 1 and 999999),
  outcome              text not null check (outcome in ('ACCEPTABLE', 'DEFECTS_FOUND')),
  remarks              text check (remarks is null or (btrim(remarks) <> '' and length(remarks) <= 2000)),
  examined_by_person   uuid not null,
  examined_by_account  uuid not null,
  examined_at          timestamptz not null default clock_timestamp(),
  check (outcome = 'ACCEPTABLE' or remarks is not null)
);
revoke all on site.lot_receipt_examination from public;

select platform.enforce_db_time('site.approved_manufacturer', array['proposed_at']);
select platform.enforce_db_time('site.approved_manufacturer_approval', array['approved_at']);
select platform.enforce_db_time('site.approved_manufacturer_withdrawal', array['withdrawn_at']);
select platform.enforce_db_time('site.lot_receipt', array['recorded_at']);
select platform.enforce_db_time('site.lot_receipt_examination', array['examined_at']);
select kernel.register_audited_table('site.approved_manufacturer', 'approved_manufacturer', 'id', true);
select kernel.register_audited_table('site.approved_manufacturer_approval', 'approved_manufacturer', 'approved_manufacturer_id', true);
select kernel.register_audited_table('site.approved_manufacturer_withdrawal', 'approved_manufacturer', 'approved_manufacturer_id', true);
select kernel.register_audited_table('site.lot_receipt', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_receipt_examination', 'material_lot', 'lot_id', true);

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function site.manufacturer_approved(p_site text, p_material text, p_manufacturer text) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.approved_manufacturer m
                   join site.approved_manufacturer_approval a on a.approved_manufacturer_id = m.id
                  where m.site_code = p_site and m.material_code = p_material and m.manufacturer_code = p_manufacturer
                    and not exists (select 1 from site.approved_manufacturer_withdrawal w where w.approved_manufacturer_id = m.id))
$$;

create function site.approved_manufacturer_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when exists (select 1 from site.approved_manufacturer_withdrawal w where w.approved_manufacturer_id = p_id) then 'WITHDRAWN'
              when exists (select 1 from site.approved_manufacturer_approval a where a.approved_manufacturer_id = p_id) then 'APPROVED'
              when exists (select 1 from site.approved_manufacturer m where m.id = p_id) then 'PROPOSED' end
$$;

-- An ISO 8601 instant with its offset, as the contracts send it (checked before any cast).
create function site.instant_text_pattern() returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
$$;

-- Lots received from a supplier (these need a receipt record); lots made at the site do not.
create function site.lot_is_purchased(p_kind text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING')
$$;

-- The receipt record as it stands: the stored row with any correction of its interface-captured values applied (0913
-- replaces this function to read the corrections). NULL when the lot has no receipt record.
create function site.lot_receipt_effective(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('lotId', r.lot_id, 'siteCode', r.site_code, 'deliveryId', r.delivery_id, 'deliveryNoteName', r.delivery_note_name,
                            'supplierCode', r.supplier_code, 'supplierLot', r.supplier_lot, 'manufacturerCode', r.manufacturer_code,
                            'containers', r.containers::text, 'receivedValue', r.received_value, 'receivedUnit', r.received_unit, 'remarks', r.remarks,
                            'manufacturerApprovedAtReceipt', r.manufacturer_approved, 'source', r.source, 'inboundMessageId', r.inbound_message_id,
                            'corrections', '[]'::jsonb)
    from site.lot_receipt r where r.lot_id = p_lot
$$;

-- NULL when the lot may be issued as far as its receipt record goes (PR-17 clause 4), else why not.
create function site.receipt_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l  site.material_lot;
  r  jsonb;
  x  site.lot_receipt_examination;
begin
  select * into l from site.material_lot where id = p_lot;
  if not found or not site.lot_is_purchased(l.material_kind) then
    return null;
  end if;
  r := site.lot_receipt_effective(p_lot);
  if r is null then
    return format('lot %s has no receipt record (delivery, supplier, supplier batch, manufacturer and number of containers); stores record it before the lot is issued (PR-17)', l.lot_code);
  end if;
  select * into x from site.lot_receipt_examination e where e.lot_id = p_lot;
  if not found then
    return format('the %s containers of lot %s were not examined at receipt; the examiner records the examination before the lot is issued (PR-17)', r ->> 'containers', l.lot_code);
  end if;
  if x.outcome <> 'ACCEPTABLE' then
    return format('the receipt examination of lot %s found defects (%s); the lot is blocked and QC decides (PR-17)', l.lot_code, x.remarks);
  end if;
  if x.containers_examined::text <> r ->> 'containers' then
    return format('the receipt examination of lot %s covers %s of its %s containers; every container is examined (PR-17)', l.lot_code, x.containers_examined, r ->> 'containers');
  end if;
  return null;
end
$$;

-- NULL unless the lot's receipt names a manufacturer that is not approved now for its material at its site.
create function site.manufacturer_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l site.material_lot;
  r jsonb;
begin
  select * into l from site.material_lot where id = p_lot;
  r := site.lot_receipt_effective(p_lot);
  if r is null or site.manufacturer_approved(l.site_code, l.material_code, r ->> 'manufacturerCode') then
    return null;
  end if;
  return format('lot %s names manufacturer %s, which is not on the approved-manufacturer register for %s at site %s; the lot is blocked and stays with QC (PR-17)',
                l.lot_code, r ->> 'manufacturerCode', l.material_code, l.site_code);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Approved-manufacturer register
-- ---------------------------------------------------------------------------------------------

-- p: {materialCode, manufacturerCode, manufacturerName, manufacturingSite?, basis}
create function site.propose_approved_manufacturer(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', v_site));
  if p is null or jsonb_typeof(p) <> 'object'
     or coalesce(p ->> 'manufacturerCode', '') !~ '^[!-~]{1,64}$' or btrim(coalesce(p ->> 'manufacturerName', '')) = ''
     or length(btrim(coalesce(p ->> 'basis', ''))) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-910 an approved manufacturer names the material, the manufacturer''s code and name and the basis of the approval (qualification or audit reference, at least 10 characters) (PR-17)';
  end if;
  if (site.erp_material_current(p ->> 'materialCode')).id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-910 material %s is not in the ERP material master (PR-17)', coalesce(p ->> 'materialCode', 'NULL'));
  end if;
  insert into site.approved_manufacturer (site_code, material_code, manufacturer_code, manufacturer_name, manufacturing_site, basis,
                                          proposed_by_person, proposed_by_account)
  values (v_site, p ->> 'materialCode', p ->> 'manufacturerCode', p ->> 'manufacturerName', nullif(btrim(coalesce(p ->> 'manufacturingSite', '')), ''),
          p ->> 'basis', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The signature covers the material, the manufacturer and QA's stored basis.
create function site.approved_manufacturer_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  m site.approved_manufacturer;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into m from site.approved_manufacturer where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('site_code', m.site_code, 'material_code', m.material_code, 'manufacturer_code', m.manufacturer_code,
                                  'manufacturer_name', m.manufacturer_name, 'manufacturing_site', m.manufacturing_site, 'basis', m.basis,
                                  'proposed_by', m.proposed_by_person, 'proposed_at', site.utc_text(m.proposed_at)),
    'state', site.approved_manufacturer_state(m.id),
    'scope', jsonb_build_object('site', m.site_code));
end
$$;

select esig.register_content_provider('approved_manufacturer', 'site.approved_manufacturer_content(text)',
  'Approved manufacturer of one material at a site: manufacturer and QA''s basis (PR-17)');

create function site.approve_manufacturer(p_id uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  m      site.approved_manufacturer;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into m from site.approved_manufacturer where id = p_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-911 unknown approved-manufacturer proposal %s', p_id);
  end if;
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', m.site_code));
  -- Every row of the material and manufacturer at the site is locked, so two approvals never overlap.
  perform 1 from site.approved_manufacturer x
   where x.site_code = m.site_code and x.material_code = m.material_code and x.manufacturer_code = m.manufacturer_code for update;
  if exists (select 1 from site.approved_manufacturer_approval a where a.approved_manufacturer_id = m.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-911 the proposal for manufacturer %s of %s was already approved or withdrawn; propose it again', m.manufacturer_code, m.material_code);
  end if;
  perform esig.assert_signature(p_signature, 'MANUFACTURER_APPROVED', 'approved_manufacturer', p_id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-912 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-912 the manufacturer is approved by the QA person who signed the approval';
  end if;
  if site.manufacturer_approved(m.site_code, m.material_code, m.manufacturer_code) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-911 manufacturer %s is already approved for %s at site %s', m.manufacturer_code, m.material_code, m.site_code);
  end if;
  insert into site.approved_manufacturer_approval (approved_manufacturer_id, signature_id, approved_by_person, approved_by_account)
  values (m.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function site.withdraw_manufacturer_approval(p_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  m     site.approved_manufacturer;
begin
  perform iam.assert_not_administrator();
  select * into m from site.approved_manufacturer where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-911 unknown approved-manufacturer proposal %s', p_id);
  end if;
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', m.site_code));
  if site.approved_manufacturer_state(m.id) <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-913 manufacturer %s of %s is not approved by this row', m.manufacturer_code, m.material_code);
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-913 withdrawing a manufacturer''s approval states the reason';
  end if;
  insert into site.approved_manufacturer_withdrawal (approved_manufacturer_id, reason, withdrawn_by_person, withdrawn_by_account)
  values (m.id, p_reason, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Receipt
-- ---------------------------------------------------------------------------------------------

-- The shared body of a receipt (owner only). p: {deliveryId, materialCode, supplierCode, deliveryNoteName?, remarks?,
-- batches: [{lotCode?, supplierLot, manufacturerCode, containers (text), value (decimal text), unit, expiresAt
-- (instant), retestAt?}]}. One lot per supplier batch, in QUARANTINE, each with its receipt record; the caller has
-- checked its own permission. Returns {deliveryId, lots: [{lotId, lotCode, supplierLot, manufacturerCode,
-- manufacturerApproved}]}.
create function site.receive_supplier_batches(p jsonb, p_message uuid, p_source text) returns jsonb
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
  select count(*) into v_n from site.material_lot l where l.site_code = v_site and l.lot_code like 'GR' || v_day || '-%';
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
    v_n := v_n + 1;
    v_code := coalesce(b ->> 'lotCode', 'GR' || v_day || '-' || lpad(v_n::text, 4, '0'));
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

-- A delivery received by stores (MATERIAL.HANDLE). p as site.receive_supplier_batches, the batches under
-- supplierBatches with quantity {value, unit} (as the WMS contract).
create function site.receive_delivery(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_site text;
begin
  perform site.require_actor();
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_site));
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'supplierBatches') is distinct from 'array' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-914 a delivery names its id, the material, the supplier and one to 100 supplier batches (PR-17)';
  end if;
  return site.receive_supplier_batches(
    jsonb_build_object('deliveryId', p -> 'deliveryId', 'materialCode', p -> 'materialCode', 'supplierCode', p -> 'supplierCode',
                       'deliveryNoteName', p -> 'deliveryNoteName', 'remarks', p -> 'remarks',
                       'batches', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                     'lotCode', b -> 'lotCode', 'supplierLot', b -> 'supplierLot', 'manufacturerCode', b -> 'manufacturerCode',
                                     'containers', b -> 'containers', 'value', b -> 'quantity' -> 'value', 'unit', b -> 'quantity' -> 'unit',
                                     'expiresAt', b -> 'expiresAt', 'retestAt', b -> 'retestAt')) order by o), '[]'::jsonb)
                                   from jsonb_array_elements(p -> 'supplierBatches') with ordinality x(b, o))),
    null, 'MANUAL');
end
$$;

-- The receipt record of a lot received with site.receive_lot (which records none). p: {deliveryId, supplierCode,
-- supplierLot, manufacturerCode, containers, deliveryNoteName?, remarks?}.
create function site.record_lot_receipt(p_lot uuid, p jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.material_lot;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  if not site.lot_is_purchased(l.material_kind) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-915 lot %s is %s: it was made here and has no receipt record', l.lot_code, l.material_kind);
  end if;
  if exists (select 1 from site.lot_receipt r where r.lot_id = l.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-915 lot %s already has its receipt record', l.lot_code);
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'deliveryId', '') !~ '^[!-~]{1,64}$'
     or coalesce(p ->> 'supplierCode', '') !~ '^[!-~]{1,64}$' or coalesce(p ->> 'supplierLot', '') !~ '^[!-~]{1,64}$'
     or coalesce(p ->> 'manufacturerCode', '') !~ '^[!-~]{1,64}$' or coalesce(p ->> 'containers', '') !~ '^[1-9][0-9]{0,5}$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-914 a receipt record names the delivery, the supplier, the supplier batch, the manufacturer and the number of containers (PR-17)';
  end if;
  if l.supplier_lot is not null and l.supplier_lot is distinct from p ->> 'supplierLot' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-915 lot %s was received as supplier batch %s, not %s', l.lot_code, l.supplier_lot, p ->> 'supplierLot');
  end if;
  insert into site.lot_receipt (lot_id, site_code, delivery_id, delivery_note_name, supplier_code, supplier_lot, manufacturer_code, containers,
                                received_value, received_unit, remarks, manufacturer_approved, source, recorded_by_person, recorded_by_account, correlation_id)
  values (l.id, l.site_code, p ->> 'deliveryId', nullif(btrim(coalesce(p ->> 'deliveryNoteName', '')), ''), p ->> 'supplierCode', p ->> 'supplierLot',
          p ->> 'manufacturerCode', (p ->> 'containers')::integer, l.received_quantity::text, l.unit, nullif(btrim(coalesce(p ->> 'remarks', '')), ''),
          site.manufacturer_approved(l.site_code, l.material_code, p ->> 'manufacturerCode'), 'MANUAL',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
end
$$;

-- The receiving examination, by the person who examined the containers. p: {containersExamined, outcome, remarks?}.
create function site.record_receipt_examination(p_lot uuid, p jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  v_kind text;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  select a.kind into v_kind from iam.account a where a.id = (v_ctx ->> 'account_id')::uuid;
  if v_kind is distinct from 'HUMAN' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-916 the receiving examination is recorded by the person who examined the containers (PR-17, DI-14)';
  end if;
  if not exists (select 1 from site.lot_receipt r where r.lot_id = l.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-916 lot %s has no receipt record to examine against', l.lot_code);
  end if;
  if exists (select 1 from site.lot_receipt_examination e where e.lot_id = l.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-916 the containers of lot %s were already examined', l.lot_code);
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'containersExamined', '') !~ '^[1-9][0-9]{0,5}$'
     or coalesce(p ->> 'outcome', '') not in ('ACCEPTABLE', 'DEFECTS_FOUND')
     or (p ->> 'outcome' = 'DEFECTS_FOUND' and btrim(coalesce(p ->> 'remarks', '')) = '') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-916 an examination gives the number of containers examined and ACCEPTABLE or DEFECTS_FOUND, with remarks when defects were found (PR-17)';
  end if;
  insert into site.lot_receipt_examination (lot_id, containers_examined, outcome, remarks, examined_by_person, examined_by_account)
  values (l.id, (p ->> 'containersExamined')::integer, p ->> 'outcome', nullif(btrim(coalesce(p ->> 'remarks', '')), ''),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Release refused for an unapproved manufacturer (PR-17 clause 3)
-- ---------------------------------------------------------------------------------------------

create function site.lot_release_manufacturer_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob text;
begin
  if new.event in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING') then
    v_prob := site.manufacturer_problem(new.lot_id);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-918 ' || v_prob;
    end if;
  end if;
  return new;
end
$$;

create trigger zz_manufacturer_approved before insert on site.lot_status_command
  for each row execute function site.lot_release_manufacturer_check();

-- ---------------------------------------------------------------------------------------------
-- Signature meaning, grants
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0910_receipt_record_and_approved_manufacturers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the approved-manufacturer register and its signature meaning (PR-17, Phase 6 slice 6a)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('MANUFACTURER_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Manufacturer approved for a material',
   'Quality-unit decision: lots of this material made by this manufacturer may be accepted at receipt, on the basis recorded.',
   array['MATERIAL.QA_DISPOSITION'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'PR-17; US 211.84; EU Ch.5 5.30 (approved manufacturer and supplier list)');

select kernel.set_actor_context(null);

grant select on site.approved_manufacturer, site.approved_manufacturer_approval, site.approved_manufacturer_withdrawal, site.lot_receipt,
                site.lot_receipt_examination to ebmr_app;
grant execute on function site.manufacturer_approved(text, text, text), site.approved_manufacturer_state(uuid), site.instant_text_pattern(), site.lot_is_purchased(text),
                          site.lot_receipt_effective(uuid), site.receipt_problem(uuid), site.manufacturer_problem(uuid),
                          site.propose_approved_manufacturer(jsonb), site.approve_manufacturer(uuid, uuid), site.withdraw_manufacturer_approval(uuid, text),
                          site.receive_delivery(jsonb), site.record_lot_receipt(uuid, jsonb), site.record_receipt_examination(uuid, jsonb)
  to ebmr_app;

reset role;
