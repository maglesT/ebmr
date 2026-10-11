-- Tablets server, Phase 3 slice 4b (builder A): what each entry of the blister blocks TB-21 (line set-up, independent
-- check and sealing) and TB-22 (leak test) holds, built in the database exactly as src/blocks/tb-21.ts and tb-22.ts build
-- it (tablets spec B.2 TB-21, TB-22; controls IN-38, PR-29, PR-33, PR-37; ADR 0012: the rules hold when the
-- application's own database credentials are used directly). The guard of 0972 compares a new entry's data with what
-- these functions build and refuses it when it differs or when they refuse it.
--
--   tab.blister_reel           TB-21: a scanned reel as a web of the pack format (its role and material the format's)
--   tab.blister_check_entry    TB-21 line check part: the set-up (change parts exactly the format's, one reel of every
--                              web; what was scanned kept as sent, the reels added in the format's order) and the independent equipment check (always a second person)
--   tab.blister_run_entry      TB-21 run part, its own kinds: the start, a reel change (a second person), the defect check
--                              against the MBR's sample and allowed defects, the pocket and vision rejects, the end, and
--                              the count reconciliation computed from the rejects (never typed)
--   tab.leak_due, tab.leak_overdue   TB-22: when a track's test falls due (at the run's start; one interval after the
--                              track's last test or the last entry that found it missed; at once after a configured
--                              event; at the end of the run; nothing after an end-of-run test) and whether it is missed
--                              at an instant (beyond the grace), at database time
--   tab.leak_entry             TB-22: the start, an event, a leak test inside the validated method (any leaking unit
--                              fails it; missed by count), the end; each entry with the tests it finds missed
--
-- Each returns {data, raise: [types], alerts: [], verify} or {problem}; a problem names the block's rule code. New
-- functions are owned by ebmr_owner and private to the owner; every function pins its search_path with pg_temp last (ADR
-- 0016). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- TB-21

-- A count text as a number (the schema holds it to digits; anything else counts as 0, as tb-21.ts countSum).
create function tab.blister_n(p jsonb) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^[0-9]{1,18}$' then (p #>> '{}')::numeric else 0 end
$$;

-- The reel scanned (p_scan) as a web of the pack format of p_cfg: {reel} or {problem} (tb-21.ts reelOf).
create function tab.blister_reel(p_cfg jsonb, p_scan jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  w jsonb;
begin
  if jsonb_typeof(p_scan) is distinct from 'object' then
    return tab.ipc_p('TB21-MATERIAL', 'a reel names its web, its material and its lot');
  end if;
  select x into w from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'materials') = 'array' then p_cfg -> 'materials' else '[]'::jsonb end) with ordinality y (x, i)
   where x -> 'role' = p_scan -> 'role' order by i limit 1;
  if w is null then
    return tab.ipc_p('TB21-MATERIAL', format('%s is not a web of the pack format', coalesce(p_scan ->> 'role', '(none)')));
  end if;
  if (p_scan -> 'material') is distinct from (w -> 'material') then
    return tab.ipc_p('TB21-MATERIAL', format('the %s of the pack format is %s, not %s', w ->> 'role', w ->> 'material', coalesce(p_scan ->> 'material', '(none)')));
  end if;
  return jsonb_build_object('reel', jsonb_strip_nulls(jsonb_build_object('role', w -> 'role', 'material', w -> 'material', 'lot', p_scan -> 'lot',
                                                                         'item', case when jsonb_typeof(w -> 'item') = 'string' then w -> 'item' end)));
end
$$;

-- What a TB-21 line check entry of kind p_kind holds (tb-21.ts acceptLineCheck): {data, raise, alerts, verify} or
-- {problem}. p_prior: the step's entries before it, in order.
create function tab.blister_check_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_want  jsonb := case when jsonb_typeof(p_cfg -> 'packFormat' -> 'changeParts') = 'array'
                        then (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from jsonb_array_elements(p_cfg -> 'packFormat' -> 'changeParts') with ordinality y (x, i) where jsonb_typeof(x) = 'string')
                        else '[]'::jsonb end;
  v_got   jsonb := case when jsonb_typeof(c -> 'changeParts') = 'array' then c -> 'changeParts' else '[]'::jsonb end;
  v_scans jsonb := case when jsonb_typeof(c -> 'materials') = 'array' then c -> 'materials' else '[]'::jsonb end;
  v_reels jsonb := '[]'::jsonb;
  v_r     jsonb;
  w       jsonb;
  v_pass  boolean;
begin
  case p_kind
    when 'LINE_SETUP' then
      if exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'LINE_SETUP') then
        return tab.ipc_p('TB21-SETUP-TWICE', 'the step already records its line set-up');
      end if;
      if exists (select 1 from jsonb_array_elements(v_want) x where not v_got @> jsonb_build_array(x))
         or exists (select 1 from jsonb_array_elements(v_got) x where not v_want @> jsonb_build_array(x))
         or (select count(distinct x) from jsonb_array_elements(v_got) x) <> jsonb_array_length(v_got) then
        return tab.ipc_p('TB21-CHANGE-PART', 'the change parts scanned are not the pack format''s');
      end if;
      for w in select x from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'materials') = 'array' then p_cfg -> 'materials' else '[]'::jsonb end) with ordinality y (x, i)
                where jsonb_typeof(x) = 'object' order by i loop
        if (select count(*) from jsonb_array_elements(v_scans) s where jsonb_typeof(s) = 'object' and s -> 'role' = w -> 'role') <> 1 then
          return tab.ipc_p('TB21-MATERIAL', format('one reel of the %s is scanned at the set-up', w ->> 'role'));
        end if;
        v_r := tab.blister_reel(p_cfg, (select s from jsonb_array_elements(v_scans) s where jsonb_typeof(s) = 'object' and s -> 'role' = w -> 'role'));
        if v_r ? 'problem' then
          return v_r;
        end if;
        v_reels := v_reels || jsonb_build_array(v_r -> 'reel');
      end loop;
      if jsonb_array_length(v_scans) <> jsonb_array_length(v_reels) then
        return tab.ipc_p('TB21-MATERIAL', 'a reel scanned is not a web of the pack format');
      end if;
      return jsonb_build_object('data', jsonb_build_object('machine', c -> 'machine', 'artworkSet', c -> 'artworkSet', 'changeParts', c -> 'changeParts', 'materials', c -> 'materials',
                                                           'reels', v_reels, 'setUpBy', p_by),
                                'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
    when 'EQUIPMENT_CHECK' then
      if not exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'LINE_SETUP') then
        return tab.ipc_p('TB21-NO-SETUP', 'set up the line first');
      end if;
      v_pass := (c -> 'rogueRemoved') = 'true'::jsonb and (c -> 'changePartsFitted') = 'true'::jsonb and c ->> 'emptyPocketDetector' = 'PASS';
      return jsonb_build_object('data', jsonb_build_object('rogueRemoved', c -> 'rogueRemoved', 'changePartsFitted', c -> 'changePartsFitted',
                                                           'emptyPocketDetector', c -> 'emptyPocketDetector', 'result', case when v_pass then 'PASS' else 'FAIL' end, 'checkedBy', p_by),
                                'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', true);
    else
      return tab.ipc_p('TB21-PART', format('%s is not an entry of the line check part of a blister step', coalesce(p_kind, '(none)')));
  end case;
end
$$;

-- What a TB-21 run entry of the block's own kind p_kind holds (tb-21.ts acceptRun, G-06's kinds apart): {data, raise,
-- alerts, verify} or {problem}.
create function tab.blister_run_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_started boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_START');
  v_ended   boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_END');
  v_counted boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'COUNT');
  v_r       jsonb;
  v_n       text;
  v_counts  jsonb;
  v_total   numeric;
  v_max     numeric;
  v_rej     numeric;
  v_unexp   numeric;
  v_per     numeric;
  k         text;
begin
  if p_kind = 'RUN_START' then
    if v_started then
      return tab.ipc_p('TB21-TWICE', 'the step has started its run already; a new run is a new step');
    end if;
    return jsonb_build_object('data', jsonb_build_object('machine', c -> 'machine', 'startedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
  end if;
  if p_kind not in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'REEL_CHANGE', 'DEFECT_CHECK', 'REJECTS', 'RUN_END', 'COUNT') then
    return tab.ipc_p('TB21-ENTRY', format('%s is not an entry of a blister run', coalesce(p_kind, '(none)')));
  end if;
  if not v_started then
    return tab.ipc_p('TB21-NOT-STARTED', 'the step has not started its run');
  end if;
  if v_ended and p_kind not in ('COUNT', 'DEFECT_CHECK') then
    return tab.ipc_p('TB21-ENDED', 'the run has ended');
  end if;
  case p_kind
    when 'SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK' then
      -- G-06's own: its data are recipe-core 0520's, its exceptions tablets 0913's.
      return jsonb_build_object('g06', true);
    when 'REEL_CHANGE' then
      v_r := tab.blister_reel(p_cfg, c);
      if v_r ? 'problem' then
        return v_r;
      end if;
      return jsonb_build_object('data', (v_r -> 'reel') || jsonb_build_object('changedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', true);
    when 'DEFECT_CHECK' then
      v_n := c ->> 'examined';
      if v_n is distinct from p_cfg -> 'defectCheck' ->> 'examined' then
        return tab.ipc_p('TB21-SAMPLE', format('a defect check examines the %s blisters the MBR sets, not %s', coalesce(p_cfg -> 'defectCheck' ->> 'examined', '-'), coalesce(v_n, '(none)')));
      end if;
      v_counts := '{}'::jsonb;
      v_total := 0;
      foreach k in array array['MISPRINT', 'FOIL_CUT', 'MISSING_TABLET', 'IMPROPER_SEAL'] loop
        v_counts := v_counts || jsonb_build_object(k, case when jsonb_typeof(c -> 'defects' -> k) = 'string' then c -> 'defects' -> k else '"0"'::jsonb end);
        v_total := v_total + tab.blister_n(c -> 'defects' -> k);
      end loop;
      if v_total > v_n::numeric then
        return tab.ipc_p('TB21-DEFECTS', format('more defects (%s) than blisters examined (%s)', v_total, v_n));
      end if;
      v_max := coalesce(case when (p_cfg -> 'defectCheck' ->> 'maxDefects') ~ '^[0-9]{1,18}$' then (p_cfg -> 'defectCheck' ->> 'maxDefects')::numeric end, 0);
      return jsonb_build_object('data', jsonb_build_object('examined', v_n, 'defectCounts', v_counts, 'defectTotal', v_total::text,
                                                           'result', case when v_total <= v_max then 'PASS' else 'FAIL' end, 'checkedBy', p_by),
                                'raise', case when v_total <= v_max then '[]'::jsonb else '["DEFECT_CHECK_FAILED"]'::jsonb end, 'alerts', '[]'::jsonb, 'verify', false);
    when 'REJECTS' then
      if v_counted then
        return tab.ipc_p('TB21-COUNTED', 'the count of the step is recorded');
      end if;
      v_counts := '{}'::jsonb;
      v_total := 0;
      foreach k in array array['emptyPocket', 'brokenPocket', 'vision'] loop
        v_counts := v_counts || jsonb_build_object(k, case when jsonb_typeof(c -> k) = 'string' then c -> k else '"0"'::jsonb end);
        v_total := v_total + tab.blister_n(c -> k);
      end loop;
      return jsonb_build_object('data', v_counts || jsonb_build_object('total', v_total::text, 'recordedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
    when 'RUN_END' then
      return jsonb_build_object('data', jsonb_build_object('endedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
    else
      if not v_ended then
        return tab.ipc_p('TB21-RUNNING', 'the run has not ended: the count comes after it');
      end if;
      if v_counted then
        return tab.ipc_p('TB21-COUNT-TWICE', 'the step already records its count');
      end if;
      select coalesce(sum(tab.blister_n(tab.ipc_d(x) -> 'total')), 0) into v_rej from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'REJECTS';
      v_unexp := tab.blister_n(c -> 'formed') - (v_rej + tab.blister_n(c -> 'good') + tab.blister_n(c -> 'setupWaste') + tab.blister_n(c -> 'samples'));
      v_per := coalesce(case when (p_cfg -> 'packFormat' ->> 'unitsPerBlister') ~ '^[1-9][0-9]{0,17}$' then (p_cfg -> 'packFormat' ->> 'unitsPerBlister')::numeric end, 1);
      return jsonb_build_object('data', jsonb_build_object('formed', c -> 'formed', 'good', c -> 'good', 'rejects', v_rej::text, 'setupWaste', c -> 'setupWaste',
                                                           'samples', c -> 'samples', 'unexplained', v_unexp::text, 'goodUnits', (tab.blister_n(c -> 'good') * v_per)::text, 'recordedBy', p_by),
                                'raise', case when v_unexp = 0 then '[]'::jsonb else '["BLISTER_COUNT_UNEXPLAINED"]'::jsonb end, 'alerts', '[]'::jsonb, 'verify', false);
  end case;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-22

-- The tracks of TB-22 configuration p_cfg by name, in the MBR's order (D one track, LEAK; tb-22.ts tracksOf).
create function tab.leak_tracks(p_cfg jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_cfg -> 'tracks') = 'array'
              then (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from jsonb_array_elements(p_cfg -> 'tracks') with ordinality y (x, i) where jsonb_typeof(x) = 'string')
              else '["LEAK"]'::jsonb end
$$;

-- When the test of track p_track of the run in p_prior falls due, in microseconds; NULL when nothing is due (tb-22.ts
-- leakDue).
create function tab.leak_due(p_prior jsonb, p_cfg jsonb, p_track text) returns numeric
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_start   numeric;
  v_end     numeric;
  v_every   numeric := recipe.duration_us(p_cfg -> 'every');
  v_events  jsonb := case when jsonb_typeof(p_cfg -> 'triggers') = 'array' then p_cfg -> 'triggers' else '["RESTART", "REEL_CHANGE", "ADJUSTMENT"]'::jsonb end;
  v_base    numeric;
  v_touched boolean;
  v_due     numeric;
  v_ev      numeric;
begin
  select recipe.micros_of(x -> 'recordedAt') into v_start from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'RUN_START' order by i limit 1;
  if v_start is null or v_every is null then
    return null;
  end if;
  select count(*) > 0, greatest(v_start, max(recipe.micros_of(x -> 'recordedAt'))) into v_touched, v_base from jsonb_array_elements(p_prior) x
   where (x ->> 'kind' = 'LEAK_TEST' and tab.ipc_d(x) -> 'track' = to_jsonb(p_track))
      or (jsonb_typeof(tab.ipc_d(x) -> 'missed') = 'array' and tab.ipc_d(x) -> 'missed' @> jsonb_build_array(jsonb_build_object('stream', p_track)));
  v_base := coalesce(v_base, v_start);
  v_due := case when v_touched then v_base + v_every else v_start end;
  select min(recipe.micros_of(x -> 'recordedAt')) into v_ev from jsonb_array_elements(p_prior) x
   where x ->> 'kind' = 'EVENT' and recipe.micros_of(x -> 'recordedAt') > v_base and v_events @> jsonb_build_array(tab.ipc_d(x) -> 'event');
  if v_ev is not null and v_ev < v_due then
    v_due := v_ev;
  end if;
  select recipe.micros_of(x -> 'recordedAt') into v_end from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'RUN_END' order by i limit 1;
  if v_end is not null then
    if v_touched and v_base >= v_end then
      return null;
    end if;
    if v_end < v_due then
      v_due := v_end;
    end if;
  end if;
  return v_due;
end
$$;

-- The tests missed at p_now, track by track: [{stream: <track>, test: LEAK, by: TIME, dueUs}] (tb-22.ts leakOverdue).
create function tab.leak_overdue(p_prior jsonb, p_cfg jsonb, p_now numeric) returns jsonb
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('stream', t.t, 'test', 'LEAK', 'by', 'TIME', 'dueUs', d.due::text) order by t.i), '[]'::jsonb)
    from jsonb_array_elements_text(tab.leak_tracks(p_cfg)) with ordinality t (t, i)
         cross join lateral (select tab.leak_due(p_prior, p_cfg, t.t) as due) d
   where d.due is not null and p_now > d.due + coalesce(recipe.duration_us(p_cfg -> 'grace'), 0)
$$;

-- What a TB-22 entry of kind p_kind holds (tb-22.ts accept): {data, raise, alerts, verify, missed} or {problem}.
create function tab.leak_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_started boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_START');
  v_ended   boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_END');
  v_last    numeric;
  v_prev    numeric;
  v_missed  jsonb;
  v_raise   jsonb := '[]'::jsonb;
  v_counter jsonb := case when c ? 'counter' then jsonb_build_object('counter', c -> 'counter') else '{}'::jsonb end;
  v_track   text;
  v_data    jsonb;
  v_pass    boolean;
begin
  if p_kind = 'RUN_START' then
    if v_started then
      return tab.ipc_p('TB22-TWICE', 'the step has started its run already; a new run is a new step');
    end if;
    return jsonb_build_object('data', jsonb_build_object('machine', c -> 'machine', 'startedBy', p_by) || v_counter, 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
  end if;
  if p_kind is null or p_kind not in ('EVENT', 'LEAK_TEST', 'RUN_END') then
    return tab.ipc_p('TB22-ENTRY', format('%s is not an entry of a leak-test step', coalesce(p_kind, '(none)')));
  end if;
  if not v_started then
    return tab.ipc_p('TB22-NOT-STARTED', 'the step has not started its run');
  end if;
  if v_ended and p_kind <> 'LEAK_TEST' then
    return tab.ipc_p('TB22-ENDED', 'the run has ended');
  end if;
  if c ? 'counter' then
    select max((tab.ipc_d(x) ->> 'counter')::numeric) into v_last from jsonb_array_elements(p_prior) x where jsonb_typeof(tab.ipc_d(x) -> 'counter') = 'number';
    if v_last is not null and (c ->> 'counter')::numeric < v_last then
      return tab.ipc_p('TB22-COUNTER-BACK', format('the machine counter reads %s, below the %s already recorded', c ->> 'counter', v_last));
    end if;
  end if;
  v_missed := tab.leak_overdue(p_prior, p_cfg, p_now);
  case p_kind
    when 'EVENT' then
      v_data := jsonb_build_object('event', c -> 'event', 'recordedBy', p_by) || v_counter;
    when 'RUN_END' then
      v_data := jsonb_build_object('endedBy', p_by) || v_counter;
    else
      v_track := case when jsonb_typeof(c -> 'track') = 'string' then c ->> 'track' end;
      if v_track is null or not tab.leak_tracks(p_cfg) ? v_track then
        return tab.ipc_p('TB22-TRACK', format('%s is not a track of the machine', left(coalesce(c ->> 'track', '(none)'), 20)));
      end if;
      if (c ->> 'tested') is distinct from (p_cfg ->> 'perTest') then
        return tab.ipc_p('TB22-SAMPLE', format('a leak test takes the %s units per track the MBR sets, not %s', coalesce(p_cfg ->> 'perTest', '-'), coalesce(c ->> 'tested', '(none)')));
      end if;
      if tab.blister_n(c -> 'leaking') > tab.blister_n(c -> 'tested') then
        return tab.ipc_p('TB22-LEAKING', format('more leaking units (%s) than tested (%s)', c ->> 'leaking', c ->> 'tested'));
      end if;
      if (c ->> 'vacuum')::numeric < (p_cfg -> 'vacuum' ->> 'min')::numeric or (c ->> 'vacuum')::numeric > (p_cfg -> 'vacuum' ->> 'max')::numeric
         or (c ->> 'holdSeconds')::numeric < (p_cfg -> 'hold' ->> 'min')::numeric or (c ->> 'holdSeconds')::numeric > (p_cfg -> 'hold' ->> 'max')::numeric then
        return tab.ipc_p('TB22-PARAMETERS', format('the test ran at %s kPa for %s s, outside the validated method''s vacuum and hold-time ranges: it is no test', c ->> 'vacuum', c ->> 'holdSeconds'));
      end if;
      if jsonb_typeof(p_cfg -> 'everyCount') = 'string' then
        if not (c ? 'counter') then
          return tab.ipc_p('TB22-COUNTER', 'the leak test gives the machine counter (its interval is by count too)');
        end if;
        select (tab.ipc_d(x) ->> 'counter')::numeric into v_prev from jsonb_array_elements(p_prior) with ordinality y (x, i)
         where x ->> 'kind' = 'LEAK_TEST' and tab.ipc_d(x) -> 'track' = to_jsonb(v_track) and jsonb_typeof(tab.ipc_d(x) -> 'counter') = 'number' order by i desc limit 1;
        if v_prev is null then
          select (tab.ipc_d(x) ->> 'counter')::numeric into v_prev from jsonb_array_elements(p_prior) with ordinality y (x, i)
           where x ->> 'kind' = 'RUN_START' and jsonb_typeof(tab.ipc_d(x) -> 'counter') = 'number' order by i limit 1;
        end if;
        if v_prev is not null and (c ->> 'counter')::numeric - v_prev > (p_cfg ->> 'everyCount')::numeric
           and not v_missed @> jsonb_build_array(jsonb_build_object('stream', v_track)) then
          v_missed := v_missed || jsonb_build_array(jsonb_build_object('stream', v_track, 'test', 'LEAK', 'by', 'COUNT'));
        end if;
      end if;
      v_pass := tab.blister_n(c -> 'leaking') = 0;
      v_data := jsonb_build_object('track', v_track, 'tested', c -> 'tested', 'vacuum', c -> 'vacuum', 'holdSeconds', c -> 'holdSeconds', 'leaking', c -> 'leaking',
                                   'result', case when v_pass then 'PASS' else 'FAIL' end, 'testedBy', p_by) || v_counter;
      if not v_pass then
        v_raise := v_raise || '["LEAK_TEST_FAILED"]'::jsonb;
      end if;
  end case;
  if jsonb_array_length(v_missed) > 0 then
    v_data := v_data || jsonb_build_object('missed', v_missed);
    v_raise := v_raise || '["LEAK_TEST_MISSED"]'::jsonb;
  end if;
  return jsonb_build_object('data', v_data, 'raise', v_raise, 'alerts', '[]'::jsonb, 'verify', p_kind = 'LEAK_TEST', 'missed', v_missed);
end
$$;

revoke all on function tab.blister_n(jsonb), tab.blister_reel(jsonb, jsonb), tab.blister_check_entry(text, jsonb, jsonb, jsonb, jsonb),
  tab.blister_run_entry(text, jsonb, jsonb, jsonb, jsonb), tab.leak_tracks(jsonb), tab.leak_due(jsonb, jsonb, text), tab.leak_overdue(jsonb, jsonb, numeric),
  tab.leak_entry(text, jsonb, jsonb, jsonb, numeric, jsonb) from public;

reset role;
