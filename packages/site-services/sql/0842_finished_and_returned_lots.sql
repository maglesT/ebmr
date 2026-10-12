-- Finished lots and returned goods in the lot register (Phase 4 slice 2b; controls IN-05 (a), PR-45, PR-48; plan
-- default D-P4-3; outline 5.2.9).
--
--   site.finished_lot       the finished lot of one packaging batch (one per batch): its material lot (kind FINISHED,
--                           lot code = batch number, material code = product code, created in QUARANTINE), the batch's
--                           number, edition, product, strength and market set. Written only by site.create_finished_lot,
--                           which the application role cannot call: the edition posts its packaging batch's output
--                           (tablets 1150, tab.post_finished_lot) and reads it with site.finished_lot_of(batch).
--   site.returned_goods     returned goods booked in (PR-48): a material lot of the new kind RETURNED, in QUARANTINE,
--                           linked to the finished lot it came from, with the quantity, the reason and who returned it.
--   site.returned_goods_assessment  QC's assessment (insert-only; the latest counts): the product's nature, its storage
--                           requirements, condition and history, the time since issue, whether any doubt remains, whether
--                           the reason implicates other batches (then a deviation-lite investigation of the site is
--                           linked), and the disposition: DESTROY (the default), CHEMICAL_RECOVERY or RETURN_TO_STOCK; with
--                           any doubt only DESTROY or CHEMICAL_RECOVERY (EU rule applied to all markets, PR-48 D-12).
--   site.returned_goods_assessment_signature  QC's RETURNED_GOODS_ASSESSED signature over the returned goods' content
--                           (which shows the latest assessment), recorded by the QC person who assessed and signed.
--
-- Database rules:
--   * a deferred constraint trigger refuses, at commit, a FINISHED lot with no finished_lot row and a RETURNED lot with no
--     returned_goods row (EBMR-SITE-420): a receipt (site.receive_lot) never creates either;
--   * the guard material_lot.not_finished (CREATE OR REPLACE from 0710): a FINISHED lot leaves quarantine only through the
--     release model (unchanged); a RETURNED lot leaves it only by REJECT, and only after QC's signed assessment chose
--     DESTROY or CHEMICAL_RECOVERY (then DESTROY with a witness, 0712); RELEASE and release for further processing of a
--     RETURNED lot are refused: re-issue and chemical recovery go through the release model and reprocessing (later
--     slices);
--   * site.propose_lot_decision (CREATE OR REPLACE from 0800): a RECALL of a FINISHED lot is refused (EBMR-SITE-421): a
--     finished lot is recalled through the recall of slice 5 (D-P4-3).
-- Messages: EBMR-SITE-420 to EBMR-SITE-429.

set local role ebmr_owner;

alter table site.material_lot drop constraint material_lot_material_kind_check;
alter table site.material_lot add constraint material_lot_material_kind_check
  check (material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED', 'RETURNED'));

create table site.finished_lot (
  lot_id               uuid primary key references site.material_lot (id),
  batch_id             uuid not null unique,
  batch_number         text not null,
  edition              text not null check (edition in ('TABLETS', 'INJECTABLES')),
  product_code         text not null,
  strength             text not null,
  markets              text[] not null check (cardinality(markets) >= 1),
  posted_by_person     uuid not null,
  posted_by_account    uuid not null,
  posted_at            timestamptz not null default clock_timestamp()
);
revoke all on site.finished_lot from public;

create table site.returned_goods (
  lot_id               uuid primary key references site.material_lot (id),
  original_lot_id      uuid not null references site.material_lot (id),
  quantity             numeric not null check (quantity > 0),
  unit                 text not null,
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  returned_from        text not null check (btrim(returned_from) <> '' and length(returned_from) <= 200),
  received_by_person   uuid not null,
  received_by_account  uuid not null,
  received_at          timestamptz not null default clock_timestamp(),
  check (lot_id <> original_lot_id)
);
create index returned_goods_original on site.returned_goods (original_lot_id);
revoke all on site.returned_goods from public;

create table site.returned_goods_assessment (
  id                        uuid primary key default gen_random_uuid(),
  lot_id                    uuid not null references site.returned_goods (lot_id),
  nature                    text not null check (btrim(nature) <> '' and length(nature) <= 2000),
  storage                   text not null check (btrim(storage) <> '' and length(storage) <= 2000),
  condition_history         text not null check (btrim(condition_history) <> '' and length(condition_history) <= 2000),
  time_since_issue          text not null check (btrim(time_since_issue) <> '' and length(time_since_issue) <= 200),
  doubt                     boolean not null,
  implicates_other_batches  boolean not null,
  investigation_id          uuid references site.deviation (id),
  disposition               text not null check (disposition in ('DESTROY', 'CHEMICAL_RECOVERY', 'RETURN_TO_STOCK')),
  recorded_by_person        uuid not null,
  recorded_by_account       uuid not null,
  recorded_at               timestamptz not null default clock_timestamp(),
  check (not doubt or disposition in ('DESTROY', 'CHEMICAL_RECOVERY')),
  check (implicates_other_batches = (investigation_id is not null))
);
create index returned_goods_assessment_lot on site.returned_goods_assessment (lot_id, recorded_at desc);
revoke all on site.returned_goods_assessment from public;

create table site.returned_goods_assessment_signature (
  assessment_id        uuid primary key references site.returned_goods_assessment (id),
  signature_id         uuid not null unique,
  signed_by_person     uuid not null,
  signed_by_account    uuid not null,
  signed_at            timestamptz not null default clock_timestamp()
);
revoke all on site.returned_goods_assessment_signature from public;

select platform.enforce_db_time('site.finished_lot', array['posted_at']);
select platform.enforce_db_time('site.returned_goods', array['received_at']);
select platform.enforce_db_time('site.returned_goods_assessment', array['recorded_at']);
select platform.enforce_db_time('site.returned_goods_assessment_signature', array['signed_at']);
select kernel.register_audited_table('site.finished_lot', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.returned_goods', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.returned_goods_assessment', 'returned_goods', 'lot_id', true);
select kernel.register_audited_table('site.returned_goods_assessment_signature', 'returned_goods', 'assessment_id', true);

-- A FINISHED lot has its finished_lot row and a RETURNED lot its returned_goods row by the end of the transaction (header).
create function site.material_lot_origin_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if new.material_kind = 'FINISHED' and not exists (select 1 from site.finished_lot f where f.lot_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-420 lot %s is finished product: a finished lot is created in quarantine only from its packaging batch''s output, never received (IN-05 (a), PR-45)', new.lot_code);
  end if;
  if new.material_kind = 'RETURNED' and not exists (select 1 from site.returned_goods g where g.lot_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-420 lot %s is returned goods: it is booked in only as a return of a finished lot (PR-48)', new.lot_code);
  end if;
  return null;
end
$$;

create constraint trigger zz_origin_check after insert on site.material_lot deferrable initially deferred
  for each row execute function site.material_lot_origin_check();

-- ---------------------------------------------------------------------------------------------
-- Finished lots
-- ---------------------------------------------------------------------------------------------

-- Internal (no grant to the application role): the edition's definer posts its packaging batch's output.
-- p: {batchId, batchNumber, edition, siteCode, productCode, productName, strength, markets, quantity, unit, expiresAt}.
create function site.create_finished_lot(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid := gen_random_uuid();
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', p ->> 'siteCode'));
  if p ->> 'siteCode' is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-422 a finished lot is posted at its batch''s site';
  end if;
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'quantity')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-422 the posted quantity of a finished lot is a positive decimal (INV-13)';
  end if;
  perform pg_advisory_xact_lock(hashtext('site.finished_lot'), hashtext(p ->> 'batchId'));
  if exists (select 1 from site.finished_lot f where f.batch_id = (p ->> 'batchId')::uuid) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-423 the finished lot of batch %s is already posted', p ->> 'batchNumber');
  end if;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                 received_by_person, received_by_account, correlation_id)
  values (v_id, p ->> 'siteCode', p ->> 'batchNumber', p ->> 'productCode', p ->> 'productName', 'FINISHED', (p ->> 'quantity')::numeric, p ->> 'unit',
          (p ->> 'expiresAt')::timestamptz, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
  values (v_id, (p ->> 'batchId')::uuid, p ->> 'batchNumber', p ->> 'edition', p ->> 'productCode', p ->> 'strength',
          array(select jsonb_array_elements_text(p -> 'markets')), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return v_id;
end
$$;

-- The finished lot of packaging batch p_batch, or NULL (interface 2-0).
create function site.finished_lot_of(p_batch uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select f.lot_id from site.finished_lot f where f.batch_id = p_batch
$$;

-- ---------------------------------------------------------------------------------------------
-- Returned goods (PR-48)
-- ---------------------------------------------------------------------------------------------

-- p: {originalLotId, quantity (decimal text), reason, returnedFrom}. Returns {lotId, lotCode}.
create function site.receive_returned_goods(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  o      site.material_lot;
  v_id   uuid := gen_random_uuid();
  v_code text;
  v_n    integer;
  v_qty  numeric;
begin
  perform iam.assert_not_administrator();
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'originalLotId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-424 a return names the finished lot it came from';
  end if;
  o := site.lock_lot((p ->> 'originalLotId')::uuid);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', o.site_code));
  if o.site_code is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-424 a return is booked in at the site of its finished lot';
  end if;
  if o.material_kind <> 'FINISHED' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-424 lot %s is %s; only finished product is booked in as returned goods (PR-48)', o.lot_code, o.material_kind);
  end if;
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'quantity')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-425 the returned quantity is a positive decimal (INV-13)';
  end if;
  v_qty := (p ->> 'quantity')::numeric;
  if v_qty + coalesce((select sum(g.quantity) from site.returned_goods g where g.original_lot_id = o.id), 0) > o.received_quantity then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-425 the returns of lot %s would exceed its posted quantity %s %s (INV-13)', o.lot_code, o.received_quantity, o.unit);
  end if;
  if coalesce(btrim(p ->> 'reason'), '') = '' or coalesce(btrim(p ->> 'returnedFrom'), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-425 a return records its reason and who returned it (PR-48)';
  end if;
  select count(*) + 1 into v_n from site.returned_goods g where g.original_lot_id = o.id;
  v_code := left(o.lot_code, 34) || '-R' || v_n;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                 received_by_person, received_by_account, correlation_id)
  values (v_id, o.site_code, v_code, o.material_code, o.material_name, 'RETURNED', v_qty, o.unit, o.expires_at,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  insert into site.returned_goods (lot_id, original_lot_id, quantity, unit, reason, returned_from, received_by_person, received_by_account)
  values (v_id, o.id, v_qty, o.unit, btrim(p ->> 'reason'), btrim(p ->> 'returnedFrom'), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return jsonb_build_object('lotId', v_id, 'lotCode', v_code);
end
$$;

-- The latest assessment of returned lot p_lot, and whether QC signed it.
create function site.returned_goods_latest_assessment(p_lot uuid) returns site.returned_goods_assessment
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select a.* from site.returned_goods_assessment a where a.lot_id = p_lot order by a.recorded_at desc, a.id desc limit 1
$$;

create function site.returned_goods_signed_disposition(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select a.disposition from site.returned_goods_assessment a
   where a.lot_id = p_lot and a.id = (site.returned_goods_latest_assessment(p_lot)).id
     and exists (select 1 from site.returned_goods_assessment_signature s where s.assessment_id = a.id)
$$;

-- p: {nature, storage, conditionHistory, timeSinceIssue, doubt, implicatesOtherBatches, investigationId?, disposition?}
-- (disposition defaults to DESTROY). Returns the assessment's id; QC signs RETURNED_GOODS_ASSESSED over it next.
create function site.record_returned_goods_assessment(p_lot uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  d      site.deviation;
  v_disp text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', l.site_code));
  if not exists (select 1 from site.returned_goods g where g.lot_id = l.id) or site.lot_state(l.id) <> 'QUARANTINE' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-426 lot %s is no returned goods in quarantine; only those are assessed (PR-48)', l.lot_code);
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'doubt') is distinct from 'boolean' or jsonb_typeof(p -> 'implicatesOtherBatches') is distinct from 'boolean'
     or coalesce(btrim(p ->> 'nature'), '') = '' or coalesce(btrim(p ->> 'storage'), '') = '' or coalesce(btrim(p ->> 'conditionHistory'), '') = ''
     or coalesce(btrim(p ->> 'timeSinceIssue'), '') = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-426 an assessment considers the product''s nature, its storage requirements, its condition and history and the time since issue, and states whether any doubt remains and whether other batches are implicated (PR-48)';
  end if;
  v_disp := coalesce(p ->> 'disposition', 'DESTROY');
  if v_disp not in ('DESTROY', 'CHEMICAL_RECOVERY', 'RETURN_TO_STOCK') or ((p -> 'doubt') = 'true'::jsonb and v_disp = 'RETURN_TO_STOCK') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-427 with any doubt about the returned goods only destruction or chemical recovery is chosen; DESTROY is the default (PR-48)';
  end if;
  if (p -> 'implicatesOtherBatches') = 'true'::jsonb then
    if coalesce(p ->> 'investigationId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into d from site.deviation x where x.id = (p ->> 'investigationId')::uuid;
    end if;
    if d.id is null or d.site_code <> l.site_code or d.kind not in ('DEVIATION', 'INVESTIGATION') or site.deviation_state(d.id) = 'CANCELLED' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-428 the return implicates other batches: the assessment links a deviation-lite investigation of site %s, not cancelled (PR-48, IN-20)', l.site_code);
    end if;
  elsif p ? 'investigationId' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-428 an investigation is linked when the return implicates other batches';
  end if;
  insert into site.returned_goods_assessment (lot_id, nature, storage, condition_history, time_since_issue, doubt, implicates_other_batches, investigation_id,
                                              disposition, recorded_by_person, recorded_by_account)
  values (l.id, btrim(p ->> 'nature'), btrim(p ->> 'storage'), btrim(p ->> 'conditionHistory'), btrim(p ->> 'timeSinceIssue'), (p ->> 'doubt')::boolean,
          (p ->> 'implicatesOtherBatches')::boolean, d.id, v_disp, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- Content of aggregate returned_goods:<returned lot id>: the return and its latest assessment. State: the latest
-- assessment's id (NONE before one), so a signature applies to that assessment only.
create function site.returned_goods_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  g site.returned_goods;
  l site.material_lot;
  o site.material_lot;
  a site.returned_goods_assessment;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into g from site.returned_goods where lot_id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = g.lot_id;
  select * into o from site.material_lot where id = g.original_lot_id;
  a := site.returned_goods_latest_assessment(g.lot_id);
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.returned_goods_assessment x where x.lot_id = g.lot_id),
    'content', jsonb_build_object(
      'lot_code', l.lot_code, 'original_lot_code', o.lot_code, 'product_code', o.material_code, 'product_name', o.material_name,
      'quantity', g.quantity::text, 'unit', g.unit, 'reason', g.reason, 'returned_from', g.returned_from,
      'received_at', site.utc_text(g.received_at), 'expires_at', site.utc_text(o.expires_at),
      'assessment', case when a.id is null then null else jsonb_build_object(
        'id', a.id, 'nature', a.nature, 'storage', a.storage, 'condition_history', a.condition_history, 'time_since_issue', a.time_since_issue,
        'doubt', a.doubt, 'implicates_other_batches', a.implicates_other_batches, 'investigation_id', a.investigation_id,
        'disposition', a.disposition, 'recorded_by', a.recorded_by_person, 'recorded_at', site.utc_text(a.recorded_at)) end),
    'state', coalesce(a.id::text, 'NONE'),
    'scope', jsonb_build_object('site', l.site_code));
end
$$;

select esig.register_content_provider('returned_goods', 'site.returned_goods_content(text)',
  'Returned goods: the return, its original finished lot and QC''s latest assessment with the disposition (PR-48)');

create function site.sign_returned_goods_assessment(p_lot uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  a      site.returned_goods_assessment;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', l.site_code));
  a := site.returned_goods_latest_assessment(l.id);
  if a.id is null or exists (select 1 from site.returned_goods_assessment_signature s where s.assessment_id = a.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-429 returned lot %s has no assessment waiting for its signature (PR-48)', l.lot_code);
  end if;
  if a.recorded_by_person::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-429 the QC person who recorded the assessment signs it (PR-48)';
  end if;
  perform esig.assert_signature(p_signature, 'RETURNED_GOODS_ASSESSED', 'returned_goods', l.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-429 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-429 the assessment is signed by the QC person who records the signature';
  end if;
  insert into site.returned_goods_assessment_signature (assessment_id, signature_id, signed_by_person, signed_by_account)
  values (a.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The lot machine's guard and the QA proposal (header)
-- ---------------------------------------------------------------------------------------------

-- As 0710_material_lots.sql; a RETURNED lot leaves quarantine only by REJECT after QC's signed assessment (header).
create or replace function site.guard_not_finished(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist'
              when l.material_kind = 'FINISHED'
                then format('lot %s is finished product: it leaves quarantine only through the batch release model (outline 5.2.6), not as a material lot', l.lot_code)
              when l.material_kind = 'RETURNED' and p_transition ->> 'event' is distinct from 'REJECT'
                then format('lot %s is returned goods: it leaves quarantine only by rejection for destruction or chemical recovery after QC''s signed assessment; re-issue goes through the release model (PR-48)', l.lot_code)
              when l.material_kind = 'RETURNED' and coalesce(site.returned_goods_signed_disposition(l.id), 'NONE') not in ('DESTROY', 'CHEMICAL_RECOVERY')
                then format('lot %s is returned goods: it is rejected only after QC signed an assessment choosing destruction or chemical recovery (PR-48; EBMR-SITE-426)', l.lot_code)
         end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

-- As 0800_lot_decision_signed_event.sql; a RECALL of a finished lot goes through the recall of slice 5 (header).
create or replace function site.propose_lot_decision(p_lot uuid, p_event text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.material_lot;
  s     platform.aggregate_state;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', l.site_code));
  select * into s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = l.id;
  if site.lot_event_meaning(l.id, p_event) is distinct from 'MATERIAL_LOT_STATUS_DECIDED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-113 %s is no QA status decision on lot %s in state %s: a proposal names HOLD, UNHOLD, RETURN, RECALL or RELEASE_FOR_FURTHER_PROCESSING where the lot''s machine allows it (RELEASE and REJECT carry their own meaning)',
                       coalesce(p_event, 'NULL'), l.lot_code, s.state);
  end if;
  if p_event = 'RECALL' and l.material_kind = 'FINISHED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-421 lot %s is finished product: it is recalled through the recall of the release model, not as a material lot (D-P4-3)', l.lot_code);
  end if;
  insert into site.lot_decision_intent (lot_id, event, from_state, state_version, proposed_by_person, proposed_by_account)
  values (l.id, p_event, s.state, s.version, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The meaning and grants
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0842_finished_and_returned_lots)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'returned goods assessment meaning (PR-48)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('RETURNED_GOODS_ASSESSED', 1, 'VENDOR', true, 'ACTIVE', 'LABORATORY', 'APPROVER', 'Returned goods assessed by QC',
   'Quality-control assessment of these returned goods: their nature, storage, condition and history and the time since issue were considered, and the disposition recorded is my decision.',
   array['QC.RESULT_APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'PR-48; US 211.204; EU Ch.5 5.70');

select kernel.set_actor_context(null);

revoke all on site.finished_lot, site.returned_goods, site.returned_goods_assessment, site.returned_goods_assessment_signature from ebmr_app;
grant select on site.finished_lot, site.returned_goods, site.returned_goods_assessment, site.returned_goods_assessment_signature to ebmr_app;
revoke all on function site.create_finished_lot(jsonb), site.material_lot_origin_check(), site.returned_goods_latest_assessment(uuid),
                       site.returned_goods_signed_disposition(uuid) from public;
grant execute on function site.finished_lot_of(uuid), site.receive_returned_goods(jsonb), site.record_returned_goods_assessment(uuid, jsonb),
                          site.sign_returned_goods_assessment(uuid, uuid), site.returned_goods_signed_disposition(uuid) to ebmr_app;

reset role;
