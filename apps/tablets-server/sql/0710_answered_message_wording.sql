-- Tablets edition, devices (module C4): the gate's ANSWERED refusal says when the gateway's API answered, as the verdict
-- counts it (Phase 2 exit, SQL mutation kill work, defect D3, wording; DI-30, PR-20; message only: what is refused is
-- unchanged).
--
-- Tablets 0700 (the kill work's fix of 0350) made an answer of the gateway's API recorded at the very instant of the
-- monitor's report that the API is unreachable answer that report (tab.manual_path_verdict: answered_at >= changed_at),
-- so the gate refuses a hand-keyed weighing with the ANSWERED message for such an answer too. That message, raised by
-- tab.manual_weighing_check (0350), still said the API answered the server "after" the report was made. 0350's header
-- describes ANSWERED the same way ("answered the server after it was made"), and 0700's header and comments call 0700
-- "tablets 0640", the number it had on its branch (0640 is tablets 0640_manual_weighing_basis_identifiers on this tree):
-- both are corrected here, since applied migrations are never edited. ANSWERED means an answer recorded at or after the
-- moment of the report.
--
-- What changed: tab.manual_weighing_check (CREATE OR REPLACE) is 0350's function with that one message reworded: the
-- gateway's API answered the server at or after the moment that report was made. Every check, its order, every other
-- message, the owner, the privileges (none for PUBLIC), SECURITY DEFINER and the search_path are as in 0350. Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As 0350, the ANSWERED message reworded (D3).
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
        message = format('Scale %s of room %s is online by its heartbeat. The report that it cannot be used (%s) is answered: the gateway''s API answered the server at or after the moment that report was made, so it does not open the manual path; capture the weight from the scale (DI-30, PR-20). [EBMR-EXE-074]',
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

reset role;
