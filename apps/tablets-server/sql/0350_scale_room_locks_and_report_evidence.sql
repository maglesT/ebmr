-- Tablets server, modules C3 with C5: a holder of the application role's database credentials can no longer make a
-- working scale count as unusable, and so open the manual-weighing path, by holding its room's lock, by cancelling
-- or ending the gateway's heartbeats or holding up their commands, by a heartbeat of its own that says OFFLINE, by a
-- report held uncommitted, by reading an old snapshot, or by keeping the gateway listener from putting what it receives
-- on record (round-4 verification of review finding P50 and its follow-up rounds; controls DI-17, DI-30, DI-31, DI-32,
-- PR-20; kernel 0970, 0980).
--
-- The problem. The gate of 0340 (tab.manual_weighing_check, tab.manual_weighing_scales, tab.scale_offline_reason_at)
-- counted evidence that the application role can produce or suppress:
--   * A missing heartbeat counted at once ('no heartbeat from the site gateway in the last 10 seconds'). Heartbeats and
--     the gate were serialised with the advisory lock 'tab.scale_room:<room>', and any role may take an advisory lock.
--     The gateway listener runs under the application role, which may cancel or end the backends of its own role. One
--     connection held the room's lock in shared mode, a second cancelled the heartbeats that queued behind it: the
--     gateway kept reporting its scale ONLINE, the scale read OFFLINE 10 seconds later, and a weight keyed by hand
--     through the honest server was accepted beside it. A heartbeat also waits for the live gateway session's row
--     (kernel.begin_command locks it), which the application role can hold with the actor it builds from iam.session.
--     0340's header said the gate takes a scale's status only from what other transactions reported; for a missing
--     heartbeat that was not so.
--   * A heartbeat saying OFFLINE, committed in its own transaction under the live gateway session's actor, opened the
--     path at once (open question X12, where the less strict route had been taken).
--   * A report that the gateway's API cannot be reached counted from its write (changed_at), so one held uncommitted
--     for 10 seconds under the monitor's live session counted as soon as it was committed (X11). And while a report
--     stood, the monitor's own write that the API answers again could be held up (its session row, the report's row).
--   * The gate read the reports through the weighing transaction's snapshot: under REPEATABLE READ or SERIALIZABLE a
--     snapshot taken before a scale came online again showed it silent.
--   * (Follow-up round 4.) Once the receipts below existed, the gate took the absence of a receipt as proof of silence,
--     and the absence of an answer as proof that the API stayed unreachable. But a receipt or an answer is written only
--     if the database takes it in time: one held past its statement's limit (a loaded database) or with no connection to
--     be had is lost, and nothing told the gate so. The listener logged in with the application role, whose holder can
--     load the database and take its free connections (no role had a connection limit), so the manual path could still
--     open beside a working scale (decisions X21, X32 of round 3).
--
-- Now:
-- 1. Room locks are rows of tab.scale_room_lock (one per room), which the application role can neither read nor lock
--    (no privilege at all; SELECT ... FOR UPDATE and LOCK TABLE need privileges, advisory locks need none). The
--    definer functions add a room's row when it is missing. tab.record_heartbeat and tab.lock_gateway_rooms take the
--    rows FOR UPDATE in room order (tab.lock_scale_rooms); the gate takes its room's row FOR SHARE NOWAIT and refuses
--    (EBMR-EXE-074, 'reporting its status') when it cannot. No advisory lock is used for scales any more.
-- 2. Kernel 0970 takes pg_cancel_backend and pg_terminate_backend away from every role but superusers. The gate refuses
--    every weight keyed by hand while kernel.backend_signals_restricted() answers false (the policy lost, e.g. by a
--    restore), since the site gateway's reports could then be silenced.
-- 3. What the gateway sends is on record before any lock wait: the listener first hands every heartbeat to
--    tab.record_heartbeat_receipt(token hash, heartbeat), outside any command, on a pool of its own that logs in with the
--    listener's own role (kernel 0980: ebmr_listener, in a sandbox ebmr_sandbox_listener; DevicesRuntime.receipts). The
--    function takes no lock anyone can hold: it reads the gateway session behind the token hash (whatever the
--    session's state), inserts one row into tab.heartbeat_receipt (insert-only, no foreign key, uuid key, owner-only)
--    with the instruments as the heartbeat names them, and prunes rows older than an hour with SKIP LOCKED. That pool
--    is apart from the browser routes' pool and from the one the heartbeats' commands run on (the application role),
--    whose waits and statements end within 4 seconds each (each one, not a command as a whole); the listener answers
--    every heartbeat within 3 seconds whatever holds up its command, so the gateway's next one arrives within the
--    heartbeat window (decisions X29, X30). It is received only if its receipt is written within the receipts pool's
--    own limits (1 s for a connection, 2 s for the statement); one that is not is lost, and the listener says so (6).
--    The gate counts, and only over a window the listener has vouched for (6):
--      * a missing heartbeat only when no heartbeat naming the scale was received since the window's start; a
--        heartbeat received and not recorded (held up, cut off, refused) is no proof that the scale cannot be used;
--      * a scale the gateway never reported (UNKNOWN) only when no heartbeat naming it was received in that window;
--      * a heartbeat state that is not ONLINE (OFFLINE, CONNECTING, a serial mismatch, not ready) only when it has been
--        recorded since before 10 seconds before the weighing's transaction began, without a break
--        (tab.instrument_heartbeat.offline_since, new: the database time of the first recorded heartbeat of the key
--        since it last recorded the instrument ONLINE, ready and with its registered serial), and no heartbeat received
--        in the window reported the scale so. This is route (a) of X12, and stricter: after every disconnect the manual
--        path opens once the scale has been recorded not online for 10 seconds, as it already did after the gateway
--        fell silent; and a gateway that says a scale is not ready because the database held up its upload (it cannot
--        tell that from a real failure) has retried within that time.
--    A receipt proves nothing against a scale, it only keeps the manual path shut, and only the listener's role may
--    write one (the application role no longer may).
-- 4. The report that the server cannot reach a gateway's API counts from when another transaction first saw it
--    committed, not from its write: tab.gateway_api_contact.seen_at (new) is stamped by the next heartbeat receipt
--    (with SKIP LOCKED, so a report held locked is simply not seen yet; never in the transaction that last wrote it,
--    tab.gateway_api_contact.written_xact, new), and a change of state clears it. And it counts only while the
--    gateway's API has not answered the server since the report was made, and only over a window the listener has
--    vouched for (6): the server records each answer of its probes first in tab.gateway_api_answer
--    (tab.record_gateway_api_answer, on the receipts pool, outside any command, insert-only, the same rules as the
--    receipts) and only then records the API reachable in the monitor's command, which can be held up (a probe does
--    not wait for it). While the report stands each heartbeat receipt asks the server to probe the API (probeApi), so
--    a false report is answered within a heartbeat or two.
-- 5. The gate reads the reports as committed when the weighing is written: it refuses a weight keyed by hand in a
--    transaction that is not READ COMMITTED (EBMR-EXE-074).
-- 6. (Follow-up round 4.) The gate fails closed when the listener cannot put its evidence on record. Every 500 ms the
--    listener writes a tick on its kept connections (tab.record_listener_tick, which only the listener's role may call):
--    the database time of the tick, and whether everything it received since its previous tick was put on record, a
--    heartbeat's receipt (or a request that was no gateway's heartbeat) and an API answer alike. A receipt or answer
--    that failed, timed out or was never tried, or a heartbeat refused before its receipt (a changed time zone), makes
--    that tick unclean; a tick waits for what arrived before it to be settled. A window is vouched for
--    (tab.listener_attested_from) when the listener's latest closed tick is at most 2 seconds old and its ticks are
--    clean without a break from at or before the window's start: the start is 10 seconds before the weighing's
--    transaction began, or 10 seconds before that tick when that is earlier, so the vouched silence always spans a full
--    10 seconds. Another listener that ticked in the window makes it unknown which one the gateway reached: not
--    vouched for. Where the gate would count the gateway's silence, a scale never reported, a state that is not ONLINE
--    or an unanswered API report over a window nobody vouched for, it refuses instead (EBMR-EXE-074, why UNATTESTED):
--    a denial of the fallback, never a weight beside a working scale. The registry and a refused reading of the chain
--    still count as before (each is something on record, not an absence).
-- A scale counts as unusable when any one of its reasons counts (the registry, the gateway's silence or state, the
-- API report, a refused reading of its chain held since before the window); tab.manual_weighing_basis records it as
-- before. tab.scale_status (what the screen shows and the capture follows) is unchanged: every report counts there at
-- once.
--
-- Defaults and what stays open: docs/decisions/phase-2-open-questions.md X15-X21, X29-X32 and X36-X39. A receipt or an
-- answer written by someone other than the listener or the server could only keep the manual path shut, and now only the
-- listener's role may write either. A database too loaded to take the listener's evidence in time, or the listener's
-- connections taken, now keeps the manual path shut (no clean ticks) instead of opening it; the server logs a lost
-- answer and a lost idle connection at warn (X32). What remains is a denial of the fallback: whoever can load the
-- database or take its connections can keep a scale from being keyed by hand, and the listener's role, its credentials
-- and the cluster's connection settings are the operator's to keep (X36-X39). Administration acts on the registry and
-- the site's time zone are out of scope as in 0310.
--
-- Privileges: every function is SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016). CREATE OR REPLACE
-- keeps the owner, search_path and grants of tab.lock_gateway_rooms (none), tab.record_gateway_api_contact (EXECUTE for
-- ebmr_app), tab.record_heartbeat (EXECUTE for ebmr_app), tab.manual_weighing_scales (none) and
-- tab.manual_weighing_check (none). The listener's role ebmr_listener (kernel 0980; mirrored to ebmr_sandbox_listener
-- in a sandbox) gains USAGE on the schemas tab and iam and EXECUTE on tab.record_heartbeat_receipt,
-- tab.record_gateway_api_answer, tab.record_listener_tick, tab.resolve_gateway_session and iam.policy_text, and
-- nothing else; ebmr_app may not call the first three. The new tables and helpers are granted to nobody.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. Room locks the application role cannot take
-- ---------------------------------------------------------------------------------------------

-- One row per room with a scale; locked, never updated. Owner-only.
create table tab.scale_room_lock (
  room_code  text primary key check (btrim(room_code) <> '')
);
revoke all on tab.scale_room_lock from public;
insert into tab.scale_room_lock (room_code) select distinct room_code from iam.device where room_code is not null and btrim(room_code) <> '';

-- The rooms p_rooms, locked exclusively in room order to the commit (their rows are added when missing).
create function tab.lock_scale_rooms(p_rooms text[]) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  insert into tab.scale_room_lock (room_code)
  select distinct r from unnest(p_rooms) r where r is not null and btrim(r) <> ''
  on conflict do nothing;
  perform 1 from tab.scale_room_lock where room_code = any (p_rooms) order by room_code for update;
end
$$;

-- As 0320: before a write that may turn the scales of gateway key p_key ONLINE, the locks of every room of an
-- instrument bound to the key; now rows of tab.scale_room_lock instead of advisory locks.
create or replace function tab.lock_gateway_rooms(p_key uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
begin
  perform tab.lock_scale_rooms(array(
    select distinct d.room_code
      from tab.gateway_instrument b join iam.device d on d.id = b.instrument_device_id
     where b.gateway_key_id = p_key and b.ended_at is null and d.room_code is not null));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. What the gateway sent, received before anything that can wait
-- ---------------------------------------------------------------------------------------------

-- Every heartbeat the listener received with the bearer token of a session of an ACTIVE gateway key, recorded or not.
-- Operational evidence, not GMP data: insert-only for everyone but the pruning below; no foreign key, so an insert
-- never waits on the key's row.
create table tab.heartbeat_receipt (
  id              uuid primary key default gen_random_uuid(),
  gateway_key_id  uuid not null,
  received_at     timestamptz not null default clock_timestamp(),
  -- [{deviceCode, state, serial, notReady}] as the heartbeat named them (at most 200, strings bounded).
  devices         jsonb not null check (jsonb_typeof(devices) = 'array')
);
revoke all on tab.heartbeat_receipt from public;
create index heartbeat_receipt_key_time on tab.heartbeat_receipt (gateway_key_id, received_at);

-- Every answer the server got from a gateway's API to a probe of GET /v1/health, recorded before the monitor records
-- the API reachable. Same rules as tab.heartbeat_receipt.
create table tab.gateway_api_answer (
  id              uuid primary key default gen_random_uuid(),
  gateway_key_id  uuid not null,
  answered_at     timestamptz not null default clock_timestamp(),
  detail          text not null check (btrim(detail) <> '' and length(detail) <= 500)
);
revoke all on tab.gateway_api_answer from public;
create index gateway_api_answer_key_time on tab.gateway_api_answer (gateway_key_id, answered_at);

-- 6. The listener's ticks: per run of the listener (watch_id, a random uuid the process draws at start), one row every
-- 500 ms in order (seq from 1, no gap). Each row is opened at the database time ticked_at and closed by the next tick,
-- which sets clean: whether everything the listener received from the previous tick's answer to this one's answer was
-- put on record. Null while it is the run's latest row. Owner-only; written only by tab.record_listener_tick.
create table tab.listener_tick (
  watch_id   uuid not null,
  seq        integer not null check (seq > 0),
  ticked_at  timestamptz not null default clock_timestamp(),
  clean      boolean,
  primary key (watch_id, seq)
);
revoke all on tab.listener_tick from public;
create index listener_tick_time on tab.listener_tick (ticked_at);

-- 4. The report that the API cannot be reached: when another transaction first saw it committed, and who wrote it.
alter table tab.gateway_api_contact add column seen_at timestamptz;
alter table tab.gateway_api_contact add column written_xact xid8;

-- 3. Since when the key's recorded heartbeats have not said ONLINE (ready, registered serial): the database time of the
-- first of them after the last ONLINE one; null while ONLINE, or for a row written before this migration.
alter table tab.instrument_heartbeat add column offline_since timestamptz;

-- Stamps seen_at on gateway key p_key's report that its API cannot be reached, when a transaction other than the one
-- that last wrote it sees it committed and nobody holds its row (SKIP LOCKED: never waits).
create function tab.note_contact_seen(p_key uuid) returns void
language sql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
  update tab.gateway_api_contact c set seen_at = clock_timestamp()
   where c.gateway_key_id = (select x.gateway_key_id from tab.gateway_api_contact x
                              where x.gateway_key_id = p_key and not x.reachable and x.seen_at is null
                                and x.written_xact is distinct from pg_current_xact_id()
                              for update skip locked)
$$;

-- The listener's first step for every heartbeat, outside any command: records that the gateway of the session behind
-- the bearer token whose SHA-256 is p_token_hash sent heartbeat p_heartbeat (whatever the session's state; nothing for
-- an unknown token or a key that is not ACTIVE), stamps the gateway's API report seen, and answers whether the server
-- should probe the gateway's API. Takes no lock anyone else can hold.
create function tab.record_heartbeat_receipt(p_token_hash text, p_heartbeat jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_key     uuid;
  v_devices jsonb;
begin
  select b.gateway_key_id into v_key
    from tab.gateway_session b join tab.gateway_key k on k.id = b.gateway_key_id and k.status = 'ACTIVE'
   where b.token_hash = p_token_hash;
  if v_key is null then
    return jsonb_build_object('received', false, 'probeApi', false);
  end if;
  v_devices := coalesce((
    select jsonb_agg(jsonb_build_object(
             'deviceCode', left(x ->> 'deviceCode', 64),
             'state', case when jsonb_typeof(x -> 'state') = 'string' then left(x ->> 'state', 32) end,
             'serial', case when jsonb_typeof(x -> 'serial') = 'string' then left(x ->> 'serial', 64) end,
             'notReady', case when jsonb_typeof(x -> 'notReady') = 'string' and btrim(x ->> 'notReady') <> ''
                              then left(btrim(x ->> 'notReady'), 500) end))
      from (select e.x from jsonb_array_elements(case when jsonb_typeof(p_heartbeat -> 'devices') = 'array'
                                                      then p_heartbeat -> 'devices' else '[]'::jsonb end) e(x)
             where jsonb_typeof(e.x) = 'object' and jsonb_typeof(e.x -> 'deviceCode') = 'string'
             limit 200) s), '[]'::jsonb);
  insert into tab.heartbeat_receipt (gateway_key_id, devices) values (v_key, v_devices);
  perform tab.note_contact_seen(v_key);
  delete from tab.heartbeat_receipt r
   where r.id in (select x.id from tab.heartbeat_receipt x
                   where x.gateway_key_id = v_key and x.received_at < clock_timestamp() - interval '1 hour'
                   limit 1000 for update skip locked);
  return jsonb_build_object('received', true,
                            'probeApi', exists (select 1 from tab.gateway_api_contact c where c.gateway_key_id = v_key and not c.reachable));
end
$$;

-- The server's record, outside any command, that the API of gateway p_gateway_code (its ACTIVE key) answered it
-- (p_detail: what answered). True when recorded. Takes no lock anyone else can hold.
create function tab.record_gateway_api_answer(p_gateway_code text, p_detail text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_key uuid;
begin
  select k.id into v_key from tab.gateway_key k where k.gateway_code = p_gateway_code and k.status = 'ACTIVE';
  if v_key is null then
    return false;
  end if;
  insert into tab.gateway_api_answer (gateway_key_id, detail)
  values (v_key, left(coalesce(nullif(btrim(p_detail), ''), 'the gateway API answered'), 500));
  delete from tab.gateway_api_answer a
   where a.id in (select x.id from tab.gateway_api_answer x
                   where x.gateway_key_id = v_key and x.answered_at < clock_timestamp() - interval '1 hour'
                   limit 1000 for update skip locked);
  return true;
end
$$;

-- 6. The listener's tick (its role only): closes run p_watch's latest row with p_clean (whether everything the listener
-- received since that row's tick was put on record; null counts as not) and opens the next one at the database's time.
-- Answers {seq, tickedAtUs}. Prunes rows older than an hour with SKIP LOCKED.
create function tab.record_listener_tick(p_watch uuid, p_clean boolean) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_last integer;
  v_seq  integer;
  v_at   timestamptz;
begin
  if p_watch is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-075 a tick of the gateway listener names the run it belongs to';
  end if;
  select max(t.seq) into v_last from tab.listener_tick t where t.watch_id = p_watch;
  if v_last is not null then
    update tab.listener_tick set clean = coalesce(p_clean, false) where watch_id = p_watch and seq = v_last and clean is null;
  end if;
  insert into tab.listener_tick (watch_id, seq) values (p_watch, coalesce(v_last, 0) + 1)
  returning seq, ticked_at into v_seq, v_at;
  delete from tab.listener_tick x
   where (x.watch_id, x.seq) in (select y.watch_id, y.seq from tab.listener_tick y
                                  where y.ticked_at < clock_timestamp() - interval '1 hour'
                                  limit 1000 for update skip locked);
  return jsonb_build_object('seq', v_seq, 'tickedAtUs', platform.epoch_micros(v_at)::text);
end
$$;

-- 6. The start of the window the listener vouches for, for a gate whose own window starts at p_from (10 seconds before
-- the weighing's transaction began), or null when it vouches for none: the latest run's latest closed tick (n) is at
-- most 2 seconds old; the start is p_from, or 10 seconds before tick n when that is earlier; the run's ticks from the
-- last one at or before the start through n are all clean, with no gap; and no other run ticked since the start.
create function tab.listener_attested_from(p_from timestamptz) returns timestamptz
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_watch uuid;
  v_last  integer;
  v_to    timestamptz;
  v_from  timestamptz;
  v_first integer;
begin
  select t.watch_id into v_watch from tab.listener_tick t order by t.ticked_at desc limit 1;
  if v_watch is null then
    return null;
  end if;
  select max(t.seq) into v_last from tab.listener_tick t where t.watch_id = v_watch and t.clean is not null;
  if v_last is null then
    return null;
  end if;
  select t.ticked_at into v_to from tab.listener_tick t where t.watch_id = v_watch and t.seq = v_last;
  if v_to < clock_timestamp() - interval '2 seconds' then
    return null;
  end if;
  v_from := least(p_from, v_to - interval '10 seconds');
  select max(t.seq) into v_first from tab.listener_tick t where t.watch_id = v_watch and t.seq <= v_last and t.ticked_at <= v_from;
  if v_first is null
     or exists (select 1 from tab.listener_tick t where t.watch_id = v_watch and t.seq between v_first and v_last and t.clean is distinct from true)
     or (select count(*) from tab.listener_tick t where t.watch_id = v_watch and t.seq between v_first and v_last) <> v_last - v_first + 1
     or exists (select 1 from tab.listener_tick t where t.watch_id <> v_watch and t.ticked_at >= v_from) then
    return null;
  end if;
  return v_from;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The monitor's report keeps who wrote it and when it was first seen
-- ---------------------------------------------------------------------------------------------

-- As 0340, except that the row keeps the transaction that last wrote it (written_xact) and a change of state clears
-- seen_at (tab.note_contact_seen stamps it).
create or replace function tab.record_gateway_api_contact(p_gateway_code text, p_reachable boolean, p_detail text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_actor   jsonb := iam.require_permission('GATEWAY.API_CONTACT_RECORD', '{}'::jsonb);
  v_session uuid;
  v_key     tab.gateway_key%rowtype;
  v_prev    tab.gateway_api_contact%rowtype;
  v_detail  text;
begin
  perform iam.assert_not_administrator();
  v_session := (v_actor ->> 'session_id')::uuid;
  if p_reachable is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-074 a contact with the gateway API was either reached or not';
  end if;
  select * into v_key from tab.gateway_key where gateway_code = p_gateway_code and status = 'ACTIVE';
  if not found then
    return false;
  end if;
  v_detail := left(coalesce(nullif(btrim(p_detail), ''),
                            case when p_reachable then 'the gateway API answered' else 'the gateway API did not answer' end), 500);
  select * into v_prev from tab.gateway_api_contact where gateway_key_id = v_key.id for update;
  if p_reachable and (v_prev.gateway_key_id is null or v_prev.reachable) then
    return false;
  end if;
  -- PR-20, DI-30: reachable again turns the gateway's scales ONLINE; serialised with hand-keyed weighings (0310, 0350).
  if p_reachable then
    perform tab.lock_gateway_rooms(v_key.id);
  end if;
  insert into tab.gateway_api_contact (gateway_key_id, reachable, detail, observed_at, changed_at, seen_at, written_xact)
  values (v_key.id, p_reachable, v_detail, clock_timestamp(), clock_timestamp(), null, pg_current_xact_id())
  on conflict (gateway_key_id) do update
    set reachable = excluded.reachable, detail = excluded.detail, observed_at = excluded.observed_at,
        changed_at = case when tab.gateway_api_contact.reachable = excluded.reachable then tab.gateway_api_contact.changed_at
                          else excluded.changed_at end,
        seen_at = case when tab.gateway_api_contact.reachable = excluded.reachable then tab.gateway_api_contact.seen_at end,
        written_xact = excluded.written_xact;
  if not p_reachable and (v_prev.gateway_key_id is null or v_prev.reachable) then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-071', v_key.gateway_code, null, null, v_session,
      format('DI-30: the server cannot reach the API of gateway %s (%s); its instruments are shown OFFLINE, so weights may be keyed by hand with a second person''s check once this has lasted 10 seconds without an answer from the API, until the server reaches it again',
             v_key.gateway_code, v_detail),
      jsonb_build_object('detail', v_detail));
    perform kernel.audit_business_event('gateway_key:' || v_key.id,
      format('The server cannot reach the API of gateway %s (%s): its scales are shown offline', v_key.gateway_code, v_detail),
      jsonb_build_object('gateway_code', v_key.gateway_code, 'reachable', false, 'detail', v_detail, 'alarm', 'EBMR-DEV-071'));
  elsif p_reachable then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-072', v_key.gateway_code, null, null, v_session,
      format('DI-30: the server reaches the API of gateway %s again (%s); its instruments follow its heartbeats again', v_key.gateway_code, v_detail),
      jsonb_build_object('detail', v_detail, 'unreachable_since', v_prev.changed_at));
    perform kernel.audit_business_event('gateway_key:' || v_key.id,
      format('The server reaches the API of gateway %s again (%s): its scales follow their heartbeats again', v_key.gateway_code, v_detail),
      jsonb_build_object('gateway_code', v_key.gateway_code, 'reachable', true, 'detail', v_detail, 'alarm', 'EBMR-DEV-072',
                         'unreachable_since', v_prev.changed_at));
  end if;
  return true;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 1, 3. Heartbeats: room rows, and since when the instrument has not been recorded ONLINE
-- ---------------------------------------------------------------------------------------------

-- Heartbeat (INTEGRATION command, INTERFACE.WRITE): as 0340, except that the rooms are locked as rows of
-- tab.scale_room_lock, and the row keeps since when the key's heartbeats have not recorded the instrument ONLINE
-- (offline_since; set by the first other state, kept while the same key reports another, cleared by ONLINE).
create or replace function tab.record_heartbeat(p_heartbeat jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor     jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key       tab.gateway_key%rowtype;
  v_bind      tab.gateway_instrument%rowtype;
  v_prev      tab.instrument_heartbeat%rowtype;
  v_state     text;
  v_not_ready text;
  v_acked     text;
  v_delivered text;
  v_held      bigint;
  d           jsonb;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  perform tab.lock_scale_rooms(array(
    select distinct dv.room_code
      from jsonb_array_elements(coalesce(p_heartbeat -> 'devices', '[]'::jsonb)) x
      join tab.gateway_instrument b on b.gateway_key_id = v_key.id and b.device_code = x ->> 'deviceCode' and b.ended_at is null
      join iam.device dv on dv.id = b.instrument_device_id
     where dv.room_code is not null));
  -- DI-31: what the gateway knows the server to hold: its written watermark, or what the server acknowledged when the
  -- watermark could not be written (deliveredSeq), whichever is higher.
  v_acked := p_heartbeat #>> '{journal,ackedSeq}';
  v_delivered := p_heartbeat #>> '{journal,deliveredSeq}';
  v_held := greatest(case when v_acked ~ '^[0-9]{1,18}$' then v_acked::bigint end,
                     case when v_delivered ~ '^[0-9]{1,18}$' then v_delivered::bigint end);
  if v_held > (tab.chain_head(v_key.id) ->> 'seq')::bigint
     and not exists (select 1 from tab.device_alarm where code = 'EBMR-DEV-070' and gateway_code = v_key.gateway_code
                                                    and raised_at > clock_timestamp() - interval '1 minute') then
    perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-070', v_key.gateway_code, null, null, (v_actor ->> 'session_id')::uuid,
      format('DI-31: the gateway counts %s readings the server acknowledged, the server holds %s; the gateway must send the missing readings again',
             v_held, tab.chain_head(v_key.id) ->> 'seq'),
      p_heartbeat -> 'journal');
  end if;
  for d in select * from jsonb_array_elements(coalesce(p_heartbeat -> 'devices', '[]'::jsonb)) loop
    select * into v_bind from tab.gateway_instrument where gateway_key_id = v_key.id and device_code = d ->> 'deviceCode' and ended_at is null;
    if not found then
      perform tab.raise_device_alarm('UNKNOWN_INSTRUMENT', 'EBMR-DEV-046', v_key.gateway_code, d ->> 'deviceCode', null,
                                     (v_actor ->> 'session_id')::uuid, 'The gateway reports an instrument that is not bound to it', d);
      continue;
    end if;
    v_state := d ->> 'state';
    if v_state is null or v_state not in ('CONNECTING', 'ONLINE', 'OFFLINE', 'SERIAL_MISMATCH') then
      v_state := 'OFFLINE';
    end if;
    if v_state = 'ONLINE' and (d ->> 'serial') is distinct from v_bind.expected_serial then
      v_state := 'SERIAL_MISMATCH';
    end if;
    -- DI-30, PR-20: a connected instrument the gateway cannot capture from and deliver is not ONLINE, whatever state
    -- the entry names.
    v_not_ready := case when jsonb_typeof(d -> 'notReady') = 'string' and btrim(d ->> 'notReady') <> '' then left(btrim(d ->> 'notReady'), 500) end;
    if v_not_ready is not null and v_state = 'ONLINE' then
      v_state := 'OFFLINE';
    end if;
    select * into v_prev from tab.instrument_heartbeat where instrument_device_id = v_bind.instrument_device_id;
    if v_state = 'SERIAL_MISMATCH' and v_prev.state is distinct from 'SERIAL_MISMATCH' then
      perform tab.raise_device_alarm('SERIAL_MISMATCH', 'EBMR-DEV-048', v_key.gateway_code, v_bind.device_code, null,
        (v_actor ->> 'session_id')::uuid,
        format('DI-20: %s answers with serial %s, not the registered %s; it is refused until the registry or the instrument is corrected',
               v_bind.device_code, coalesce(d ->> 'serial', '(none)'), v_bind.expected_serial), d);
      perform iam.raise_alert('UNREGISTERED_DEVICE', 'HIGH', null, null, v_bind.instrument_device_id, null, (v_actor ->> 'session_id')::uuid,
        jsonb_build_object('reason', 'SERIAL_MISMATCH', 'device_code', v_bind.device_code, 'expected_serial', v_bind.expected_serial,
                           'reported_serial', d ->> 'serial', 'gateway', v_key.gateway_code));
    end if;
    if v_not_ready is not null and (v_prev.not_ready is null or v_prev.gateway_key_id is distinct from v_key.id) then
      perform tab.raise_device_alarm('GATEWAY_ALARM', 'EBMR-DEV-073', v_key.gateway_code, v_bind.device_code, null,
        (v_actor ->> 'session_id')::uuid,
        format('DI-30: gateway %s reports %s connected but unable to capture and deliver (%s); it is shown OFFLINE until the gateway reports it ready',
               v_key.gateway_code, v_bind.device_code, v_not_ready),
        jsonb_build_object('notReady', v_not_ready, 'state', d ->> 'state'));
    end if;
    insert into tab.instrument_heartbeat (instrument_device_id, gateway_key_id, state, serial, reported_at, not_ready, written_xact, offline_since)
    values (v_bind.instrument_device_id, v_key.id, v_state, d ->> 'serial', clock_timestamp(), v_not_ready, pg_current_xact_id(),
            case when v_state <> 'ONLINE' then clock_timestamp() end)
    on conflict (instrument_device_id) do update
      set gateway_key_id = excluded.gateway_key_id, state = excluded.state, serial = excluded.serial, reported_at = excluded.reported_at,
          not_ready = excluded.not_ready, written_xact = excluded.written_xact,
          offline_since = case when excluded.state = 'ONLINE' then null
                               when tab.instrument_heartbeat.gateway_key_id = excluded.gateway_key_id and tab.instrument_heartbeat.state <> 'ONLINE'
                                    and tab.instrument_heartbeat.offline_since is not null then tab.instrument_heartbeat.offline_since
                               else excluded.offline_since
                          end;
  end loop;
  return jsonb_build_object('serverTimeUs', platform.epoch_micros(clock_timestamp())::text, 'head', tab.chain_head(v_key.id),
                            'probeApi', exists (select 1 from tab.gateway_api_contact c where c.gateway_key_id = v_key.id and not c.reachable));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3, 4. Whether the gate may count a scale unusable
-- ---------------------------------------------------------------------------------------------

-- Whether the scale bound by p_bind (instrument p_device, gateway key p_key, last heartbeat h of that key, or null)
-- counts as unusable for the gate of a hand-keyed weighing whose window starts at p_from (the transaction's start
-- minus 10 seconds), given p_attested, the start of the window the gateway listener vouches for (6;
-- tab.listener_attested_from, at or before p_from; null when it vouches for none). Receipts count from p_attested (or
-- p_from). {status: OFFLINE or UNKNOWN, reason} when one reason counts; {status: ONLINE, why, detail} when none does,
-- where why names the first reason tab.scale_status shows that does not count (null when it shows none):
--   UNRECORDED  heartbeats naming it were received since the window's start but none recorded it for 10 seconds (or ever);
--   UNATTESTED  it would count (silent, never reported, recorded not ONLINE, or the API report unanswered), but the
--               listener does not vouch that what it received in the window is on record;
--   RECENT      its recorded state is not ONLINE, but not since before p_from, or a heartbeat received since the
--               window's start reported it ONLINE, ready and with its registered serial;
--   YOUNG       the API report, or a refused reading, stands but had not been seen (or raised) before p_from;
--   ANSWERED    the API report stands but the gateway's API answered the server after it was made.
create function tab.manual_path_verdict(p_key tab.gateway_key, p_bind tab.gateway_instrument, p_device iam.device,
                                        h tab.instrument_heartbeat, p_from timestamptz, p_attested timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_since   timestamptz := least(coalesce(p_attested, p_from), p_from);
  v_heard   boolean;
  v_claimed boolean;
  v_contact tab.gateway_api_contact%rowtype;
  v_state   text;
  v_api     text;
  v_why     text;
  v_detail  text;
  v_code    text;
begin
  select coalesce(bool_or(true), false),
         coalesce(bool_or(r.devices @> jsonb_build_array(jsonb_build_object('deviceCode', p_bind.device_code, 'state', 'ONLINE',
                                                                            'serial', p_bind.expected_serial, 'notReady', null))), false)
    into v_heard, v_claimed
    from tab.heartbeat_receipt r
   where r.gateway_key_id = p_key.id and r.received_at >= v_since
     and r.devices @> jsonb_build_array(jsonb_build_object('deviceCode', p_bind.device_code));

  -- The gateway's side, in the order tab.scale_offline_reason shows it. Each absence counts only over a window the
  -- listener vouches for (6).
  if h.instrument_device_id is null and not v_heard and p_attested is not null then
    return jsonb_build_object('status', 'UNKNOWN', 'reason', 'the site gateway has not reported it yet');
  end if;
  if p_device.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'OFFLINE', 'reason', format('%s is %s in the device registry', p_device.code, p_device.status));
  end if;
  if h.instrument_device_id is null then
    v_why := case when v_heard then 'UNRECORDED' else 'UNATTESTED' end;
  elsif clock_timestamp() - h.reported_at > interval '10 seconds' then
    if v_heard then
      v_why := 'UNRECORDED';
    elsif p_attested is null then
      v_why := 'UNATTESTED';
    else
      return jsonb_build_object('status', 'OFFLINE', 'reason', 'no heartbeat from the site gateway in the last 10 seconds');
    end if;
  else
    v_state := case
      when h.state = 'SERIAL_MISMATCH' or (h.state = 'ONLINE' and h.serial is distinct from p_bind.expected_serial)
        then format('it answers with serial %s, not the registered %s', coalesce(h.serial, '(none)'), p_bind.expected_serial)
      when h.state <> 'ONLINE'
        then coalesce('the site gateway cannot capture from it and deliver: ' || h.not_ready, format('the site gateway reports it %s', h.state))
    end;
    if v_state is not null then
      if not v_claimed and h.offline_since < p_from then
        if p_attested is not null then
          return jsonb_build_object('status', 'OFFLINE', 'reason', v_state);
        end if;
        v_why := 'UNATTESTED';
      else
        v_why := 'RECENT';
      end if;
    end if;
  end if;

  -- The server's side (P51): counted only when seen by another transaction before p_from and unanswered since made,
  -- over a window the listener vouches for (its answers are among what it puts on record).
  select * into v_contact from tab.gateway_api_contact where gateway_key_id = p_key.id;
  if found and not v_contact.reachable then
    v_api := format('the server cannot reach the site gateway''s API (%s)', v_contact.detail);
    if exists (select 1 from tab.gateway_api_answer a where a.gateway_key_id = p_key.id and a.answered_at > v_contact.changed_at) then
      if v_why is null then
        v_why := 'ANSWERED';
        v_detail := v_api;
      end if;
    elsif v_contact.seen_at is null or v_contact.seen_at >= p_from then
      if v_why is null then
        v_why := 'YOUNG';
        v_detail := v_api;
      end if;
    elsif p_attested is null then
      if v_why is null then
        v_why := 'UNATTESTED';
        v_detail := v_api;
      end if;
    else
      return jsonb_build_object('status', 'OFFLINE', 'reason', v_api);
    end if;
  end if;
  if tab.chain_refusal_held(p_key.id, p_from) then
    select a.code into v_code from tab.device_alarm a
     where a.kind = 'READING_REFUSED'
       and a.session_id in (select s.session_id from tab.gateway_session s where s.gateway_key_id = p_key.id)
       and a.raised_at < p_from
     order by a.id desc limit 1;
    return jsonb_build_object('status', 'OFFLINE',
      'reason', format('the server refused a reading of gateway %s (%s) and has received none since, so no capture can reach it', p_key.gateway_code, v_code));
  end if;
  if v_why is null and tab.chain_refusal_pending(p_key.id) then
    select a.code into v_code from tab.device_alarm a
     where a.kind = 'READING_REFUSED'
       and a.session_id in (select s.session_id from tab.gateway_session s where s.gateway_key_id = p_key.id)
     order by a.id desc limit 1;
    v_why := 'YOUNG';
    v_detail := format('the server refused a reading of gateway %s (%s) and has received none since, so no capture can reach it', p_key.gateway_code, v_code);
  end if;
  return jsonb_build_object('status', 'ONLINE', 'reason', null, 'why', v_why, 'detail', v_detail);
end
$$;

-- The scales of room p_room (instruments bound to an active gateway key), for the gate of a hand-keyed weighing in the
-- current transaction: status and reason as tab.manual_path_verdict counts them for the window from the transaction's
-- start minus 10 seconds, and the window the listener vouches for (tab.listener_attested_from, read once);
-- `attestedFromUs` (the start of that window, null when it vouches for none), `shownReason` (what tab.scale_status shows now), `why` and `detail` (why a shown reason does
-- not count), `lastHeartbeatUs` and `heartbeatInThisTransaction`, as in 0340.
create or replace function tab.manual_weighing_scales(p_room text) returns jsonb
language sql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'deviceCode'), '[]'::jsonb) from (
    select jsonb_build_object(
             'deviceCode', b.device_code,
             'gatewayCode', k.gateway_code,
             'status', v.g ->> 'status',
             'reason', v.g ->> 'reason',
             'shownReason', w.reason,
             'why', v.g ->> 'why',
             'detail', v.g ->> 'detail',
             'lastHeartbeatUs', case when h.reported_at is null then null else platform.epoch_micros(h.reported_at)::text end,
             'heartbeatInThisTransaction', coalesce(h.written_xact = pg_current_xact_id_if_assigned(), false),
             'attestedFromUs', case when att.a is null then null else platform.epoch_micros(att.a)::text end) as x
      from (select tab.listener_attested_from(transaction_timestamp() - interval '10 seconds') as a) att
      cross join tab.gateway_instrument b
      join tab.gateway_key k on k.id = b.gateway_key_id and k.status = 'ACTIVE'
      join iam.device d on d.id = b.instrument_device_id
      left join tab.instrument_heartbeat h on h.instrument_device_id = b.instrument_device_id and h.gateway_key_id = k.id
      cross join lateral (select tab.scale_offline_reason(k, b, d, h) as reason) w
      cross join lateral (select tab.manual_path_verdict(k, b, d, h, transaction_timestamp() - interval '10 seconds', att.a) as g) v
     where b.ended_at is null and d.room_code = p_room) s
$$;

-- ---------------------------------------------------------------------------------------------
-- 1, 2, 5. The gate
-- ---------------------------------------------------------------------------------------------

-- As 0340, except that it refuses outside READ COMMITTED and while other roles may signal backends (kernel 0970), takes
-- its room's row of tab.scale_room_lock in share mode without waiting, counts the scales as tab.manual_path_verdict
-- does, and refuses where a reason would count only over a window the gateway listener does not vouch for (6,
-- UNATTESTED). The basis it records keeps, per scale, the start of the window the listener vouched for
-- (attestedFromUs).
create or replace function tab.manual_weighing_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_entry   jsonb := new.command -> 'entry';
  v_source  text;
  v_balance text;
  v_scales  jsonb;
  v_scale   jsonb;
begin
  if new.kind <> 'COMMAND' or new.command_type <> 'RECORD_ENTRY' or jsonb_typeof(v_entry) is distinct from 'object'
     or not (coalesce(v_entry ->> 'kind', '') in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER') or v_entry ? 'balance') then
    return new;
  end if;
  v_source := case when jsonb_typeof(v_entry -> 'source') = 'string' then v_entry ->> 'source' end;
  if v_source = 'DEVICE' then
    return new;
  end if;
  if v_source is distinct from 'MANUAL' then
    raise exception using errcode = 'P0001',
      message = format('A weighing is either captured from a device (DEVICE) or keyed by hand (MANUAL); source %s is neither, so the database cannot tell which rules apply (DI-30, DI-32). [EBMR-EXE-121]',
                       coalesce(v_entry ->> 'source', '(none)'));
  end if;
  if new.room_code is null then
    raise exception using errcode = 'P0001',
      message = 'A weight keyed by hand is accepted only from a terminal registered to a room, where the scales it stands in for are known (DI-20, DI-32, PR-20). [EBMR-EXE-074]';
  end if;
  -- 5. The scales' reports as committed now, never an older snapshot.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001',
      message = format('A weight keyed by hand is checked against the scales'' reports as committed when it is written, but this transaction reads the database as its snapshot saw it (isolation level %s), so whether a scale of room %s came online since is not known. Record it in a READ COMMITTED transaction (DI-30, PR-20). [EBMR-EXE-074]',
                       current_setting('transaction_isolation'), new.room_code);
  end if;
  -- 2. Nobody but a superuser may silence the gateway's reports.
  if not kernel.backend_signals_restricted() then
    raise exception using errcode = 'P0001',
      message = 'Roles other than the database''s superusers may cancel or end other connections in this database (pg_cancel_backend, pg_terminate_backend, pg_signal_backend), so the site gateway''s reports could be silenced and a scale that works could look offline. Nothing is keyed by hand until the database''s operator takes that right away again (sandbox.apply_connect_policy, kernel 0970) (DI-17, DI-30, PR-20). [EBMR-EXE-074]';
  end if;
  -- 1. Serialised with the heartbeats of the room (tab.record_heartbeat, tab.lock_gateway_rooms); held to the commit,
  -- never waited for.
  begin
    perform 1 from tab.scale_room_lock where room_code = new.room_code for share nowait;
    if not found then
      insert into tab.scale_room_lock (room_code) values (new.room_code) on conflict do nothing;
      perform 1 from tab.scale_room_lock where room_code = new.room_code for share nowait;
    end if;
  exception when lock_not_available then
    raise exception using errcode = 'P0001',
      message = format('A scale of room %s is reporting its status at this moment, so whether it is online is not yet known; nothing is keyed by hand until it is. Try again (DI-30, PR-20). [EBMR-EXE-074]', new.room_code);
  end;
  v_scales := tab.manual_weighing_scales(new.room_code);
  -- A status reported inside this very transaction is not another party's report: it never opens the manual path.
  select x into v_scale from jsonb_array_elements(v_scales) x
   where (x ->> 'heartbeatInThisTransaction')::boolean
   order by x ->> 'deviceCode' limit 1;
  if v_scale is not null then
    raise exception using errcode = 'P0001',
      message = format('The status of scale %s of room %s was reported in the same transaction as this weight keyed by hand; the database takes a scale''s status only from reports committed before, so nothing is keyed by hand on it (DI-30, PR-20). [EBMR-EXE-074]',
                       v_scale ->> 'deviceCode', new.room_code);
  end if;
  -- A scale shown ONLINE is named first; then one whose report that it cannot be used does not count.
  select x into v_scale from jsonb_array_elements(v_scales) x
   where x ->> 'status' = 'ONLINE'
   order by (x ->> 'shownReason') is not null and (x ->> 'why') is not null, x ->> 'deviceCode' limit 1;
  if v_scale is not null then
    if v_scale ->> 'shownReason' is null or v_scale ->> 'why' is null then
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is online: the weight is captured from it, never keyed by hand (DI-30, PR-20). [EBMR-EXE-074]', v_scale ->> 'deviceCode', new.room_code);
    elsif v_scale ->> 'why' = 'YOUNG' then
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is online by its heartbeat. The report that it cannot be used (%s) was made in this transaction, or had been seen by other transactions for less than 10 seconds when it began, so it does not open the manual path yet: capture the weight from the scale, or key it by hand once the report has stood for 10 seconds (DI-30, PR-20). [EBMR-EXE-074]',
                         v_scale ->> 'deviceCode', new.room_code, v_scale ->> 'detail');
    elsif v_scale ->> 'why' = 'ANSWERED' then
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is online by its heartbeat. The report that it cannot be used (%s) is answered: the gateway''s API answered the server after that report was made, so it does not open the manual path; capture the weight from the scale (DI-30, PR-20). [EBMR-EXE-074]',
                         v_scale ->> 'deviceCode', new.room_code, v_scale ->> 'detail');
    elsif v_scale ->> 'why' = 'UNATTESTED' then
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is shown offline (%s), but the gateway listener has not put on record that everything it received in the 10 seconds before this weighing began is recorded (a heartbeat of the site gateway or an answer of its API could not be recorded, or the listener is not running), so whether the scale reported itself working in that time is not known. Nothing is keyed by hand until the listener has vouched for 10 seconds again (DI-30, PR-20). [EBMR-EXE-074]',
                         v_scale ->> 'deviceCode', new.room_code, coalesce(v_scale ->> 'shownReason', v_scale ->> 'detail'));
    elsif v_scale ->> 'why' = 'RECENT' then
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is shown offline (%s), but it has been reported offline for less than the 10 seconds before this weighing began, or reported ONLINE since, so that does not yet prove it cannot be used: key the weight by hand once it has been reported offline for 10 seconds (DI-30, PR-20). [EBMR-EXE-074]',
                         v_scale ->> 'deviceCode', new.room_code, v_scale ->> 'shownReason');
    else
      raise exception using errcode = 'P0001',
        message = format('Scale %s of room %s is shown offline (%s), but heartbeats of the site gateway that name it have arrived since 10 seconds before this weighing began and were not recorded, and a heartbeat held up or cut off on its way into the record is no proof that the scale cannot be used. Nothing is keyed by hand until its heartbeats are recorded again or have stopped arriving for 10 seconds (DI-30, PR-20). [EBMR-EXE-074]',
                         v_scale ->> 'deviceCode', new.room_code, v_scale ->> 'shownReason');
    end if;
  end if;
  v_balance := case when jsonb_typeof(v_entry -> 'balance') = 'string' then v_entry ->> 'balance' end;
  if v_balance is distinct from 'MANUAL'
     and not exists (select 1 from iam.device d
                      where d.code = v_balance and d.device_class = 'INSTRUMENT' and d.status = 'ACTIVE' and d.room_code = new.room_code) then
    raise exception using errcode = 'P0001',
      message = format('A weight keyed by hand names balance %s, which is not an active instrument of room %s; it names MANUAL or the balance of the room that was read (DI-20, DI-30). [EBMR-EXE-074]',
                       coalesce(v_entry ->> 'balance', '(none)'), new.room_code);
  end if;
  insert into tab.manual_weighing_basis (batch_id, row_seq, room_code, scales)
  values (new.batch_id, new.seq, new.room_code,
          (select coalesce(jsonb_agg(x - 'shownReason' - 'why' - 'detail' - 'heartbeatInThisTransaction' order by x ->> 'deviceCode'), '[]'::jsonb)
             from jsonb_array_elements(v_scales) x));
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function tab.lock_scale_rooms(text[]), tab.note_contact_seen(uuid),
  tab.manual_path_verdict(tab.gateway_key, tab.gateway_instrument, iam.device, tab.instrument_heartbeat, timestamptz, timestamptz),
  tab.record_heartbeat_receipt(text, jsonb), tab.record_gateway_api_answer(text, text),
  tab.record_listener_tick(uuid, boolean), tab.listener_attested_from(timestamptz) from public;
-- 6. The gateway listener's own role (kernel 0980): what it puts on record, and the two reads of its receipt statement.
grant usage on schema tab, iam to ebmr_listener;
grant execute on function tab.record_heartbeat_receipt(text, jsonb), tab.record_gateway_api_answer(text, text),
  tab.record_listener_tick(uuid, boolean), tab.resolve_gateway_session(text), iam.policy_text(text) to ebmr_listener;

reset role;
