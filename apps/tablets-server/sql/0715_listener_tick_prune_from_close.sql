-- Tablets server, module C3 (the evidence listener): a tick is kept until both its tick and its close are over an hour
-- old, so the hold that a run of another key keeps from the close of its last tick lasts the hour announced (Phase 2
-- exit, SQL mutation kill work, group evidence-listener, defect D13; controls DI-17, DI-30, PR-20; decision X43;
-- tablets 0350 item 6).
--
-- Why. tab.record_listener_tick (0350) pruned every row whose tick (ticked_at) was over an hour old. The hold by a run of
-- another run key, or of none (decision X43), is measured from when that run last closed a tick (closed_at):
-- tab.listener_attested_from vouches for nothing while such a run closed a tick within the last hour, and
-- tab.begin_listener_run answers heldUntilUs = that close plus one hour (which the server logs at warn,
-- RUN_HELD_BY_OTHER_KEY_LOG). A row is closed after its tick: by the next tick, about 0.5 s later, or, for a run's last
-- row, by tab.end_listener_run when the run ends, and arbitrarily later when the run's ticks could not land and the row
-- was closed only by the next tick that landed or by the run's end. Any tick of any run (a run of someone holding only
-- the listener's credentials among them) then pruned that row an hour after its tick: the hold ended early by the time
-- between tick and close, before the heldUntilUs the database had already given. Reproduced by the evidence-listener
-- kill agent: a run of another key ticked 61 minutes ago and closed 59 minutes ago; tab.begin_listener_run answered a
-- hold until its close plus one hour; the next tick of any run pruned the row, and the next start answered no hold.
--
-- Now a tick prunes only rows whose tick and close are both over an hour old; a row still open (no close) is pruned an
-- hour after its tick, as before, which is the hour the hold of a run that stopped without being ended runs from
-- (decision X40: measured from that open row's tick). Decision X43 is worded accordingly: the hour runs from the close
-- (docs/decisions/phase-2-open-questions.md, D13.1). Nothing else of the function changes: the run's own row is still
-- locked, an ended run still ticks no more (EBMR-DEV-076), the prune still takes at most 1000 rows with SKIP LOCKED.
-- tab.begin_listener_run, which prunes runs that began over an hour ago and have no tick left, keeps a run's key as long
-- as one of its ticks is kept, so the key of the run that holds is kept with the row that holds.
--
-- Privileges: CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the search_path (pg_temp last) and the
-- grants (EXECUTE for the listener's role only, 0350; mirrored to the sandbox listener in a sandbox). Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- 6. The listener's tick (its role only): closes run p_watch's latest row with p_clean (whether everything the listener
-- received since that row's tick was put on record; null counts as not) and opens the next one at the database's time.
-- Answers {seq, tickedAtUs}. A run that has ended (its latest row closed by tab.end_listener_run) ticks no more
-- (EBMR-DEV-076): what arrived after its end is covered by no tick, so a listener that starts again ticks as a new run.
-- Prunes, with SKIP LOCKED, rows whose tick and close are both over an hour old (an open row: its tick).
create or replace function tab.record_listener_tick(p_watch uuid, p_clean boolean) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_last integer;
  v_open boolean;
  v_seq  integer;
  v_at   timestamptz;
begin
  if p_watch is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-075 a tick of the gateway listener names the run it belongs to';
  end if;
  -- The run's latest row, locked: a tick and the run's end never pass each other.
  select t.seq, t.clean is null into v_last, v_open
    from tab.listener_tick t where t.watch_id = p_watch order by t.seq desc limit 1 for update;
  if v_last is not null and not v_open then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DEV-076 this run of the gateway listener has ended (or another tick of it ran at the same time); a listener that starts again ticks as a new run';
  end if;
  if v_last is not null then
    update tab.listener_tick set clean = coalesce(p_clean, false), closed_at = clock_timestamp()
     where watch_id = p_watch and seq = v_last and clean is null;
  end if;
  insert into tab.listener_tick (watch_id, seq) values (p_watch, coalesce(v_last, 0) + 1)
  returning seq, ticked_at into v_seq, v_at;
  delete from tab.listener_tick x
   where (x.watch_id, x.seq) in (select y.watch_id, y.seq from tab.listener_tick y
                                  where y.ticked_at < clock_timestamp() - interval '1 hour'
                                    and (y.closed_at is null or y.closed_at < clock_timestamp() - interval '1 hour')
                                  limit 1000 for update skip locked);
  return jsonb_build_object('seq', v_seq, 'tickedAtUs', platform.epoch_micros(v_at)::text);
end
$$;

reset role;
