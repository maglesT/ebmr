-- Site services: stock locations of the WMS and the segregation rule (Phase 6 slice 6a, builder A; PR-46 clause 2;
-- D-P6a-7, D-P6a-A-7).
--
-- Handbook: modules/site-services.md
--
--   site.location_move_problem(lot, location_kind)  NULL when the lot may be moved to a location of that kind, else
--                    why not. The WMS adapter asks it before a move (the WMS waits for the answer). Kinds: QUARANTINE,
--                    RELEASED (released stock), PRODUCTION (issued to the floor), REJECTED (the restricted area for
--                    rejected and recalled stock) and RETURNS (return to supplier or returned goods). The rule, by the
--                    lot's eBMR status and dates:
--                      RELEASED or RELEASED_FOR_FURTHER_PROCESSING, within retest and expiry   any kind
--                      QUARANTINE, ON_HOLD, or released but past its retest or expiry          QUARANTINE, REJECTED, RETURNS
--                      REJECTED, RECALLED                                                       REJECTED, RETURNS
--                      CONSUMED, DESTROYED, RETURNED                                           none (no stock left here)
--                    and never anywhere but QUARANTINE, REJECTED or RETURNS while the lot has an open location exception.
--   site.lot_location_move        every move the WMS reported (insert-only, audited on the lot): from, to, the kind of
--                    the destination, the quantity as sent (decimal text and unit), the WMS time, the inbound message,
--                    and the rule it broke, if any.
--   site.lot_location_exception   a move that already happened against the rule (it cannot be refused after the fact):
--                    raised with an integration alarm in the same transaction (D-P6a-7). While open, the lot is blocked
--                    in the eBMR: its release and its issue are refused (EBMR-SITE-920).
--   site.lot_location_exception_resolution  QA closes the exception (MATERIAL.QA_DISPOSITION) only with a deviation
--                    linked to the lot (the deviation candidate investigated) and a note.
--   site.apply_wms_stock_move(payload, message)  owner only: the WMS adapter's receiving command (0913) records a move.
--
-- Messages: EBMR-SITE-919 to EBMR-SITE-921; EBMR-ERP-002 (unknown lot), EBMR-ERP-003 (unit).

set local role ebmr_owner;

create table site.lot_location_move (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null references site.material_lot (id),
  site_code           text not null,
  from_location       text not null check (from_location ~ '^[!-~]{1,64}$'),
  to_location         text not null check (to_location ~ '^[!-~]{1,64}$'),
  to_kind             text not null check (to_kind in ('QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS')),
  quantity_value      text not null check (quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  quantity_unit       text not null check (quantity_unit ~ '^[!-~]{1,32}$'),
  moved_at            timestamptz not null,
  inbound_message_id  uuid not null references platform.inbound_message (id),
  lot_state           text not null,
  problem             text check (problem is null or btrim(problem) <> ''),
  recorded_at         timestamptz not null default clock_timestamp()
);
create index lot_location_move_lot on site.lot_location_move (lot_id, moved_at, recorded_at);
revoke all on site.lot_location_move from public;

create table site.lot_location_exception (
  id          uuid primary key default gen_random_uuid(),
  lot_id      uuid not null references site.material_lot (id),
  move_id     uuid not null unique references site.lot_location_move (id),
  problem     text not null check (btrim(problem) <> ''),
  alarm_id    uuid not null references platform.integration_alarm (id),
  raised_at   timestamptz not null default clock_timestamp()
);
create index lot_location_exception_lot on site.lot_location_exception (lot_id);
revoke all on site.lot_location_exception from public;

create table site.lot_location_exception_resolution (
  exception_id         uuid primary key references site.lot_location_exception (id),
  lot_id               uuid not null,
  deviation_id         uuid not null references site.deviation (id),
  note                 text not null check (btrim(note) <> ''),
  resolved_by_person   uuid not null,
  resolved_by_account  uuid not null,
  resolved_at          timestamptz not null default clock_timestamp()
);
revoke all on site.lot_location_exception_resolution from public;

select platform.enforce_db_time('site.lot_location_move', array['recorded_at']);
select platform.enforce_db_time('site.lot_location_exception', array['raised_at']);
select platform.enforce_db_time('site.lot_location_exception_resolution', array['resolved_at']);
select kernel.register_audited_table('site.lot_location_move', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_location_exception', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_location_exception_resolution', 'material_lot', 'lot_id', true);

-- The open location exception of a lot (the oldest), or NULL.
create function site.lot_open_location_exception(p_lot uuid) returns site.lot_location_exception
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select e.* from site.lot_location_exception e
   where e.lot_id = p_lot and not exists (select 1 from site.lot_location_exception_resolution r where r.exception_id = e.id)
   order by e.raised_at, e.id limit 1
$$;

-- The location the WMS last reported for the lot ({location, kind, movedAtUs}), or NULL.
create function site.lot_current_location(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
  select jsonb_build_object('location', m.to_location, 'kind', m.to_kind, 'movedAtUs', platform.timestamptz_to_epoch_us(m.moved_at))
    from site.lot_location_move m where m.lot_id = p_lot order by m.moved_at desc, m.recorded_at desc limit 1
$$;

create function site.location_move_problem(p_lot uuid, p_location_kind text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
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

-- Records one move the WMS reported (owner only; the adapter's receiving command, 0913). payload: wms.stock_move v1
-- {lotNumber, fromLocation, toLocation, toLocationKind, quantity {value, unit}, movedAt (epoch microseconds text)}.
-- A move that broke the rule is recorded with an alarm and an exception linked to the lot (D-P6a-7), never refused:
-- it already happened.
create function site.apply_wms_stock_move(p jsonb, p_message uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, iam, pg_temp as $$
declare
  v_site  text := site.actor_site();
  v_ad    iam.integration_adapter := iam.current_integration_adapter();
  l       site.material_lot;
  v_prob  text;
  v_move  uuid;
  v_alarm uuid;
  v_exc   uuid;
begin
  select * into l from site.material_lot where site_code = v_site and lot_code = p ->> 'lotNumber';
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-002 the WMS moved lot %s, which site %s does not hold (DI-31: wrong identity)', p ->> 'lotNumber', v_site);
  end if;
  perform site.lock_lot(l.id);
  if p -> 'quantity' ->> 'unit' is distinct from l.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ERP-003 the WMS moved lot %s in %s; the lot is stocked in %s (DI-31)', l.lot_code, p -> 'quantity' ->> 'unit', l.unit);
  end if;
  v_prob := site.location_move_problem(l.id, p ->> 'toLocationKind');
  insert into site.lot_location_move (lot_id, site_code, from_location, to_location, to_kind, quantity_value, quantity_unit, moved_at,
                                      inbound_message_id, lot_state, problem)
  values (l.id, v_site, p ->> 'fromLocation', p ->> 'toLocation', p ->> 'toLocationKind', p -> 'quantity' ->> 'value', p -> 'quantity' ->> 'unit',
          platform.epoch_us_to_timestamptz(p ->> 'movedAt'), p_message, site.lot_state(l.id), v_prob)
  returning id into v_move;
  if v_prob is not null then
    v_alarm := platform.raise_integration_alarm(v_ad, 'OUT_OF_RANGE', 'MAJOR', p_message,
      jsonb_build_object('rule', 'PR-46', 'lotId', l.id, 'lotCode', l.lot_code, 'toLocation', p ->> 'toLocation',
                         'toLocationKind', p ->> 'toLocationKind', 'problem', v_prob));
    insert into site.lot_location_exception (lot_id, move_id, problem, alarm_id) values (l.id, v_move, v_prob, v_alarm) returning id into v_exc;
  end if;
  return jsonb_build_object('moveId', v_move, 'lotId', l.id, 'problem', v_prob, 'exceptionId', v_exc, 'alarmId', v_alarm);
end
$$;
revoke all on function site.apply_wms_stock_move(jsonb, uuid) from public;

-- QA closes a location exception with the deviation linked to the lot that investigated it.
create function site.resolve_lot_location_exception(p_exception uuid, p_deviation uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  e     site.lot_location_exception;
  l     site.material_lot;
begin
  perform iam.assert_not_administrator();
  select * into e from site.lot_location_exception where id = p_exception;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-921 unknown location exception %s', p_exception);
  end if;
  l := site.lock_lot(e.lot_id);
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', l.site_code));
  if exists (select 1 from site.lot_location_exception_resolution r where r.exception_id = e.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-921 the location exception is already closed';
  end if;
  if not exists (select 1 from site.deviation_link k where k.deviation_id = p_deviation and k.subject_kind = 'LOT' and k.subject_id = e.lot_id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-921 a location exception of lot %s is closed with a deviation linked to the lot (PR-46, D-P6a-7)', l.lot_code);
  end if;
  if btrim(coalesce(p_note, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-921 closing a location exception states what was done';
  end if;
  insert into site.lot_location_exception_resolution (exception_id, lot_id, deviation_id, note, resolved_by_person, resolved_by_account)
  values (e.id, e.lot_id, p_deviation, p_note, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- While a location exception is open the lot is blocked: no release (and no issue, 0913).
create function site.lot_release_location_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_exc site.lot_location_exception;
begin
  if new.event in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING', 'UNHOLD', 'MANUFACTURER_RELEASE') then
    v_exc := site.lot_open_location_exception(new.lot_id);
    if v_exc.id is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-920 the lot is blocked by an open location exception (%s); QA closes it with a deviation first (PR-46, D-P6a-7)', v_exc.problem);
    end if;
  end if;
  return new;
end
$$;

create trigger zz_location_exception_open before insert on site.lot_status_command
  for each row execute function site.lot_release_location_check();

grant select on site.lot_location_move, site.lot_location_exception, site.lot_location_exception_resolution to ebmr_app;
grant execute on function site.location_move_problem(uuid, text), site.lot_current_location(uuid), site.lot_open_location_exception(uuid),
                          site.resolve_lot_location_exception(uuid, uuid, text)
  to ebmr_app;

reset role;
