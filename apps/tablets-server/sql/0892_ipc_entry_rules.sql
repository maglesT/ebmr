-- Tablets server, Phase 3 slice 3c (builder B): what each entry of the IPC blocks TB-11 to TB-15 holds, built in the
-- database exactly as src/blocks/tb-11.ts to tb-15.ts build it (tablets spec B.2 TB-11 to TB-15; controls IN-34, IN-35,
-- PR-07, PR-29, DI-10, DI-28, DI-29, DI-32, INV-41; ADR 0012: the rules hold when the application's own database
-- credentials are used directly). The guard of 0893 compares a new entry's data with what these functions build and
-- refuses it when it differs or when they refuse it.
--
--   tab.ipc_common             the members every test entry shares: its stream (a TB-11 step's test entry names one of its
--                              streams, a test block's entry none), the sampling time (never after the entry, never before
--                              the step's first entry), the readings of a DEVICE entry (one per value) and none for a
--                              MANUAL one, the late flag (DI-28: later than the late-entry time after sampling, D 10 min)
--   tab.ipc_weight_check, tab.ipc_second_stage     TB-12: modes GROUP, UNIFORMITY, INDIVIDUAL, CONTENT, SUBDIVISION against
--                              the rule sets the batch's markets bind (IN-34), the second stage of a weight variation on all
--                              the units of both stages, never a new first stage while it is due (INV-41)
--   tab.ipc_physical_check     TB-13: breaking force (kp converted to N), thickness, diameter, appearance defects
--   tab.ipc_friability_run     TB-14: the sample rule, rotations and rate, the loss rounded to one decimal, the repeat runs
--                              and the mean of three (INV-41: the first run is never replaced)
--   tab.ipc_dt_start, tab.ipc_dt_end   TB-15: bath temperature before the start, the limits of the stage, the elapsed time
--                              measured between the entries, the retest staging (INV-41), the acid and buffer stages
--   tab.ipc_sweep              TB-11: the station sweep, every station once (IN-35 (b))
--   tab.ipc_due, tab.ipc_overdue   TB-11: when a stream's test falls due (interval by time from its last check or marking,
--                              at once after a setting or tooling change, at the restart after a long stoppage, at the end
--                              of the run; suspended while the press is stopped) and which are overdue beyond the grace
--   tab.ipc_scheduler_entry    TB-11: the run's entries (start, stoppages, changes, end) and its test entries, each with the
--                              checks it finds missed by time or by press count (IN-35 (c))
--   tab.ipc_entry              dispatch by block type and entry kind
--
-- Each returns {data, outcome, manual, late} or {problem}; a problem names the block's rule code. New functions are owned
-- by ebmr_owner and private to the owner; every function pins its search_path with pg_temp last (ADR 0016). Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function tab.ipc_p(p_code text, p_message text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('problem', format('%s (%s)', p_message, p_code))
$$;

create function tab.ipc_str(p jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'string' then p #>> '{}' end
$$;

-- An entry's data object.
create function tab.ipc_d(e jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end
$$;

-- The configuration of test p_key (weight, physical, friability, disintegration): TB-11 nests it, a test block is it.
create function tab.ipc_tcfg(p_cfg jsonb, p_sched boolean, p_key text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when not p_sched then p_cfg when jsonb_typeof(p_cfg -> p_key) = 'object' then p_cfg -> p_key else '{}'::jsonb end
$$;

-- The common members of a test entry (header). p_prior: the step's entries before it, in order.
create function tab.ipc_common(p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_values integer, p_code text, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_stream  text := tab.ipc_str(c -> 'stream');
  v_sampled numeric;
  v_capture text := c ->> 'capture';
  v_late    numeric;
  v_base    jsonb;
begin
  if p_sched then
    if v_stream is null or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'streams') = 'array' then p_cfg -> 'streams' else '[]'::jsonb end) s
                                        where s ->> 'id' = v_stream) then
      return tab.ipc_p(p_code || '-STREAM', 'a check at a TB-11 step names one of its streams');
    end if;
  elsif v_stream is not null or c ? 'counter' then
    return tab.ipc_p(p_code || '-STREAM', 'the step is not a TB-11 scheduler step: its checks name no stream or counter');
  end if;
  v_sampled := case when jsonb_typeof(c -> 'sampledAtUs') = 'string' then (c ->> 'sampledAtUs')::numeric else p_now end;
  if v_sampled > p_now then
    return tab.ipc_p(p_code || '-SAMPLED-LATER', 'the sample cannot be taken after it is recorded');
  end if;
  if jsonb_array_length(p_prior) > 0 and v_sampled < recipe.micros_of(p_prior -> 0 -> 'recordedAt') then
    return tab.ipc_p(p_code || '-SAMPLED-EARLY', 'the sample cannot be taken before the step''s first entry');
  end if;
  if v_capture = 'DEVICE' and (jsonb_typeof(c -> 'readings') is distinct from 'array' or jsonb_array_length(c -> 'readings') <> p_values) then
    return tab.ipc_p(p_code || '-READINGS', format('a check captured from the instrument names one claimed reading per value (%s)', p_values));
  end if;
  if v_capture = 'MANUAL' and c ? 'readings' then
    return tab.ipc_p(p_code || '-READINGS', 'a check keyed by hand names no instrument readings');
  end if;
  v_late := coalesce(recipe.duration_us(p_cfg -> 'lateEntry'), 600000000);
  v_base := jsonb_build_object('instrument', c -> 'instrument', 'capture', c -> 'capture', 'sampledAtUs', v_sampled::text, 'late', p_now - v_sampled > v_late, 'recordedBy', p_by)
            || case when c ? 'readings' then jsonb_build_object('readings', c -> 'readings') else '{}'::jsonb end
            || case when v_stream is not null then jsonb_build_object('stream', v_stream) else '{}'::jsonb end
            || case when c ? 'counter' then jsonb_build_object('counter', c -> 'counter') else '{}'::jsonb end;
  return jsonb_build_object('base', v_base, 'manual', v_capture = 'MANUAL', 'late', p_now - v_sampled > v_late);
end
$$;

-- The entries of p_prior of kind p_kind.
create function tab.ipc_of(p_prior jsonb, p_kind text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(x.e order by x.i), '[]'::jsonb) from jsonb_array_elements(p_prior) with ordinality x (e, i) where x.e ->> 'kind' = p_kind
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-12

-- First-stage weight variations of p_prior waiting for their second stage.
create function tab.ipc_pending_first(p_prior jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(w.e order by w.i), '[]'::jsonb)
    from jsonb_array_elements(tab.ipc_of(p_prior, 'WEIGHT_CHECK')) with ordinality w (e, i)
   where tab.ipc_d(w.e) ->> 'result' = 'SECOND_STAGE'
     and not exists (select 1 from jsonb_array_elements(tab.ipc_of(p_prior, 'WEIGHT_SECOND_STAGE')) s where tab.ipc_d(s) ->> 'check' = w.e ->> 'id')
$$;

create function tab.ipc_weight_check(p_tcfg jsonb, p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_mode   text := p_tcfg ->> 'mode';
  ws       numeric[] := tab.ipc_nums(c -> 'weights');
  v_group  text := tab.ipc_str(c -> 'groupWeight');
  v_gw     boolean := v_mode = 'GROUP' and p_tcfg ->> 'weighing' = 'GROUP';
  v_sets   jsonb;
  v_n      integer;
  v_common jsonb;
  v_eval   jsonb;
  v_out    text;
  v_total  numeric;
  v_target numeric;
  v_t      jsonb;
  v_crit   jsonb;
  v_assay  numeric;
begin
  if exists (select 1 from jsonb_array_elements(tab.ipc_pending_first(p_prior)) x where tab.ipc_d(x) -> 'stream' is not distinct from c -> 'stream') then
    return tab.ipc_p('TB12-SECOND-STAGE-PENDING', 'the step waits for the second stage of its weight variation; a new first stage never replaces it');
  end if;
  if (v_gw and (v_group is null or ws is not null)) or (not v_gw and (ws is null or v_group is not null)) then
    return tab.ipc_p('TB12-WEIGHTS', 'the weights are not given the way the check weighs its tablets');
  end if;
  if v_mode is distinct from 'CONTENT' and (c ? 'assay' or c ? 'assayRef') then
    return tab.ipc_p('TB12-ASSAY', 'only a weight variation (CONTENT) takes an assay');
  end if;
  v_sets := case v_mode
    when 'UNIFORMITY' then tab.ipc_rule_sets('UNIFORMITY_OF_WEIGHT', p_markets, p_tcfg ->> 'tabletType', p_date, (p_tcfg -> 'legacyTable') = 'true'::jsonb)
    when 'CONTENT' then tab.ipc_rule_sets('WEIGHT_VARIATION', p_markets, p_tcfg ->> 'tabletType', p_date, false)
    when 'SUBDIVISION' then tab.ipc_rule_sets('SUBDIVISION', p_markets, p_tcfg ->> 'tabletType', p_date, false)
    else '[]'::jsonb end;
  if v_mode in ('UNIFORMITY', 'CONTENT', 'SUBDIVISION') and jsonb_array_length(v_sets) = 0 then
    return tab.ipc_p('TB12-NO-RULE-SET', format('no compendial rule set for this mode covers %s tablets for the batch''s markets', coalesce(p_tcfg ->> 'tabletType', '(none)')));
  end if;
  v_n := case
    when v_mode in ('GROUP', 'INDIVIDUAL') then coalesce((p_tcfg ->> 'n')::integer, 0)
    when v_mode = 'UNIFORMITY' then (v_sets -> 0 -> 'params' ->> 'units')::integer
    when v_mode = 'CONTENT' then (v_sets -> 0 -> 'params' ->> 'firstUnits')::integer
    else (v_sets -> 0 -> 'params' ->> 'units')::integer end;
  if ws is not null and cardinality(ws) <> v_n then
    return tab.ipc_p('TB12-COUNT', format('the check weighs %s tablets one by one, not %s', v_n, cardinality(ws)));
  end if;
  v_common := tab.ipc_common(p_cfg, p_sched, p_prior, c, coalesce(cardinality(ws), 1), 'TB12', p_now, p_by);
  if v_common ? 'problem' then
    return v_common;
  end if;
  case v_mode
    when 'GROUP' then
      v_total := coalesce(v_group::numeric, (select sum(w) from unnest(ws) w));
      v_target := (p_tcfg ->> 'targetWeightMg')::numeric * v_n;
      v_t := tab.ipc_relative_tiers(v_target, coalesce(p_tcfg -> 'tolerance', '{"action": "0"}'::jsonb));
      v_eval := case when ws is not null then tab.ipc_stats(ws) else '{}'::jsonb end
                || jsonb_build_object('mode', 'GROUP', 'n', v_n, 'total', trim_scale(v_total)::text, 'mean', round(round(v_total, 40) / v_n, 4)::text,
                                      'target', trim_scale(v_target)::text, 'limits', v_t);
      v_out := tab.ipc_judge(v_total, v_t);
    when 'UNIFORMITY' then
      v_crit := tab.ipc_uniformity(ws, v_sets);
      v_eval := jsonb_build_object('mode', v_mode) || tab.ipc_stats(ws) || jsonb_build_object('criteria', v_crit);
      v_out := case when not exists (select 1 from jsonb_array_elements(v_crit) x where (x -> 'pass') = 'false'::jsonb) then 'PASS' else 'FAIL' end;
    when 'INDIVIDUAL' then
      v_target := (p_tcfg ->> 'targetWeightMg')::numeric;
      v_t := tab.ipc_relative_tiers(v_target, coalesce(p_tcfg -> 'individual', '{"action": "0"}'::jsonb));
      v_eval := tab.ipc_stats(ws) || jsonb_build_object('mode', 'INDIVIDUAL', 'target', trim_scale(v_target)::text, 'limits', v_t,
        'outside', (select count(*) from unnest(ws) w where tab.ipc_judge(w, v_t) = 'FAIL'),
        'outsideAlert', (select count(*) from unnest(ws) w where tab.ipc_judge(w, v_t) <> 'PASS'));
      v_out := tab.ipc_worst(array(select tab.ipc_judge(w, v_t) from unnest(ws) w));
    when 'CONTENT' then
      if tab.ipc_str(c -> 'assay') is null or tab.ipc_str(c -> 'assayRef') is null then
        return tab.ipc_p('TB12-ASSAY', 'a weight variation needs the assay of a representative sample and its laboratory reference');
      end if;
      v_assay := (c ->> 'assay')::numeric;
      v_target := coalesce((p_tcfg ->> 'targetContent')::numeric, 100);
      select coalesce(jsonb_agg(tab.ipc_av(ws, v_assay, v_target, s.v, false) order by s.i), '[]'::jsonb) into v_crit
        from jsonb_array_elements(v_sets) with ordinality s (v, i);
      v_eval := jsonb_build_object('mode', v_mode, 'stage', 'FIRST') || tab.ipc_stats(ws)
                || jsonb_build_object('assay', trim_scale(v_assay)::text, 'targetContent', trim_scale(v_target)::text, 'criteria', v_crit);
      v_out := case when not exists (select 1 from jsonb_array_elements(v_crit) x where (x -> 'pass') = 'false'::jsonb) then 'PASS' else 'SECOND_STAGE' end;
    else
      v_crit := tab.ipc_subdivision(ws, v_sets);
      v_eval := jsonb_build_object('mode', 'SUBDIVISION') || tab.ipc_stats(ws) || jsonb_build_object('criteria', v_crit);
      v_out := case when not exists (select 1 from jsonb_array_elements(v_crit) x where (x -> 'pass') = 'false'::jsonb) then 'PASS' else 'FAIL' end;
  end case;
  return jsonb_build_object(
    'data', (v_common -> 'base')
            || case when ws is not null then jsonb_build_object('weights', c -> 'weights') else jsonb_build_object('groupWeight', c -> 'groupWeight') end
            || case when v_mode = 'CONTENT' then jsonb_build_object('assay', c -> 'assay', 'assayRef', c -> 'assayRef') else '{}'::jsonb end
            || jsonb_build_object('mode', v_mode)
            || case when jsonb_array_length(v_sets) > 0 then jsonb_build_object('ruleSets', tab.ipc_refs(v_sets)) else '{}'::jsonb end
            || jsonb_build_object('evaluation', v_eval, 'result', v_out),
    'outcome', v_out, 'manual', v_common -> 'manual', 'late', v_common -> 'late');
end
$$;

create function tab.ipc_second_stage(p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_first  jsonb;
  v_codes  jsonb;
  v_sets   jsonb;
  p        jsonb;
  ws       numeric[] := tab.ipc_nums(c -> 'weights');
  v_all    numeric[];
  v_common jsonb;
  v_ev     jsonb;
  v_crit   jsonb;
  v_out    text;
begin
  select x.e into v_first from jsonb_array_elements(tab.ipc_of(p_prior, 'WEIGHT_CHECK')) x (e) where x.e ->> 'id' = c ->> 'check';
  if v_first is null or tab.ipc_d(v_first) ->> 'result' is distinct from 'SECOND_STAGE' then
    return tab.ipc_p('TB12-NO-FIRST-STAGE', format('%s is not a first-stage weight variation of the step that asks for a second stage', coalesce(c ->> 'check', '(none)')));
  end if;
  if exists (select 1 from jsonb_array_elements(tab.ipc_of(p_prior, 'WEIGHT_SECOND_STAGE')) s where tab.ipc_d(s) ->> 'check' = v_first ->> 'id') then
    return tab.ipc_p('TB12-SECOND-STAGE-TWICE', 'the second stage is recorded already; a stage is never repeated');
  end if;
  if c -> 'stream' is distinct from tab.ipc_d(v_first) -> 'stream' then
    return tab.ipc_p('TB12-SECOND-STAGE-STREAM', 'the second stage comes from the stream of its first stage');
  end if;
  v_codes := coalesce(tab.ipc_d(v_first) -> 'ruleSets', '[]'::jsonb);
  select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'version', r.version, 'params', r.params) order by x.i), '[]'::jsonb) into v_sets
    from jsonb_array_elements(v_codes) with ordinality x (v, i)
    join tab.compendial_rule_set r on r.code = x.v ->> 'code' and r.version = (x.v ->> 'version')::integer;
  p := v_sets -> 0 -> 'params';
  if p is null or ws is null or cardinality(ws) <> (p ->> 'totalUnits')::integer - (p ->> 'firstUnits')::integer then
    return tab.ipc_p('TB12-COUNT', 'the second stage weighs the further tablets of its rule set one by one');
  end if;
  v_common := tab.ipc_common(p_cfg, p_sched, p_prior, c, cardinality(ws), 'TB12', p_now, p_by);
  if v_common ? 'problem' then
    return v_common;
  end if;
  v_all := tab.ipc_nums(tab.ipc_d(v_first) -> 'weights') || ws;
  v_ev := tab.ipc_d(v_first) -> 'evaluation';
  select coalesce(jsonb_agg(tab.ipc_av(v_all, (v_ev ->> 'assay')::numeric, (v_ev ->> 'targetContent')::numeric, s.v, true) order by s.i), '[]'::jsonb) into v_crit
    from jsonb_array_elements(v_sets) with ordinality s (v, i);
  v_out := case when not exists (select 1 from jsonb_array_elements(v_crit) x where (x -> 'pass') = 'false'::jsonb) then 'PASS' else 'FAIL' end;
  return jsonb_build_object(
    'data', (v_common -> 'base') || jsonb_build_object('check', v_first -> 'id', 'weights', c -> 'weights', 'ruleSets', v_codes,
              'evaluation', jsonb_build_object('mode', 'CONTENT', 'stage', 'SECOND') || tab.ipc_stats(v_all)
                            || jsonb_build_object('assay', v_ev -> 'assay', 'targetContent', v_ev -> 'targetContent', 'criteria', v_crit),
              'result', v_out),
    'outcome', v_out, 'manual', v_common -> 'manual', 'late', v_common -> 'late');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-13

create function tab.ipc_physical_check(p_tcfg jsonb, p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_params  text[] := array(select p from unnest(array['thickness', 'diameter', 'hardness']) with ordinality u (p, i) where jsonb_typeof(p_tcfg -> p) = 'object' order by u.i);
  v_tablets jsonb := case when jsonb_typeof(c -> 'tablets') = 'array' then c -> 'tablets' else '[]'::jsonb end;
  v_n       integer := coalesce((p_tcfg ->> 'n')::integer, 0);
  v_defects jsonb := case when jsonb_typeof(c -> 'defects') = 'array' then c -> 'defects' end;
  v_common  jsonb;
  v_eval    jsonb := '{}'::jsonb;
  v_vs      text[] := '{}';
  p         text;
  vs        numeric[];
  st        jsonb;
  ti        jsonb;
  tm        jsonb;
  v         text;
begin
  if jsonb_array_length(v_tablets) <> v_n then
    return tab.ipc_p('TB13-COUNT', format('the check examines %s tablets, not %s', v_n, jsonb_array_length(v_tablets)));
  end if;
  if exists (select 1 from jsonb_array_elements(v_tablets) t
              where array(select k from unnest(array['thickness', 'diameter', 'hardness']) with ordinality u (k, i) where t ? k order by u.i) <> v_params) then
    return tab.ipc_p('TB13-PARAMETERS', 'each tablet gives exactly the parameters the MBR examines');
  end if;
  if (jsonb_typeof(p_tcfg -> 'defects') = 'array') <> (v_defects is not null) then
    return tab.ipc_p('TB13-APPEARANCE', 'the defects observed are listed exactly when the MBR examines appearance');
  end if;
  if v_defects is not null and ((select count(distinct x) from jsonb_array_elements_text(v_defects) x) <> jsonb_array_length(v_defects)
                                or exists (select 1 from jsonb_array_elements(v_defects) x where not ((p_tcfg -> 'defects') @> jsonb_build_array(x)))) then
    return tab.ipc_p('TB13-APPEARANCE', 'the defects observed are listed once each, from the defects the MBR examines');
  end if;
  v_common := tab.ipc_common(p_cfg, p_sched, p_prior, c, v_n * cardinality(v_params), 'TB13', p_now, p_by);
  if v_common ? 'problem' then
    return v_common;
  end if;
  foreach p in array v_params loop
    vs := array(select (t.v ->> p)::numeric * case when p = 'hardness' and p_tcfg -> 'hardness' ->> 'unit' = 'kp' then 9.80665 else 1 end
                  from jsonb_array_elements(v_tablets) with ordinality t (v, i) order by t.i);
    ti := tab.ipc_tiers(p_tcfg -> p -> 'individual');
    tm := tab.ipc_tiers(p_tcfg -> p -> 'mean');
    st := tab.ipc_stats(vs);
    v := tab.ipc_worst(array[
      case when ti is not null then tab.ipc_worst(array(select tab.ipc_judge(x, ti) from unnest(vs) x)) else 'PASS' end,
      case when tm is not null then tab.ipc_judge(round((st ->> 'sum')::numeric, 40) / cardinality(vs), tm) else 'PASS' end]);
    v_vs := v_vs || v;
    v_eval := v_eval || jsonb_build_object(p, jsonb_build_object('unit', case when p = 'hardness' then 'N' else 'mm' end, 'mean', st -> 'mean', 'min', st -> 'min', 'max', st -> 'max', 'result', v));
  end loop;
  if v_defects is not null then
    v := case when jsonb_array_length(v_defects) > 0 then 'FAIL' else 'PASS' end;
    v_vs := v_vs || v;
    v_eval := v_eval || jsonb_build_object('appearance', jsonb_build_object('defects', v_defects, 'result', v));
  end if;
  v := tab.ipc_worst(v_vs);
  return jsonb_build_object(
    'data', (v_common -> 'base') || jsonb_build_object('tablets', c -> 'tablets')
            || case when v_defects is not null then jsonb_build_object('defects', v_defects) else '{}'::jsonb end
            || jsonb_build_object('evaluation', v_eval, 'result', v),
    'outcome', v, 'manual', v_common -> 'manual', 'late', v_common -> 'late');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-14

-- First friability runs of p_prior whose repeats are still to come.
create function tab.ipc_pending_friability(p_prior jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(r.e order by r.i), '[]'::jsonb)
    from jsonb_array_elements(tab.ipc_of(p_prior, 'FRIABILITY_RUN')) with ordinality r (e, i)
   where tab.ipc_d(r.e) -> 'run' = '1'::jsonb and tab.ipc_d(r.e) ->> 'result' = 'REPEAT'
     and not exists (select 1 from jsonb_array_elements(tab.ipc_of(p_prior, 'FRIABILITY_RUN')) x
                      where tab.ipc_d(x) ->> 'repeatOf' = r.e ->> 'id' and tab.ipc_d(x) ->> 'result' <> 'REPEAT')
$$;

create function tab.ipc_loss(p_initial numeric, p_final numeric) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select round((p_initial - p_final) * 100, 40) / p_initial
$$;

create function tab.ipc_friability_run(p_tcfg jsonb, p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_sets    jsonb := tab.ipc_rule_sets('FRIABILITY', p_markets, p_tcfg ->> 'tabletType', p_date, false);
  p         jsonb := v_sets -> 0 -> 'params';
  v_limit   numeric;
  v_tablets numeric := (c ->> 'tablets')::numeric;
  v_initial numeric := (c ->> 'initialMass')::numeric;
  v_final   numeric := (c ->> 'finalMass')::numeric;
  v_rpm     numeric := (c ->> 'rpm')::numeric;
  v_repeat  text := tab.ipc_str(c -> 'repeatOf');
  v_first   jsonb;
  v_run     integer := 1;
  v_common  jsonb;
  v_loss    numeric;
  v_rep     text;
  v_mean    text;
  v_out     text;
  v_broken  boolean := (c -> 'broken') = 'true'::jsonb;
begin
  if jsonb_array_length(v_sets) = 0 then
    return tab.ipc_p('TB14-NO-RULE-SET', format('no friability rule set covers %s tablets for this batch', coalesce(p_tcfg ->> 'tabletType', '(none)')));
  end if;
  select min(x) into v_limit from (select (s -> 'params' ->> 'maxLossPercent')::numeric x from jsonb_array_elements(v_sets) s
                                    union all select (p_tcfg ->> 'limitPercent')::numeric where jsonb_typeof(p_tcfg -> 'limitPercent') = 'string') z;
  if v_final < 0 or v_final > v_initial then
    return tab.ipc_p('TB14-MASS', 'the mass after the test lies between zero and the mass before it');
  end if;
  if tab.ipc_friability_sample_problem(p, v_tablets, v_initial) is not null then
    return tab.ipc_p('TB14-SAMPLE', 'the sample does not follow the rule set: ' || tab.ipc_friability_sample_problem(p, v_tablets, v_initial));
  end if;
  if (c ->> 'rotations')::numeric <> (p ->> 'rotations')::numeric then
    return tab.ipc_p('TB14-ROTATIONS', format('the drum turns %s times', p ->> 'rotations'));
  end if;
  if v_rpm < (p ->> 'rpmMin')::numeric or v_rpm > (p ->> 'rpmMax')::numeric then
    return tab.ipc_p('TB14-RATE', format('the drum turns at %s to %s rpm', p ->> 'rpmMin', p ->> 'rpmMax'));
  end if;
  if v_repeat is null then
    if exists (select 1 from jsonb_array_elements(tab.ipc_pending_friability(p_prior)) x where tab.ipc_d(x) -> 'stream' is not distinct from c -> 'stream') then
      return tab.ipc_p('TB14-REPEAT-PENDING', 'the step waits for the repeat runs of its friability test; a new first run never replaces them');
    end if;
    if c ? 'doubtful' and (c -> 'doubtful') <> 'true'::jsonb then
      return tab.ipc_p('TB14-DOUBTFUL', 'doubtful is stated only when it is so');
    end if;
  else
    select x.e into v_first from jsonb_array_elements(tab.ipc_pending_friability(p_prior)) x (e) where x.e ->> 'id' = v_repeat;
    if v_first is null then
      return tab.ipc_p('TB14-NOT-REPEATED', format('%s is not a first friability run of the step waiting for its repeats', v_repeat));
    end if;
    if c -> 'stream' is distinct from tab.ipc_d(v_first) -> 'stream' then
      return tab.ipc_p('TB14-NOT-REPEATED', 'a repeat run tests the same stream as its first run');
    end if;
    if c ? 'doubtful' then
      return tab.ipc_p('TB14-DOUBTFUL', 'only the first run is found doubtful');
    end if;
    v_run := 1 + (select count(*) from jsonb_array_elements(tab.ipc_of(p_prior, 'FRIABILITY_RUN')) x where tab.ipc_d(x) ->> 'repeatOf' = v_repeat)::integer + 1;
  end if;
  v_common := tab.ipc_common(p_cfg, p_sched, p_prior, c, 2, 'TB14', p_now, p_by);
  if v_common ? 'problem' then
    return v_common;
  end if;
  v_loss := tab.ipc_loss(v_initial, v_final);
  v_rep := round(v_loss, (p ->> 'lossDecimals')::integer)::text;
  if v_broken then
    v_out := 'FAIL';
  elsif v_run = 1 then
    v_out := case when v_rep::numeric > v_limit or (c -> 'doubtful') = 'true'::jsonb then 'REPEAT' else 'PASS' end;
  elsif v_run < (p ->> 'repeatRuns')::integer then
    v_out := 'REPEAT';
  else
    select round((sum(tab.ipc_loss((tab.ipc_d(x) ->> 'initialMass')::numeric, (tab.ipc_d(x) ->> 'finalMass')::numeric)) + v_loss) / (count(*) + 1), (p ->> 'lossDecimals')::integer)::text
      into v_mean
      from jsonb_array_elements(tab.ipc_of(p_prior, 'FRIABILITY_RUN')) x where x ->> 'id' = v_repeat or tab.ipc_d(x) ->> 'repeatOf' = v_repeat;
    v_out := case when v_mean::numeric <= v_limit then 'PASS' else 'FAIL' end;
  end if;
  return jsonb_build_object(
    'data', (v_common -> 'base')
            || jsonb_build_object('tablets', c -> 'tablets', 'initialMass', c -> 'initialMass', 'finalMass', c -> 'finalMass', 'rotations', c -> 'rotations', 'rpm', c -> 'rpm',
                                  'broken', v_broken)
            || case when (c -> 'doubtful') = 'true'::jsonb then jsonb_build_object('doubtful', true) else '{}'::jsonb end
            || case when v_repeat is not null then jsonb_build_object('repeatOf', v_repeat) else '{}'::jsonb end
            || jsonb_build_object('run', v_run, 'ruleSets', tab.ipc_refs(v_sets), 'averageWeight', round(v_initial * 1000 / v_tablets, 2)::text,
                                  'loss', round(v_loss, 4)::text, 'reported', v_rep, 'limit', trim_scale(v_limit)::text)
            || case when v_mean is not null then jsonb_build_object('meanOfRuns', v_mean) else '{}'::jsonb end
            || jsonb_build_object('result', v_out),
    'outcome', v_out, 'manual', v_common -> 'manual', 'late', v_common -> 'late');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-15

create function tab.ipc_dt_limits_of(p_tcfg jsonb, p_markets jsonb, p_date date) returns jsonb
language sql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select tab.ipc_dt_limits(tab.ipc_rule_sets('DISINTEGRATION', p_markets, p_tcfg ->> 'tabletType', p_date, false), p_tcfg ->> 'tabletType',
                           recipe.duration_us(p_tcfg -> 'timeLimit')::numeric / 1000000, recipe.duration_us(p_tcfg -> 'acidTime')::numeric / 1000000)
$$;

-- DT_START entries of p_prior not yet ended.
create function tab.ipc_open_starts(p_prior jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(s.e order by s.i), '[]'::jsonb)
    from jsonb_array_elements(tab.ipc_of(p_prior, 'DT_START')) with ordinality s (e, i)
   where not exists (select 1 from jsonb_array_elements(tab.ipc_of(p_prior, 'DT_END')) x where tab.ipc_d(x) ->> 'start' = s.e ->> 'id')
$$;

-- First runs (DT_END) asking for a retest no start has taken up; acid stages passed no buffer stage has followed.
create function tab.ipc_pending_dt(p_prior jsonb, p_result text) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(x.e order by x.i), '[]'::jsonb)
    from jsonb_array_elements(tab.ipc_of(p_prior, 'DT_END')) with ordinality x (e, i)
   where tab.ipc_d(x.e) ->> 'result' = p_result
     and not exists (select 1 from jsonb_array_elements(tab.ipc_of(p_prior, 'DT_START')) s
                      where tab.ipc_d(s) ->> case p_result when 'RETEST' then 'retestOf' else 'afterAcid' end = x.e ->> 'id')
$$;

create function tab.ipc_dt_start(p_tcfg jsonb, p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_lim     jsonb := tab.ipc_dt_limits_of(p_tcfg, p_markets, p_date);
  v_stage   text := c ->> 'stage';
  v_gastro  boolean := p_tcfg ->> 'tabletType' = 'GASTRO_RESISTANT';
  v_retest  text := tab.ipc_str(c -> 'retestOf');
  v_first   jsonb;
  v_after   text;
  v_limit   text;
  v_t       numeric := (c ->> 'bathTemperature')::numeric;
  v_common  jsonb;
begin
  if v_lim is null then
    return tab.ipc_p('TB15-NO-RULE-SET', format('no disintegration rule set covers %s tablets for this batch', coalesce(p_tcfg ->> 'tabletType', '(none)')));
  end if;
  if v_gastro <> (v_stage <> 'MAIN') then
    return tab.ipc_p('TB15-STAGE', 'gastro-resistant tablets run an acid stage and then a buffer stage; other tablets the main stage');
  end if;
  if exists (select 1 from jsonb_array_elements(tab.ipc_open_starts(p_prior)) s where tab.ipc_d(s) -> 'stream' is not distinct from c -> 'stream') then
    return tab.ipc_p('TB15-RUNNING', 'a disintegration run of this stream is still running');
  end if;
  if v_retest is not null then
    select x.e into v_first from jsonb_array_elements(tab.ipc_pending_dt(p_prior, 'RETEST')) x (e)
     where x.e ->> 'id' = v_retest and tab.ipc_d(x.e) -> 'stream' is not distinct from c -> 'stream';
    if v_first is null or tab.ipc_d(v_first) ->> 'stage' is distinct from v_stage then
      return tab.ipc_p('TB15-NOT-RETESTED', format('%s is not a run of this stage and stream that asks for a retest', v_retest));
    end if;
  elsif exists (select 1 from jsonb_array_elements(tab.ipc_pending_dt(p_prior, 'RETEST')) x where tab.ipc_d(x) -> 'stream' is not distinct from c -> 'stream') then
    return tab.ipc_p('TB15-RETEST-PENDING', 'the step waits for the retest of its disintegration run; a new first run never replaces it');
  elsif v_stage = 'BUFFER' then
    select x.e ->> 'id' into v_after from jsonb_array_elements(tab.ipc_pending_dt(p_prior, 'BUFFER')) with ordinality x (e, i)
     where tab.ipc_d(x.e) -> 'stream' is not distinct from c -> 'stream' order by x.i limit 1;
    if v_after is null then
      return tab.ipc_p('TB15-NO-ACID', 'the buffer stage follows an acid stage that passed');
    end if;
  elsif v_stage = 'ACID' and exists (select 1 from jsonb_array_elements(tab.ipc_pending_dt(p_prior, 'BUFFER')) x where tab.ipc_d(x) -> 'stream' is not distinct from c -> 'stream') then
    return tab.ipc_p('TB15-BUFFER-PENDING', 'the acid stage passed: the buffer stage comes next');
  end if;
  v_limit := case when v_stage = 'ACID' then v_lim ->> 'acidSeconds' else v_lim ->> 'seconds' end;
  if v_limit is null then
    return tab.ipc_p('TB15-NO-LIMIT', 'neither a rule set nor the MBR gives this stage a time limit');
  end if;
  if v_t < (v_lim ->> 'tempMin')::numeric or v_t > (v_lim ->> 'tempMax')::numeric then
    return tab.ipc_p('TB15-BATH-TEMP', format('the run starts only with the bath between %s and %s degC', v_lim ->> 'tempMin', v_lim ->> 'tempMax'));
  end if;
  v_common := tab.ipc_common(p_cfg, p_sched, p_prior, c, 1, 'TB15', p_now, p_by);
  if v_common ? 'problem' then
    return v_common;
  end if;
  return jsonb_build_object(
    'data', (v_common -> 'base') || jsonb_build_object('bathTemperature', c -> 'bathTemperature', 'stage', v_stage)
            || case when v_retest is not null then jsonb_build_object('retestOf', v_retest) else '{}'::jsonb end
            || case when v_after is not null then jsonb_build_object('afterAcid', v_after) else '{}'::jsonb end
            || jsonb_build_object('ruleSets', tab.ipc_refs(tab.ipc_rule_sets('DISINTEGRATION', p_markets, p_tcfg ->> 'tabletType', p_date, false)),
                                  'limitSeconds', v_limit, 'temperature', jsonb_build_object('min', v_lim -> 'tempMin', 'max', v_lim -> 'tempMax'),
                                  'units', case when v_retest is not null then v_lim -> 'staging' -> 'retestUnits' else v_lim -> 'units' end),
    'outcome', 'RETEST', 'manual', v_common -> 'manual', 'late', v_common -> 'late');
end
$$;

create function tab.ipc_dt_end(p_tcfg jsonb, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_open    jsonb := tab.ipc_open_starts(p_prior);
  v_named   text := tab.ipc_str(c -> 'start');
  v_start   jsonb;
  sd        jsonb;
  v_units   jsonb := case when jsonb_typeof(c -> 'units') = 'array' then c -> 'units' else '[]'::jsonb end;
  v_device  boolean := c ->> 'capture' = 'DEVICE';
  v_us      numeric;
  v_el      numeric;
  v_limit   numeric;
  v_passed  integer;
  v_out     text;
  v_extra   jsonb := '{}'::jsonb;
  v_staging jsonb;
  v_total   integer;
begin
  if v_named is null and jsonb_array_length(v_open) > 1 then
    return tab.ipc_p('TB15-WHICH-START', 'the step has several runs running: name the one that ends');
  end if;
  select x.e into v_start from jsonb_array_elements(v_open) with ordinality x (e, i) where v_named is null or x.e ->> 'id' = v_named order by x.i limit 1;
  if v_start is null then
    return tab.ipc_p('TB15-NOT-STARTED', format('%s is not a running disintegration of the step', coalesce(v_named, 'no run')));
  end if;
  sd := tab.ipc_d(v_start);
  if jsonb_array_length(v_units) <> (sd ->> 'units')::integer then
    return tab.ipc_p('TB15-UNITS', format('this run tests %s units', sd ->> 'units'));
  end if;
  if (v_device and (jsonb_typeof(c -> 'readings') is distinct from 'array' or jsonb_array_length(c -> 'readings') <> jsonb_array_length(v_units)
                    or exists (select 1 from jsonb_array_elements(v_units) u where not (u ? 'seconds'))))
     or (not v_device and (c ? 'readings' or exists (select 1 from jsonb_array_elements(v_units) u where u ? 'seconds'))) then
    return tab.ipc_p('TB15-READINGS', 'a run read from the instrument gives each unit its time and one claimed reading; units observed by hand carry neither');
  end if;
  v_us := p_now - recipe.micros_of(v_start -> 'recordedAt');
  v_el := v_us / 1000000;
  if exists (select 1 from jsonb_array_elements(v_units) u where u ? 'seconds' and (u ->> 'seconds')::numeric > v_el) then
    return tab.ipc_p('TB15-TIME', 'a unit cannot disintegrate after its run ended');
  end if;
  v_limit := (sd ->> 'limitSeconds')::numeric;
  if sd ->> 'stage' = 'ACID' then
    if v_us < v_limit * 1000000 then
      return tab.ipc_p('TB15-ACID-SHORT', format('the acid stage runs its full %s s', trim_scale(v_limit)));
    end if;
    select count(*)::integer into v_passed from jsonb_array_elements(v_units) u where (u -> 'disintegrated') = 'false'::jsonb;
    v_out := case when v_passed = jsonb_array_length(v_units) then 'BUFFER' else 'FAIL' end;
  else
    select count(*)::integer into v_passed from jsonb_array_elements(v_units) u
     where (u -> 'disintegrated') = 'true'::jsonb and case when u ? 'seconds' then (u ->> 'seconds')::numeric <= v_limit else v_el <= v_limit end;
    v_staging := coalesce(tab.ipc_dt_limits_of(p_tcfg, p_markets, p_date) -> 'staging', '{"failMin": 1, "failMax": 2, "retestUnits": 12, "passMin": 16}'::jsonb);
    if sd ? 'retestOf' then
      select coalesce((tab.ipc_d(x) ->> 'passed')::integer, 0) + v_passed into v_total from jsonb_array_elements(tab.ipc_of(p_prior, 'DT_END')) x where x ->> 'id' = sd ->> 'retestOf';
      v_total := coalesce(v_total, v_passed);
      v_extra := jsonb_build_object('passedInAll', v_total);
      v_out := case when v_total >= (v_staging ->> 'passMin')::integer then 'PASS' else 'FAIL' end;
    else
      v_out := case when jsonb_array_length(v_units) - v_passed = 0 then 'PASS'
                    when jsonb_array_length(v_units) - v_passed between (v_staging ->> 'failMin')::integer and (v_staging ->> 'failMax')::integer then 'RETEST'
                    else 'FAIL' end;
    end if;
  end if;
  return jsonb_build_object(
    'data', jsonb_build_object('start', v_start -> 'id', 'stage', sd -> 'stage')
            || case when sd ? 'stream' then jsonb_build_object('stream', sd -> 'stream') else '{}'::jsonb end
            || jsonb_build_object('capture', c -> 'capture')
            || case when c ? 'readings' then jsonb_build_object('readings', c -> 'readings') else '{}'::jsonb end
            || jsonb_build_object('units', c -> 'units', 'elapsedSeconds', tab.gran_seconds(v_us), 'passed', v_passed) || v_extra
            || jsonb_build_object('result', v_out, 'recordedBy', p_by),
    'outcome', v_out, 'manual', not v_device, 'late', false, 'instrument', sd -> 'instrument');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-11

-- The test an entry counts as a check of, for the schedule (first stages and first runs only), or NULL.
create function tab.ipc_check_test(p_kind text, p_data jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_kind
    when 'WEIGHT_CHECK' then 'WEIGHT'
    when 'PHYSICAL_CHECK' then 'PHYSICAL'
    when 'FRIABILITY_RUN' then case when not (p_data ? 'repeatOf') then 'FRIABILITY' end
    when 'DT_START' then case when not (p_data ? 'retestOf') and p_data ->> 'stage' is distinct from 'BUFFER' then 'DISINTEGRATION' end
    when 'STATION_SWEEP' then 'SWEEP'
  end
$$;

-- When slot (p_stream, p_test) of the run in p_prior falls due (microseconds), and whether a running stoppage suspends it
-- (tb-11.ts dueOf).
create function tab.ipc_due(p_prior jsonb, p_cfg jsonb, p_stream text, p_test text, out o_due numeric, out o_suspended boolean)
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e         jsonb;
  t         numeric;
  v_start   numeric;
  v_base    numeric;
  v_checked boolean := false;
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
      if v_own then
        v_checked := true;
      end if;
    end if;
  end loop;
  if p_test = 'SWEEP' then
    v_every := recipe.duration_us(p_cfg -> 'sweep' -> 'every');
    o_due := case when not v_checked then v_start when v_every is not null then v_base + v_every end;
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

-- The slots overdue at p_now (missed by time), in stream and test order: [{stream, test, by: TIME, dueUs}].
create function tab.ipc_overdue(p_prior jsonb, p_cfg jsonb, p_now numeric) returns jsonb
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('stream', z.stream, 'test', z.test, 'by', 'TIME', 'dueUs', z.o_due::text) order by z.si, z.ti), '[]'::jsonb)
    from (select s.si, s.stream, t.ti, t.test, d.*
            from (select x.i as si, x.v ->> 'id' as stream from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'streams') = 'array' then p_cfg -> 'streams' else '[]'::jsonb end) with ordinality x (v, i)) s
            cross join (select x.i as ti, x.v ->> 'test' as test from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'plan') = 'array' then p_cfg -> 'plan' else '[]'::jsonb end) with ordinality x (v, i)
                        union all select 1000, 'SWEEP' where jsonb_typeof(p_cfg -> 'sweep') = 'object') t
            cross join lateral tab.ipc_due(p_prior, p_cfg, s.stream, t.test) d) z
   where z.o_due is not null and not z.o_suspended and p_now > z.o_due + coalesce(recipe.duration_us(p_cfg -> 'grace'), 0)
$$;

-- The station sweep (tb-11.ts acceptSweep).
create function tab.ipc_sweep(p_cfg jsonb, p_prior jsonb, c jsonb, p_now numeric, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_sweep    jsonb := p_cfg -> 'sweep';
  v_n        integer;
  v_stations jsonb := case when jsonb_typeof(c -> 'stations') = 'array' then c -> 'stations' else '[]'::jsonb end;
  v_params   text[];
  v_common   jsonb;
  v_eval     jsonb := '{}'::jsonb;
  v_vs       text[] := '{}';
  p          text;
  vs         numeric[];
  ti         jsonb;
  v          text;
begin
  if jsonb_typeof(v_sweep) is distinct from 'object' then
    return tab.ipc_p('TB11-NO-SWEEP', 'the step has no station sweep in its MBR');
  end if;
  v_n := (v_sweep ->> 'stations')::integer;
  v_params := array(select k from unnest(array['weight', 'thickness', 'hardness']) with ordinality u (k, i) where jsonb_typeof(v_sweep -> k) = 'object' order by u.i);
  if jsonb_array_length(v_stations) <> v_n
     or (select count(distinct (s ->> 'station')::integer) from jsonb_array_elements(v_stations) s) <> v_n
     or exists (select 1 from jsonb_array_elements(v_stations) s where (s ->> 'station')::integer not between 1 and v_n) then
    return tab.ipc_p('TB11-SWEEP-INCOMPLETE', format('the station sweep gives each of the %s stations exactly one result; it cannot be recorded incomplete', v_n));
  end if;
  if exists (select 1 from jsonb_array_elements(v_stations) s
              where array(select k from unnest(array['weight', 'thickness', 'hardness']) with ordinality u (k, i) where s ? k order by u.i) <> v_params) then
    return tab.ipc_p('TB11-SWEEP-PARAMETERS', 'each station gives exactly the parameters the MBR sweeps');
  end if;
  v_common := tab.ipc_common(p_cfg, true, p_prior, c, v_n * cardinality(v_params), 'TB11', p_now, p_by);
  if v_common ? 'problem' then
    return v_common;
  end if;
  foreach p in array v_params loop
    vs := array(select (s.v ->> p)::numeric * case when p = 'hardness' and v_sweep -> 'hardness' ->> 'unit' = 'kp' then 9.80665 else 1 end
                  from jsonb_array_elements(v_stations) with ordinality s (v, i) order by s.i);
    ti := coalesce(tab.ipc_tiers(v_sweep -> p -> 'individual'), '{"action": {}}'::jsonb);
    v := tab.ipc_worst(array(select tab.ipc_judge(x, ti) from unnest(vs) x));
    v_vs := v_vs || v;
    v_eval := v_eval || jsonb_build_object(p, jsonb_build_object(
      'min', (select trim_scale(min(x))::text from unnest(vs) x), 'max', (select trim_scale(max(x))::text from unnest(vs) x),
      'outside', (select count(*) from unnest(vs) x where tab.ipc_judge(x, ti) = 'FAIL'),
      'outsideAlert', (select count(*) from unnest(vs) x where tab.ipc_judge(x, ti) <> 'PASS'), 'result', v));
  end loop;
  v := tab.ipc_worst(v_vs);
  return jsonb_build_object('data', (v_common -> 'base') || jsonb_build_object('stations', c -> 'stations', 'evaluation', v_eval, 'result', v),
                            'outcome', v, 'manual', v_common -> 'manual', 'late', v_common -> 'late');
end
$$;

-- A test entry of any IPC block (TB-11 passes its nested test configurations).
create function tab.ipc_test_entry(p_kind text, p_cfg jsonb, p_sched boolean, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language sql stable set search_path = pg_catalog, tab, pg_temp as $$
  select case p_kind
    when 'WEIGHT_CHECK' then tab.ipc_weight_check(tab.ipc_tcfg(p_cfg, p_sched, 'weight'), p_cfg, p_sched, p_prior, c, p_markets, p_date, p_now, p_by)
    when 'WEIGHT_SECOND_STAGE' then tab.ipc_second_stage(p_cfg, p_sched, p_prior, c, p_now, p_by)
    when 'PHYSICAL_CHECK' then tab.ipc_physical_check(tab.ipc_tcfg(p_cfg, p_sched, 'physical'), p_cfg, p_sched, p_prior, c, p_now, p_by)
    when 'FRIABILITY_RUN' then tab.ipc_friability_run(tab.ipc_tcfg(p_cfg, p_sched, 'friability'), p_cfg, p_sched, p_prior, c, p_markets, p_date, p_now, p_by)
    when 'DT_START' then tab.ipc_dt_start(tab.ipc_tcfg(p_cfg, p_sched, 'disintegration'), p_cfg, p_sched, p_prior, c, p_markets, p_date, p_now, p_by)
    when 'DT_END' then tab.ipc_dt_end(tab.ipc_tcfg(p_cfg, p_sched, 'disintegration'), p_prior, c, p_markets, p_date, p_now, p_by)
    when 'STATION_SWEEP' then tab.ipc_sweep(p_cfg, p_prior, c, p_now, p_by)
  end
$$;

-- A TB-11 entry (tb-11.ts accept): the run's own entries and its test entries, each with the checks it finds missed.
create function tab.ipc_scheduler_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_started boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_START');
  v_ended   boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_END');
  v_stopped boolean := jsonb_array_length(tab.ipc_of(p_prior, 'STOPPAGE_START')) > jsonb_array_length(tab.ipc_of(p_prior, 'STOPPAGE_END'));
  v_test    text := case p_kind when 'WEIGHT_CHECK' then 'WEIGHT' when 'WEIGHT_SECOND_STAGE' then 'WEIGHT' when 'PHYSICAL_CHECK' then 'PHYSICAL'
                                when 'FRIABILITY_RUN' then 'FRIABILITY' when 'DT_START' then 'DISINTEGRATION' when 'DT_END' then 'DISINTEGRATION' end;
  v_is_test boolean := p_kind = 'STATION_SWEEP' or v_test is not null;
  v_missed  jsonb;
  v_r       jsonb;
  v_data    jsonb;
  v_plan    jsonb;
  v_last    numeric;
  v_slot    text;
  v_prev    numeric;
  s         jsonb;
begin
  if p_kind = 'RUN_START' then
    if v_started then
      return tab.ipc_p('TB11-TWICE', 'the step has started its run already; a new run is a new step');
    end if;
    return jsonb_build_object('data', jsonb_build_object('press', c -> 'press', 'recordedBy', p_by)
                                      || case when c ? 'counter' then jsonb_build_object('counter', c -> 'counter') else '{}'::jsonb end,
                              'outcome', null, 'manual', false, 'late', false);
  end if;
  if not v_started then
    return tab.ipc_p('TB11-NOT-STARTED', 'the step has not started its run');
  end if;
  if v_ended and not v_is_test then
    return tab.ipc_p('TB11-ENDED', 'the run has ended: only its end-of-run checks remain');
  end if;
  if v_stopped and v_is_test then
    return tab.ipc_p('TB11-STOPPED', 'the press is stopped: end the stoppage before sampling');
  end if;
  v_missed := tab.ipc_overdue(p_prior, p_cfg, p_now);
  case p_kind
    when 'STOPPAGE_START' then
      if v_stopped then
        return tab.ipc_p('TB11-STOPPED', 'the press is stopped already');
      end if;
      v_r := jsonb_build_object('data', jsonb_build_object('recordedBy', p_by), 'manual', false, 'late', false);
    when 'STOPPAGE_END' then
      s := tab.ipc_of(p_prior, 'STOPPAGE_START') -> -1;
      if not v_stopped or s is null then
        return tab.ipc_p('TB11-NOT-STOPPED', 'the press is not stopped');
      end if;
      v_r := jsonb_build_object('data', jsonb_build_object('start', s -> 'id', 'seconds', tab.gran_seconds(p_now - recipe.micros_of(s -> 'recordedAt')),
                                                           'long', p_now - recipe.micros_of(s -> 'recordedAt') > coalesce(recipe.duration_us(p_cfg -> 'restartAfter'), 900000000),
                                                           'recordedBy', p_by), 'manual', false, 'late', false);
    when 'CHANGE' then
      v_r := jsonb_build_object('data', jsonb_build_object('change', c -> 'change', 'recordedBy', p_by), 'manual', false, 'late', false);
    when 'RUN_END' then
      if v_stopped then
        return tab.ipc_p('TB11-STOPPED', 'end the stoppage before the run ends');
      end if;
      v_r := jsonb_build_object('data', jsonb_build_object('recordedBy', p_by), 'manual', false, 'late', false);
    else
      if not v_is_test then
        return tab.ipc_p('TB11-ENTRY', format('%s is not an entry of an IPC scheduler step', coalesce(p_kind, '(none)')));
      end if;
      select p into v_plan from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'plan') = 'array' then p_cfg -> 'plan' else '[]'::jsonb end) p where p ->> 'test' = v_test limit 1;
      if v_test is not null and v_plan is null then
        return tab.ipc_p('TB11-NOT-PLANNED', format('%s is not in the test plan of the step', lower(v_test)));
      end if;
      if c ? 'counter' then
        select max((tab.ipc_d(x) ->> 'counter')::numeric) into v_last from jsonb_array_elements(p_prior) x where jsonb_typeof(tab.ipc_d(x) -> 'counter') = 'number';
        if v_last is not null and (c ->> 'counter')::numeric < v_last then
          return tab.ipc_p('TB11-COUNTER-BACK', format('the press counter reads %s, below the %s already recorded', c ->> 'counter', v_last));
        end if;
      end if;
      v_slot := tab.ipc_check_test(p_kind, c);
      if v_slot is not null and jsonb_typeof(v_plan -> 'everyCount') = 'number' and not (c ? 'counter') then
        return tab.ipc_p('TB11-COUNTER', 'the check gives the press counter (its interval is by count too)');
      end if;
      v_r := tab.ipc_test_entry(p_kind, p_cfg, true, p_prior, c, p_markets, p_date, p_now, p_by);
      if v_r ? 'problem' then
        return v_r;
      end if;
      if v_slot is not null and jsonb_typeof(v_plan -> 'everyCount') = 'number' and jsonb_typeof(c -> 'counter') = 'number' then
        select (tab.ipc_d(x.e) ->> 'counter')::numeric into v_prev from jsonb_array_elements(p_prior) with ordinality x (e, i)
         where tab.ipc_check_test(x.e ->> 'kind', tab.ipc_d(x.e)) = v_slot and tab.ipc_d(x.e) ->> 'stream' = c ->> 'stream' and jsonb_typeof(tab.ipc_d(x.e) -> 'counter') = 'number'
         order by x.i desc limit 1;
        if v_prev is null then
          select (tab.ipc_d(x) ->> 'counter')::numeric into v_prev from jsonb_array_elements(p_prior) x
           where x ->> 'kind' = 'RUN_START' and jsonb_typeof(tab.ipc_d(x) -> 'counter') = 'number' limit 1;
        end if;
        if v_prev is not null and (c ->> 'counter')::numeric - v_prev > (v_plan ->> 'everyCount')::numeric
           and not (v_missed @> jsonb_build_array(jsonb_build_object('stream', c ->> 'stream', 'test', v_slot))) then
          v_missed := v_missed || jsonb_build_array(jsonb_build_object('stream', c ->> 'stream', 'test', v_slot, 'by', 'COUNT'));
        end if;
      end if;
  end case;
  v_data := (v_r -> 'data') || case when jsonb_array_length(v_missed) > 0 then jsonb_build_object('missed', v_missed) else '{}'::jsonb end;
  return v_r || jsonb_build_object('data', v_data, 'missed', v_missed);
end
$$;

-- An entry of an IPC step: what its block builds (or why it refuses it).
create function tab.ipc_entry(p_type text, p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language sql stable set search_path = pg_catalog, tab, pg_temp as $$
  select case
    when p_type = 'TB-11' then tab.ipc_scheduler_entry(p_kind, p_cfg, p_prior, c, p_markets, p_date, p_now, p_by)
    when (p_type, p_kind) in (('TB-12', 'WEIGHT_CHECK'), ('TB-12', 'WEIGHT_SECOND_STAGE'), ('TB-13', 'PHYSICAL_CHECK'), ('TB-14', 'FRIABILITY_RUN'),
                              ('TB-15', 'DT_START'), ('TB-15', 'DT_END'))
      then tab.ipc_test_entry(p_kind, p_cfg, false, p_prior, c, p_markets, p_date, p_now, p_by)
    else tab.ipc_p(replace(p_type, '-', '') || '-ENTRY', format('%s is not an entry of a %s step', coalesce(p_kind, '(none)'), p_type))
  end
$$;

revoke all on function tab.ipc_p(text, text), tab.ipc_str(jsonb), tab.ipc_d(jsonb), tab.ipc_tcfg(jsonb, boolean, text),
  tab.ipc_common(jsonb, boolean, jsonb, jsonb, integer, text, numeric, jsonb), tab.ipc_of(jsonb, text), tab.ipc_pending_first(jsonb),
  tab.ipc_weight_check(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, date, numeric, jsonb), tab.ipc_second_stage(jsonb, boolean, jsonb, jsonb, numeric, jsonb),
  tab.ipc_physical_check(jsonb, jsonb, boolean, jsonb, jsonb, numeric, jsonb), tab.ipc_pending_friability(jsonb), tab.ipc_loss(numeric, numeric),
  tab.ipc_friability_run(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, date, numeric, jsonb), tab.ipc_dt_limits_of(jsonb, jsonb, date), tab.ipc_open_starts(jsonb),
  tab.ipc_pending_dt(jsonb, text), tab.ipc_dt_start(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, date, numeric, jsonb),
  tab.ipc_dt_end(jsonb, jsonb, jsonb, jsonb, date, numeric, jsonb), tab.ipc_check_test(text, jsonb), tab.ipc_due(jsonb, jsonb, text, text),
  tab.ipc_overdue(jsonb, jsonb, numeric), tab.ipc_sweep(jsonb, jsonb, jsonb, numeric, jsonb),
  tab.ipc_test_entry(text, jsonb, boolean, jsonb, jsonb, jsonb, date, numeric, jsonb),
  tab.ipc_scheduler_entry(text, jsonb, jsonb, jsonb, jsonb, date, numeric, jsonb), tab.ipc_entry(text, text, jsonb, jsonb, jsonb, jsonb, date, numeric, jsonb) from public;

reset role;
