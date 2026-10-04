-- Tablets server, modules C3 with C5: the report that the server cannot reach a gateway's API no longer opens the
-- manual-weighing path when the gateway's API answered the server at the very instant the report was made (SQL mutation
-- run, group manual-weighing-gate, survivor tab.manual_path_verdict#31; controls DI-30, PR-20; tablets 0350 item 4).
--
-- The problem. Tablets 0350 counts the monitor's report that the API is unreachable only while the API "has not answered
-- the server since the report was made" (item 4), and tab.manual_path_verdict read that as an answer recorded strictly
-- after the report's change (tab.gateway_api_answer.answered_at > tab.gateway_api_contact.changed_at). Both times are the
-- database clock read by two transactions on two connections (the listener's receipts pool records the answer, the
-- monitor's command the report), so they can be the same microsecond. An answer at the report's own instant then left
-- the report standing: once it had been seen for 10 seconds over a window the listener vouched for, the scale counted as
-- unusable and a weight keyed by hand was accepted beside a gateway whose API had answered. Every other boundary of the
-- gate takes the closed side (a heartbeat received at the window's start counts as heard, a state recorded or a report
-- seen at the window's start is RECENT or YOUNG, a refusal at the bound or at the last reading's instant holds nothing);
-- this one did not.
--
-- Now an answer recorded at or after the report's change answers it (ANSWERED): the report does not open the manual
-- path, and the gate refuses the weighing with the ANSWERED message (EBMR-EXE-074) as for a later answer. Nothing else
-- of tab.manual_path_verdict changes; tab.scale_status still shows the report at once.
--
-- Privileges: CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the search_path and the grants (none;
-- revoked from public by 0350). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

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
--   ANSWERED    the API report stands but the gateway's API answered the server since it was made (at its very
--               instant included: tablets 0640).
create or replace function tab.manual_path_verdict(p_key tab.gateway_key, p_bind tab.gateway_instrument, p_device iam.device,
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

  -- The server's side (P51): counted only when seen by another transaction before p_from and unanswered since made (an
  -- answer at the report's own instant answers it: 0640),
  -- over a window the listener vouches for (its answers are among what it puts on record).
  select * into v_contact from tab.gateway_api_contact where gateway_key_id = p_key.id;
  if found and not v_contact.reachable then
    v_api := format('the server cannot reach the site gateway''s API (%s)', v_contact.detail);
    if exists (select 1 from tab.gateway_api_answer a where a.gateway_key_id = p_key.id and a.answered_at >= v_contact.changed_at) then
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

reset role;
