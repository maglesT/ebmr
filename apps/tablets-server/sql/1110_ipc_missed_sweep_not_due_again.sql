-- Tablets server, Phase 4 slice 1b: a station sweep marked missed is not due again at once (Phase 3 exit mutation backlog,
-- medium; TB-11; controls IN-35 (b), PR-29, INV-41).
--
-- tab.ipc_due (0892) took the start sweep of a compression run as due from the run's start until a STATION_SWEEP of the
-- stream was recorded. Marking it missed moved the base time but not that rule, so a missed start sweep stayed due: every
-- later entry of the run listed it as missed again and raised IPC_CHECK_MISSED again, and the sweeper's alarm recorded a
-- new MISSED hold for it each time. From this migration a slot marked missed counts as dealt with at that moment, as a
-- check does: a sweep without a repeat interval is not due again; one with a repeat interval falls due that interval after
-- the marking. The sweep itself is still required before the step is performed (TB11-NO-SWEEP, unchanged), and the miss
-- keeps its exception and its hold.
--
--   * tab.ipc_due: CREATE OR REPLACE from its only definition (0892); the one change is that v_seen (was v_checked) is set
--     by a marking as well as by a check. The twin is src/blocks/tb-11.ts dueOf (same change). Owner, volatility,
--     search_path (pg_temp last, ADR 0016) and the revoke of 0892 are kept by CREATE OR REPLACE.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create or replace function tab.ipc_due(p_prior jsonb, p_cfg jsonb, p_stream text, p_test text, out o_due numeric, out o_suspended boolean)
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e         jsonb;
  t         numeric;
  v_start   numeric;
  v_base    numeric;
  v_seen    boolean := false;
  v_own     boolean;
  v_every   numeric;
  v_restart numeric := coalesce(recipe.duration_us(p_cfg -> 'restartAfter'), 900000000);
  v_stopped numeric;
begin
  o_suspended := false;
  select recipe.micros_of(x -> 'recordedAt') into v_start from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'RUN_START' order by i limit 1;
  if v_start is null then
    return;
  end if;
  v_base := v_start;
  for e in select x from jsonb_array_elements(p_prior) with ordinality y (x, i) order by i loop
    t := recipe.micros_of(e -> 'recordedAt');
    v_own := tab.ipc_check_test(e ->> 'kind', tab.ipc_d(e)) = p_test and tab.ipc_d(e) ->> 'stream' = p_stream;
    if v_own or (jsonb_typeof(tab.ipc_d(e) -> 'missed') = 'array' and tab.ipc_d(e) -> 'missed' @> jsonb_build_array(jsonb_build_object('stream', p_stream, 'test', p_test))) then
      if t > v_base then
        v_base := t;
      end if;
      v_seen := true;
    end if;
  end loop;
  if p_test = 'SWEEP' then
    v_every := recipe.duration_us(p_cfg -> 'sweep' -> 'every');
    o_due := case when not v_seen then v_start when v_every is not null then v_base + v_every end;
  else
    select recipe.duration_us(p -> 'every') into v_every
      from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'plan') = 'array' then p_cfg -> 'plan' else '[]'::jsonb end) p where p ->> 'test' = p_test limit 1;
    if not found then
      return;
    end if;
    o_due := v_base + coalesce(v_every, 0);
  end if;
  if o_due is null then
    return;
  end if;
  for e in select x from jsonb_array_elements(p_prior) with ordinality y (x, i) order by i loop
    t := recipe.micros_of(e -> 'recordedAt');
    if e ->> 'kind' = 'STOPPAGE_START' then
      v_stopped := t;
    end if;
    if t <= v_base then
      if e ->> 'kind' = 'STOPPAGE_END' then
        v_stopped := null;
      end if;
      continue;
    end if;
    if e ->> 'kind' = 'CHANGE' and p_test <> 'SWEEP' then
      o_due := least(o_due, t);
    end if;
    if e ->> 'kind' = 'STOPPAGE_END' and v_stopped is not null then
      if v_stopped <= o_due and o_due <= t then
        o_due := t;
      elsif t - v_stopped > v_restart and p_test <> 'SWEEP' and o_due > t then
        o_due := t;
      end if;
      v_stopped := null;
    end if;
    if e ->> 'kind' = 'RUN_END' then
      if p_test = 'SWEEP' then
        o_due := case when o_due < t then o_due end;
        return;
      end if;
      o_due := least(o_due, t);
    end if;
  end loop;
  o_suspended := v_stopped is not null and o_due >= v_stopped;
end
$$;

reset role;
