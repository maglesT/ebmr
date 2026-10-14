-- Site services: the WMS lot-status mirror and the ERP/WMS outbound queue delivered by the adapter (Phase 6 slice 6a,
-- builder A; DI-31, INV-26, INV-38, PR-46, L-19; D-P6a-3, D-P6a-5, D-P6a-A-8, D-P6a-A-9).
--
-- Handbook: modules/site-services.md
--
--   site.erp_lot_status            the lot status the WMS reported (insert-only, audited on the lot), with its source
--                                  time and inbound message. A report older (by source time) than the one held is
--                                  refused as STALE (EBMR-ERP-004): a late message never overwrites a newer status.
--   site.erp_lot_status_problem(lot)  NULL unless the site runs ERP_LOT_STATUS as a MIRROR and either the mirror is
--                                  stale (platform.mirror_fresh_or_raise raises EBMR-INT-010, naming the mirror, its age
--                                  and bound) or the WMS's latest status of the lot is not RELEASED (or the WMS never
--                                  reported the lot). In STAND_IN (the default) the eBMR's own status is authoritative.
--                                  The issue gate (0913) calls it at reservation and consumption (the stricter wins: a
--                                  WMS block stops issue even when the eBMR shows the lot released).
--   site.erp_outbound_message      the ERP/WMS outbound queue (operational, insert-only): erp.stock_block (from the
--                                  stock-block requests of 0880), erp.lot_status (each status a lot enters), erp.goods_issue
--                                  (each consumption) and erp.yield (each finished lot), each written by a trigger in the
--                                  transaction of its fact, keyed by that fact (idempotent).
--   site.erp_outbound_delivery     the ERP/WMS acknowledged a message (insert-only, audited on the adapter's chain); for
--                                  a stock block it also records site.erp_stock_block_delivery, so site.erp_stock_state
--                                  shows what the ERP holds. The stub consumer of 0880 stays for the demo without an ERP.
--   site.erp_outbound_attempt      each failed delivery attempt (operational); the first failure of a message raises a
--                                  TRANSPORT integration alarm. A message is never dropped: it stays pending until the
--                                  ERP acknowledges it, retried by the adapter with back-off.
-- Adapter commands (INTERFACE.WRITE, an ACTIVE ERP_WMS adapter only, EBMR-ERP-010):
--   site.erp_outbound_pending(limit) jsonb, site.erp_outbound_delivered(message, erpReference) boolean,
--   site.erp_outbound_failed(message, error) integer.
--   site.apply_wms_lot_status(payload, message, source time)  owner only: the receiving command (0913).
--
-- Messages: EBMR-ERP-002, EBMR-ERP-004, EBMR-ERP-010, EBMR-ERP-011; EBMR-SITE-922.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The lot-status mirror
-- ---------------------------------------------------------------------------------------------

create table site.erp_lot_status (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null references site.material_lot (id),
  site_code           text not null,
  status              text not null check (status in ('QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED')),
  source_timestamp    timestamptz not null,
  inbound_message_id  uuid not null references platform.inbound_message (id),
  recorded_at         timestamptz not null default clock_timestamp()
);
create index erp_lot_status_lot on site.erp_lot_status (lot_id, source_timestamp desc);
revoke all on site.erp_lot_status from public;
select platform.enforce_db_time('site.erp_lot_status', array['recorded_at']);
select kernel.register_audited_table('site.erp_lot_status', 'material_lot', 'lot_id', true);

create function site.erp_lot_status_latest(p_lot uuid) returns site.erp_lot_status
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select s.* from site.erp_lot_status s where s.lot_id = p_lot order by s.source_timestamp desc, s.recorded_at desc limit 1
$$;

-- Owner only (0913). payload: wms.lot_status v1 {lotNumber, status}.
create function site.apply_wms_lot_status(p jsonb, p_message uuid, p_source_ts timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_site text := site.actor_site();
  l      site.material_lot;
  v_held site.erp_lot_status;
  v_id   uuid;
begin
  select * into l from site.material_lot where site_code = v_site and lot_code = p ->> 'lotNumber';
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-002 the WMS reported a status for lot %s, which site %s does not hold (DI-31: wrong identity)', p ->> 'lotNumber', v_site);
  end if;
  perform site.lock_lot(l.id);
  v_held := site.erp_lot_status_latest(l.id);
  if v_held.id is not null and v_held.source_timestamp >= p_source_ts then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-004 the WMS status %s of lot %s at %s is not newer than the status %s already held from %s; a late value never overwrites a newer one (DI-31: stale)',
                       p ->> 'status', l.lot_code, site.utc_text(p_source_ts), v_held.status, site.utc_text(v_held.source_timestamp));
  end if;
  insert into site.erp_lot_status (lot_id, site_code, status, source_timestamp, inbound_message_id)
  values (l.id, v_site, p ->> 'status', p_source_ts, p_message)
  returning id into v_id;
  return jsonb_build_object('lotId', l.id, 'status', p ->> 'status', 'statusId', v_id);
end
$$;
revoke all on function site.apply_wms_lot_status(jsonb, uuid, timestamptz) from public;

create function site.erp_lot_status_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  f      jsonb;
  v_code text;
  v_held site.erp_lot_status;
begin
  f := platform.mirror_fresh_or_raise('ERP_LOT_STATUS');
  if f ->> 'mode' <> 'MIRROR' then
    return null;
  end if;
  select lot_code into v_code from site.material_lot where id = p_lot;
  v_held := site.erp_lot_status_latest(p_lot);
  if v_held.id is null then
    return format('the WMS has not reported a status for lot %s; with the lot status mirrored from the WMS a lot is issued only when the WMS holds it RELEASED (INV-26)', v_code);
  end if;
  if v_held.status <> 'RELEASED' then
    return format('the WMS holds lot %s as %s (reported at %s); a lot is issued only when the WMS holds it RELEASED (INV-26)', v_code, v_held.status,
                  site.utc_text(v_held.source_timestamp));
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The outbound queue
-- ---------------------------------------------------------------------------------------------

create table site.erp_outbound_message (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null check (topic in ('erp.stock_block', 'erp.lot_status', 'erp.goods_issue', 'erp.yield')),
  lot_id      uuid not null references site.material_lot (id),
  source_ref  text not null unique check (source_ref ~ '^[a-z_]+:[!-~]{1,200}$'),
  payload     jsonb not null check (jsonb_typeof(payload) = 'object'),
  xact_id     xid8 not null default pg_current_xact_id(),
  created_at  timestamptz not null default clock_timestamp()
);
create index erp_outbound_message_order on site.erp_outbound_message (created_at, id);
revoke all on site.erp_outbound_message from public;
select platform.enforce_db_time('site.erp_outbound_message', array['created_at']);

create table site.erp_outbound_delivery (
  message_id     uuid primary key references site.erp_outbound_message (id),
  adapter_id     uuid not null references iam.integration_adapter (id),
  adapter_code   text not null,
  topic          text not null,
  lot_id         uuid not null,
  erp_reference  text not null check (erp_reference ~ '^[!-~]{1,128}$'),
  delivered_at   timestamptz not null default clock_timestamp()
);
revoke all on site.erp_outbound_delivery from public;
select platform.enforce_db_time('site.erp_outbound_delivery', array['delivered_at']);
select kernel.register_audited_table('site.erp_outbound_delivery', 'integration_adapter', 'adapter_code', true);

create table site.erp_outbound_attempt (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references site.erp_outbound_message (id),
  attempt_no   integer not null check (attempt_no >= 1),
  error        text not null check (btrim(error) <> ''),
  alarm_id     uuid references platform.integration_alarm (id),
  failed_at    timestamptz not null default clock_timestamp(),
  unique (message_id, attempt_no)
);
revoke all on site.erp_outbound_attempt from public;
select platform.enforce_db_time('site.erp_outbound_attempt', array['failed_at']);

-- Owner only: one message per fact (a second enqueue of the same fact is nothing).
create function site.enqueue_erp_outbound(p_topic text, p_lot uuid, p_source_ref text, p_payload jsonb) returns void
language sql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
  insert into site.erp_outbound_message (topic, lot_id, source_ref, payload) values (p_topic, p_lot, p_source_ref, p_payload)
  on conflict (source_ref) do nothing
$$;
revoke all on function site.enqueue_erp_outbound(text, uuid, text, jsonb) from public;

create function site.erp_outbound_from_fact() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  l site.material_lot;
begin
  if tg_table_name = 'erp_stock_block_request' then
    select * into l from site.material_lot where id = new.lot_id;
    perform site.enqueue_erp_outbound('erp.stock_block', l.id, 'stock_block:' || new.id::text,
      jsonb_build_object('requestId', new.id, 'lotNumber', l.lot_code, 'kind', new.kind, 'causeKey', new.cause_key));
  elsif tg_table_name = 'lot_state_entry' then
    select * into l from site.material_lot where id = new.lot_id;
    perform site.enqueue_erp_outbound('erp.lot_status', l.id, 'lot_status:' || l.id::text || '/' || new.state_version::text,
      jsonb_build_object('lotNumber', l.lot_code, 'status', new.state, 'stateVersion', new.state_version::text));
  elsif tg_table_name = 'lot_consumption' then
    select * into l from site.material_lot where id = new.lot_id;
    perform site.enqueue_erp_outbound('erp.goods_issue', l.id, 'goods_issue:' || new.id::text,
      jsonb_build_object('consumptionId', new.id, 'lotNumber', l.lot_code, 'materialCode', new.material_code, 'batchNumber', new.batch_number,
                         'quantity', jsonb_build_object('value', new.quantity::text, 'unit', new.unit)));
  elsif tg_table_name = 'finished_lot' then
    select * into l from site.material_lot where id = new.lot_id;
    perform site.enqueue_erp_outbound('erp.yield', l.id, 'yield:' || l.id::text,
      jsonb_build_object('lotNumber', l.lot_code, 'batchNumber', new.batch_number, 'productCode', new.product_code, 'strength', new.strength,
                         'quantity', jsonb_build_object('value', l.received_quantity::text, 'unit', l.unit)));
  end if;
  return null;
end
$$;

create trigger zz_erp_outbound after insert on site.erp_stock_block_request for each row execute function site.erp_outbound_from_fact();
create trigger zz_erp_outbound after insert on site.lot_state_entry for each row execute function site.erp_outbound_from_fact();
create trigger zz_erp_outbound after insert on site.lot_consumption for each row execute function site.erp_outbound_from_fact();
create trigger zz_erp_outbound after insert on site.finished_lot for each row execute function site.erp_outbound_from_fact();

-- The calling ERP_WMS adapter (EBMR-INT-002 from the kernel when the actor is none; EBMR-ERP-010 for another system).
create function site.require_erp_wms_adapter() returns iam.integration_adapter
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  v_ad iam.integration_adapter;
begin
  perform platform.require_actor();
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  if v_ad.source_system <> 'ERP_WMS' then
    raise exception using errcode = 'P0001', message = format('EBMR-ERP-010 adapter %s speaks for %s; ERP/WMS messages are the ERP_WMS adapter''s', v_ad.code, v_ad.source_system);
  end if;
  return v_ad;
end
$$;
revoke all on function site.require_erp_wms_adapter() from public;

-- The pending messages, oldest first: [{messageId, topic, lotId, payload, attempts, createdAtUs}].
create function site.erp_outbound_pending(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
begin
  perform site.require_erp_wms_adapter();
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

-- The ERP acknowledged a message: true the first time, false for a repeated acknowledgment.
create function site.erp_outbound_delivered(p_message uuid, p_erp_reference text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_ad   iam.integration_adapter := site.require_erp_wms_adapter();
  m      site.erp_outbound_message;
  v_done integer;
begin
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

-- A delivery attempt failed (transport): recorded, the message stays pending; the first failure raises an alarm.
create function site.erp_outbound_failed(p_message uuid, p_error text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  v_ad    iam.integration_adapter := site.require_erp_wms_adapter();
  m       site.erp_outbound_message;
  v_no    integer;
  v_alarm uuid;
begin
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

grant select on site.erp_lot_status, site.erp_outbound_message, site.erp_outbound_delivery, site.erp_outbound_attempt to ebmr_app;
grant execute on function site.erp_lot_status_latest(uuid), site.erp_lot_status_problem(uuid), site.erp_outbound_pending(integer),
                          site.erp_outbound_delivered(uuid, text), site.erp_outbound_failed(uuid, text)
  to ebmr_app;

reset role;
