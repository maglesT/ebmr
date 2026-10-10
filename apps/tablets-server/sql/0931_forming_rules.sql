-- Tablets server, Phase 3 slice 3d (builder B): what each entry of the forming blocks TB-06 (roller compaction) and
-- TB-16 (bilayer compression) holds, built in the database exactly as src/blocks/tb-06.ts and tb-16.ts build it (tablets
-- spec B.2 TB-06, TB-16, C-09; controls IN-26, IN-35, IN-36, PR-21, PR-29, DI-29; ADR 0012: the rules hold when the
-- application's own database credentials are used directly). The guard of 0932 compares a new entry's data with what
-- these functions build and refuses it when it differs or when they refuse it.
--
--   tab.forming_ribbon_due, tab.forming_ribbon_overdue   TB-06: when the ribbon check falls due (one interval after the
--                              last check, or the last entry that marked it missed, or the run's start; at the latest at
--                              the end of the run; nothing after an end-of-run check) and whether it is missed at an
--                              instant (beyond the grace), at database time
--   tab.compaction_entry       TB-06: the run's start and end, the feed, the ribbon check judged against its tiers and
--                              its appearance, the mill screen checks as TB-02's rule (a screen damaged at a TB-02 or
--                              TB-06 step of the batch never checked again: stricter than the engine, which sees its own
--                              step), the granule output through a screen in use, the fines recycled within the MBR's
--                              percentage of the pre-blend fed and never above the fines discharged, the yield (C-09);
--                              each entry with the ribbon check it finds missed
--   tab.bilayer_layer_cfg, tab.bilayer_missed, tab.bilayer_entry   TB-16: each layer is a TB-11 run of one stream (the
--                              layer's plan and test configurations; the last layer, the full tablets, a compression run
--                              with its sweep), so a run or test entry is what tab.ipc_scheduler_entry (tablets 0892)
--                              builds for its layer, with the checks missed on every layer
--
-- Each returns {data, ...} or {problem}; a problem names the block's rule code. New functions are owned by ebmr_owner and
-- private to the owner; every function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- TB-06

-- When the ribbon check of the run in p_prior (the step's entries, in order) falls due, in microseconds; NULL when nothing
-- is due (tb-06.ts ribbonDue).
create function tab.forming_ribbon_due(p_prior jsonb, p_cfg jsonb) returns numeric
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_start numeric;
  v_end   numeric;
  v_every numeric := recipe.duration_us(p_cfg -> 'ribbon' -> 'every');
  v_base  numeric;
  v_due   numeric;
begin
  select recipe.micros_of(x -> 'recordedAt') into v_start from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'RUN_START' order by i limit 1;
  if v_start is null or v_every is null then
    return null;
  end if;
  select greatest(v_start, max(recipe.micros_of(x -> 'recordedAt'))) into v_base from jsonb_array_elements(p_prior) x
   where x ->> 'kind' = 'RIBBON_CHECK'
      or (jsonb_typeof(tab.ipc_d(x) -> 'missed') = 'array' and tab.ipc_d(x) -> 'missed' @> '[{"stream": "RIBBON"}]'::jsonb);
  v_base := coalesce(v_base, v_start);
  select recipe.micros_of(x -> 'recordedAt') into v_end from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'RUN_END' order by i limit 1;
  if v_end is not null and v_base >= v_end then
    return null;
  end if;
  v_due := v_base + v_every;
  return case when v_end is not null and v_end < v_due then v_end else v_due end;
end
$$;

-- The ribbon check missed at p_now: [] or [{stream: RIBBON, test: RIBBON, by: TIME, dueUs}] (tb-06.ts ribbonOverdue).
create function tab.forming_ribbon_overdue(p_prior jsonb, p_cfg jsonb, p_now numeric) returns jsonb
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select case when d.due is not null and p_now > d.due + coalesce(recipe.duration_us(p_cfg -> 'ribbon' -> 'grace'), 0)
              then jsonb_build_array(jsonb_build_object('stream', 'RIBBON', 'test', 'RIBBON', 'by', 'TIME', 'dueUs', d.due::text))
              else '[]'::jsonb end
    from (select tab.forming_ribbon_due(p_prior, p_cfg) as due) d
$$;

-- The total of member p_member ({value, unit}) of the entries of kind p_kind in p_prior.
create function tab.forming_total(p_prior jsonb, p_kind text, p_member text) returns numeric
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(sum((tab.ipc_d(x) -> p_member ->> 'value')::numeric), 0) from jsonb_array_elements(p_prior) x where x ->> 'kind' = p_kind
$$;

-- A percentage of two decimals, half away from zero (calc.ts fixed(a x 100 / b, 2)): for display only, never compared.
create function tab.forming_percent(p_a numeric, p_b numeric) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select round(round(p_a * 100, 40) / p_b, 2)::text
$$;

-- What a TB-06 entry of kind p_kind holds (tb-06.ts accept, the block's own kinds): {data, raise: [types], alerts:
-- [types], verify} or {problem}. p_prior: the step's entries before it, in order; p_batch_checks: the SCREEN_CHECK entries
-- of the batch's TB-02 and TB-06 steps already recorded.
create function tab.compaction_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_now numeric, p_by jsonb, p_batch_checks jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_started boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_START');
  v_ended   boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_END');
  v_yielded boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'YIELD');
  v_unit    text := (select tab.ipc_d(x) -> 'quantity' ->> 'unit' from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'FEED' order by i limit 1);
  v_missed  jsonb := '[]'::jsonb;
  v_raise   text[] := '{}';
  v_alerts  text[] := '{}';
  v_verify  boolean := false;
  v_data    jsonb;
  v_r       jsonb;
  v_x       jsonb;
  v_eval    jsonb;
  v_vs      text[];
  v_v       text;
  v_state   text;
  v_n       numeric;
  v_feed    numeric;
  v_rec     numeric;
  v_g       numeric;
  v_f       numeric;
  v_net     numeric;
  v_pct     text;
  p         text;
begin
  if p_kind = 'RUN_START' then
    if v_started then
      return tab.ipc_p('TB06-TWICE', 'the step has started its run already; a new run is a new step');
    end if;
    return jsonb_build_object('data', jsonb_build_object('press', c -> 'press', 'recordedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
  end if;
  if p_kind not in ('FEED', 'RIBBON_CHECK', 'SCREEN_CHECK', 'GRANULE_OUTPUT', 'FINES_RECYCLED', 'RUN_END', 'YIELD') then
    return tab.ipc_p('TB06-ENTRY', format('%s is not an entry of a roller compaction step', coalesce(p_kind, '(none)')));
  end if;
  if not v_started and p_kind <> 'SCREEN_CHECK' then
    return tab.ipc_p('TB06-NOT-STARTED', 'the step has not started its run');
  end if;
  if v_ended and p_kind in ('FEED', 'FINES_RECYCLED', 'RUN_END') then
    return tab.ipc_p('TB06-ENDED', 'the run has ended');
  end if;
  if v_yielded and p_kind in ('GRANULE_OUTPUT', 'YIELD') then
    return tab.ipc_p('TB06-AFTER-YIELD', 'the yield is recorded: nothing more is discharged');
  end if;
  if v_started then
    v_missed := tab.forming_ribbon_overdue(p_prior, p_cfg, p_now);
  end if;
  case p_kind
    when 'FEED' then
      if v_unit is not null and (c -> 'quantity' ->> 'unit') is distinct from v_unit then
        return tab.ipc_p('TB06-UNIT', format('the step''s quantities are in %s', v_unit));
      end if;
      v_data := jsonb_build_object('quantity', tab.gran_qty(c -> 'quantity'), 'recordedBy', p_by);
    when 'RIBBON_CHECK' then
      v_r := p_cfg -> 'ribbon';
      if jsonb_typeof(v_r) is distinct from 'object' then
        return tab.ipc_p('TB06-NO-RIBBON', 'the step has no ribbon checks in its MBR');
      end if;
      if array(select k from unnest(array['thickness', 'density', 'solidFraction']) with ordinality u (k, i) where c ? k order by i)
         <> array(select k from unnest(array['thickness', 'density', 'solidFraction']) with ordinality u (k, i) where jsonb_typeof(v_r -> k) = 'object' order by i) then
        return tab.ipc_p('TB06-RIBBON-PARAMETERS', 'a ribbon check gives exactly the parameters the MBR examines');
      end if;
      v_eval := '{}'::jsonb;
      v_data := '{}'::jsonb;
      foreach p in array array['thickness', 'density', 'solidFraction'] loop
        continue when jsonb_typeof(v_r -> p) is distinct from 'object';
        v_v := tab.ipc_judge((c ->> p)::numeric, coalesce(tab.ipc_tiers(v_r -> p), '{"action": {}}'::jsonb));
        v_eval := v_eval || jsonb_build_object(p, v_v);
        v_vs := v_vs || v_v;
        v_data := v_data || jsonb_build_object(p, c -> p);
      end loop;
      v_v := case when c ->> 'appearance' = 'COMPLIES' then 'PASS' else 'FAIL' end;
      v_eval := v_eval || jsonb_build_object('appearance', v_v);
      v_vs := v_vs || v_v;
      v_v := tab.ipc_worst(v_vs);
      v_data := v_data || jsonb_build_object('appearance', c -> 'appearance', 'evaluation', v_eval, 'result', v_v, 'recordedBy', p_by);
      if v_v = 'FAIL' then
        v_raise := v_raise || 'RIBBON_CHECK_FAILED'::text;
      elsif v_v = 'ALERT' then
        v_alerts := v_alerts || 'RIBBON_CHECK_ALERT'::text;
      end if;
    when 'SCREEN_CHECK' then
      select s.v into v_x from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'screens') = 'array' then p_cfg -> 'screens' else '[]'::jsonb end) with ordinality s (v, i)
       where s.v ->> 'id' = c ->> 'screen' order by s.i limit 1;
      if v_x is null then
        return tab.ipc_p('TB06-SCREEN', format('%s is not a mill screen the MBR lists', coalesce(c ->> 'screen', '(none)')));
      end if;
      if (c -> 'aperture' ->> 'unit') is distinct from (v_x -> 'aperture' ->> 'unit')
         or (c -> 'aperture' ->> 'value')::numeric is distinct from (v_x -> 'aperture' ->> 'value')::numeric then
        return tab.ipc_p('TB06-APERTURE', format('screen %s does not have the aperture the MBR approves', c ->> 'screen'));
      end if;
      if exists (select 1 from jsonb_array_elements(p_batch_checks) s where tab.ipc_d(s) ->> 'screen' = c ->> 'screen' and tab.ipc_d(s) ->> 'result' = 'DAMAGED') then
        return tab.ipc_p('TB06-SCREEN-DAMAGED', format('screen %s was found damaged in this batch and is never used again', c ->> 'screen'));
      end if;
      select case when tab.ipc_d(s) ->> 'when' = 'BEFORE' then 'IN_USE' else 'IDLE' end into v_state
        from jsonb_array_elements(p_prior) with ordinality y (s, i) where s ->> 'kind' = 'SCREEN_CHECK' and tab.ipc_d(s) ->> 'screen' = c ->> 'screen' order by i desc limit 1;
      v_state := coalesce(v_state, 'IDLE');
      if (c ->> 'when' = 'BEFORE' and v_state = 'IN_USE') or (c ->> 'when' = 'AFTER' and v_state <> 'IN_USE') then
        return tab.ipc_p('TB06-CHECK-ORDER', format('a %s check of screen %s, which is %s', c ->> 'when', c ->> 'screen', case v_state when 'IN_USE' then 'in use' else 'not checked before use' end));
      end if;
      v_data := jsonb_build_object('screen', c -> 'screen', 'aperture', tab.gran_qty(c -> 'aperture'), 'when', c -> 'when', 'result', c -> 'result', 'checkedBy', p_by);
      if c ->> 'result' = 'DAMAGED' and c ->> 'when' = 'AFTER' then
        select coalesce(max((s ->> 'recordedSeq')::numeric), -1) into v_n from jsonb_array_elements(p_prior) s
         where s ->> 'kind' = 'SCREEN_CHECK' and tab.ipc_d(s) ->> 'screen' = c ->> 'screen' and tab.ipc_d(s) ->> 'result' = 'INTACT';
        v_data := v_data || jsonb_build_object('held', (select coalesce(jsonb_agg(s -> 'id' order by i), '[]'::jsonb) from jsonb_array_elements(p_prior) with ordinality y (s, i)
                                                         where s ->> 'kind' = 'GRANULE_OUTPUT' and tab.ipc_d(s) ->> 'screen' = c ->> 'screen' and (s ->> 'recordedSeq')::numeric > v_n));
        v_raise := v_raise || 'SCREEN_INTEGRITY_FAILED'::text;
      elsif c ->> 'result' = 'DAMAGED' then
        v_alerts := v_alerts || 'SCREEN_DAMAGED'::text;
      end if;
      v_verify := true;
    when 'GRANULE_OUTPUT' then
      select case when tab.ipc_d(s) ->> 'result' = 'DAMAGED' then 'DAMAGED' when tab.ipc_d(s) ->> 'when' = 'BEFORE' then 'IN_USE' else 'IDLE' end into v_state
        from jsonb_array_elements(p_prior) with ordinality y (s, i) where s ->> 'kind' = 'SCREEN_CHECK' and tab.ipc_d(s) ->> 'screen' = c ->> 'screen' order by i desc limit 1;
      if v_state is distinct from 'IN_USE' then
        return tab.ipc_p('TB06-NO-PRE-CHECK', format('mill screen %s has no intact check before this use', coalesce(c ->> 'screen', '(none)')));
      end if;
      if v_unit is null then
        return tab.ipc_p('TB06-NO-FEED', 'the step has fed no pre-blend');
      end if;
      if (c -> 'granules' ->> 'unit') is distinct from v_unit or (c -> 'fines' ->> 'unit') is distinct from v_unit then
        return tab.ipc_p('TB06-UNIT', format('the step''s quantities are in %s', v_unit));
      end if;
      v_data := jsonb_build_object('screen', c -> 'screen', 'granules', jsonb_build_object('value', c -> 'granules' -> 'value', 'unit', v_unit),
                                   'fines', jsonb_build_object('value', c -> 'fines' -> 'value', 'unit', v_unit), 'recordedBy', p_by);
    when 'FINES_RECYCLED' then
      if jsonb_typeof(p_cfg -> 'finesRecycle') is distinct from 'object' or jsonb_typeof(p_cfg -> 'finesRecycle' -> 'maxPercent') is distinct from 'string' then
        return tab.ipc_p('TB06-RECYCLE-NOT-ALLOWED', 'the MBR allows no fines recycle at this step');
      end if;
      if v_unit is null or (c -> 'quantity' ->> 'unit') is distinct from v_unit then
        return tab.ipc_p('TB06-UNIT', format('the step''s quantities are in %s', coalesce(v_unit, 'the unit of its feed')));
      end if;
      v_rec := tab.forming_total(p_prior, 'FINES_RECYCLED', 'quantity') + (c -> 'quantity' ->> 'value')::numeric;
      if v_rec > tab.forming_total(p_prior, 'GRANULE_OUTPUT', 'fines') then
        return tab.ipc_p('TB06-FINES-QUANTITY', 'more fines would be recycled than were discharged');
      end if;
      v_feed := tab.forming_total(p_prior, 'FEED', 'quantity');
      if v_rec * 100 > (p_cfg -> 'finesRecycle' ->> 'maxPercent')::numeric * v_feed then
        return tab.ipc_p('TB06-FINES-LIMIT', format('the fines recycled would come to more than the MBR''s %s %% of the pre-blend fed', p_cfg -> 'finesRecycle' ->> 'maxPercent'));
      end if;
      v_data := jsonb_build_object('quantity', jsonb_build_object('value', c -> 'quantity' -> 'value', 'unit', v_unit), 'recycledPercent', tab.forming_percent(v_rec, v_feed), 'recordedBy', p_by);
    when 'RUN_END' then
      v_data := jsonb_build_object('recordedBy', p_by);
    else
      if not v_ended then
        return tab.ipc_p('TB06-RUNNING', 'the run has not ended: the yield comes after it');
      end if;
      if v_unit is null then
        return tab.ipc_p('TB06-NO-FEED', 'the step has fed no pre-blend');
      end if;
      v_feed := tab.forming_total(p_prior, 'FEED', 'quantity');
      v_g := tab.forming_total(p_prior, 'GRANULE_OUTPUT', 'granules');
      v_f := tab.forming_total(p_prior, 'GRANULE_OUTPUT', 'fines');
      v_rec := tab.forming_total(p_prior, 'FINES_RECYCLED', 'quantity');
      v_net := v_g + v_f - v_rec;
      v_pct := case when v_feed = 0 then '0.00' else tab.forming_percent(v_net, v_feed) end;
      v_data := jsonb_build_object('unit', v_unit, 'feed', trim_scale(v_feed)::text, 'granules', trim_scale(v_g)::text, 'fines', trim_scale(v_f)::text,
                                   'recycled', trim_scale(v_rec)::text, 'net', trim_scale(v_net)::text, 'yieldPercent', v_pct, 'recordedBy', p_by);
      if jsonb_typeof(p_cfg -> 'yield') = 'object' then
        -- Review 3d: the exact yield (net x 100 against limit x feed), never the rounded display value, against the limits.
        v_data := v_data || jsonb_build_object('withinLimits', v_feed > 0 and not ((jsonb_typeof(p_cfg -> 'yield' -> 'min') = 'string' and v_net * 100 < (p_cfg -> 'yield' ->> 'min')::numeric * v_feed)
                                                                  or (jsonb_typeof(p_cfg -> 'yield' -> 'max') = 'string' and v_net * 100 > (p_cfg -> 'yield' ->> 'max')::numeric * v_feed)));
        if (v_data -> 'withinLimits') = 'false'::jsonb then
          v_raise := v_raise || 'COMPACTION_YIELD_OUT_OF_RANGE'::text;
        end if;
      end if;
  end case;
  if jsonb_array_length(v_missed) > 0 then
    v_data := v_data || jsonb_build_object('missed', v_missed);
    v_raise := v_raise || 'RIBBON_CHECK_MISSED'::text;
  end if;
  return jsonb_build_object('data', v_data, 'raise', to_jsonb(v_raise), 'alerts', to_jsonb(v_alerts), 'verify', v_verify, 'missed', v_missed);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- TB-16

-- The TB-11 configuration of layer p_i (0-based) of TB-16 configuration p_cfg (tb-16.ts layerConfig).
create function tab.bilayer_layer_cfg(p_cfg jsonb, p_i integer) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('process', case when x.last then 'COMPRESSION' else 'OTHER' end, 'streams', jsonb_build_array(jsonb_build_object('id', x.l -> 'id')),
                            'plan', x.l -> 'plan', 'grace', p_cfg -> 'grace')
         || case when p_cfg ? 'restartAfter' then jsonb_build_object('restartAfter', p_cfg -> 'restartAfter') else '{}'::jsonb end
         || case when p_cfg ? 'lateEntry' then jsonb_build_object('lateEntry', p_cfg -> 'lateEntry') else '{}'::jsonb end
         || case when x.last and x.l ? 'sweep' then jsonb_build_object('sweep', x.l -> 'sweep') else '{}'::jsonb end
         || coalesce((select jsonb_object_agg(k, x.l -> k) from unnest(array['weight', 'physical', 'friability', 'disintegration']) k where x.l ? k), '{}'::jsonb)
    from (select coalesce(p_cfg -> 'layers' -> p_i, '{}'::jsonb) as l,
                 p_i = jsonb_array_length(case when jsonb_typeof(p_cfg -> 'layers') = 'array' then p_cfg -> 'layers' else '[]'::jsonb end) - 1 as last) x
$$;

-- The layers of a TB-16 configuration, in order: [{id, stage, hopper, ...}].
create function tab.bilayer_layers(p_cfg jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_cfg -> 'layers') = 'array' then p_cfg -> 'layers' else '[]'::jsonb end
$$;

-- The checks missed on every layer at p_now, layer by layer in their order (tb-16.ts missedOf).
create function tab.bilayer_missed(p_prior jsonb, p_cfg jsonb, p_now numeric) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(m.v order by l.i, m.j), '[]'::jsonb)
    from jsonb_array_elements(tab.bilayer_layers(p_cfg)) with ordinality l (v, i),
         jsonb_array_elements(tab.ipc_overdue(p_prior, tab.bilayer_layer_cfg(p_cfg, (l.i - 1)::integer), p_now)) with ordinality m (v, j)
$$;

-- What a TB-16 run or test entry holds (tb-16.ts accept, TB-11's kinds): what tab.ipc_scheduler_entry builds for its
-- layer, with the checks missed on every layer; or {problem}.
create function tab.bilayer_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_markets jsonb, p_date date, p_now numeric, p_by jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_layers jsonb := tab.bilayer_layers(p_cfg);
  v_i      integer := jsonb_array_length(tab.bilayer_layers(p_cfg)) - 1;
  v_open   text;
  v_r      jsonb;
  v_m      jsonb;
begin
  if p_kind is null or p_kind not in ('RUN_START', 'STOPPAGE_START', 'STOPPAGE_END', 'CHANGE', 'RUN_END', 'STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE',
                                      'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END') then
    return tab.ipc_p('TB16-ENTRY', format('%s is not an entry of a bilayer compression step', coalesce(p_kind, '(none)')));
  end if;
  if p_kind = 'RUN_START' then
    select string_agg(l ->> 'id', ', ' order by i) into v_open from jsonb_array_elements(v_layers) with ordinality y (l, i)
     where not exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'HOPPER_CHARGE' and tab.ipc_d(x) -> 'layer' = l -> 'id');
    if v_open is not null then
      return tab.ipc_p('TB16-LAYER-UNCHARGED', format('layer %s has no blend charged into its hopper: the run starts with every layer''s kit charged', v_open));
    end if;
  end if;
  if p_kind in ('STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END') then
    select (i - 1)::integer into v_i from jsonb_array_elements(v_layers) with ordinality y (l, i) where l -> 'id' = c -> 'stream' and jsonb_typeof(c -> 'stream') = 'string' order by i limit 1;
    if not found then
      return tab.ipc_p('TB16-STREAM', 'a check names the stream of one of the step''s layers');
    end if;
  end if;
  v_r := tab.ipc_scheduler_entry(p_kind, tab.bilayer_layer_cfg(p_cfg, v_i), p_prior, c, p_markets, p_date, p_now, p_by);
  if v_r ? 'problem' or p_kind = 'RUN_START' then
    return v_r || jsonb_build_object('layer', v_i);
  end if;
  v_m := tab.bilayer_missed(p_prior, p_cfg, p_now);
  return v_r || jsonb_build_object('data', ((v_r -> 'data') - 'missed') || case when jsonb_array_length(v_m) > 0 then jsonb_build_object('missed', v_m) else '{}'::jsonb end,
                                   'missed', v_m, 'layer', v_i);
end
$$;

-- IN-35, PR-07, PR-29, PR-21: why a TB-16 configuration p_cfg breaks the rules of a bilayer run (header of tb-16.ts
-- checkConfig: two or three distinct layers; plans by time with a risk assessment; every layer within the compression
-- ceiling of tab.ipc_rule; layer-only samples a weight check with in-house limits; the full tablets with total weight,
-- the layer-separation check and the sweep), or NULL.
create function tab.bilayer_plan_problem(p_cfg jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_layers  jsonb := tab.bilayer_layers(p_cfg);
  v_n       integer := jsonb_array_length(tab.bilayer_layers(p_cfg));
  v_ceiling numeric;
  v_grace   numeric := recipe.duration_us(p_cfg -> 'grace');
  l         jsonb;
  i         integer;
  v_plan    jsonb;
  v_fast    numeric;
begin
  if v_n not between 2 and 3 or (select count(distinct x ->> 'id') from jsonb_array_elements(v_layers) x) <> v_n
     or (select count(distinct x ->> 'hopper') from jsonb_array_elements(v_layers) x) <> v_n or (select count(distinct x ->> 'stage') from jsonb_array_elements(v_layers) x) <> v_n then
    return 'its layers are not two or three with distinct streams, hoppers and blends (TB16-LAYERS)';
  end if;
  select value::numeric * 60000000 into v_ceiling from tab.ipc_rule where key = 'tablets.compression.ipcSampleMaxInterval';
  for l, i in select y.l, (y.i - 1)::integer from jsonb_array_elements(v_layers) with ordinality y (l, i) loop
    v_plan := case when jsonb_typeof(l -> 'plan') = 'array' then l -> 'plan' else '[]'::jsonb end;
    if jsonb_array_length(v_plan) = 0 or exists (select 1 from jsonb_array_elements(v_plan) p where jsonb_typeof(p -> 'qrmRef') is distinct from 'string') then
      return format('a test of the plan of layer %s names no risk assessment for its frequency (TB16-QRM; PR-07)', l ->> 'id');
    end if;
    if exists (select 1 from jsonb_array_elements(v_plan) p where p ? 'everyCount') then
      return format('layer %s plans by press count; a layer plans by time only (TB16-PLAN)', l ->> 'id');
    end if;
    select min(recipe.duration_us(p -> 'every')) into v_fast from jsonb_array_elements(v_plan) p;
    if v_fast is null or v_grace is null or v_fast + v_grace > v_ceiling then
      return format('layer %s''s most frequent test plus the grace exceeds the %s min between compression samples (TB16-CEILING; IN-35 (c))', l ->> 'id', trim_scale(v_ceiling / 60000000));
    end if;
    if i < v_n - 1 then
      if exists (select 1 from jsonb_array_elements(v_plan) p where p ->> 'test' <> 'WEIGHT') or l -> 'weight' ->> 'mode' is null
         or l -> 'weight' ->> 'mode' not in ('GROUP', 'INDIVIDUAL') or l ? 'sweep' then
        return format('layer %s is sampled alone: a weight check with in-house limits (GROUP or INDIVIDUAL) and nothing else (TB16-LAYER-ONLY)', l ->> 'id');
      end if;
    else
      if not exists (select 1 from jsonb_array_elements(v_plan) p where p ->> 'test' = 'WEIGHT') or not exists (select 1 from jsonb_array_elements(v_plan) p where p ->> 'test' = 'PHYSICAL')
         or jsonb_typeof(l -> 'physical' -> 'defects') is distinct from 'array' or not ((l -> 'physical' -> 'defects') ? 'LAMINATION') then
        return format('the full tablets of layer %s are checked for their total weight and for layer separation (a physical check examining LAMINATION) (TB16-SEPARATION)', l ->> 'id');
      end if;
      if jsonb_typeof(l -> 'sweep') is distinct from 'object' then
        return format('the full tablets of layer %s start with a station sweep (TB11-NO-SWEEP; IN-35 (b))', l ->> 'id');
      end if;
    end if;
  end loop;
  return null;
end
$$;

revoke all on function tab.forming_ribbon_due(jsonb, jsonb), tab.forming_ribbon_overdue(jsonb, jsonb, numeric), tab.forming_total(jsonb, text, text),
  tab.forming_percent(numeric, numeric), tab.compaction_entry(text, jsonb, jsonb, jsonb, numeric, jsonb, jsonb), tab.bilayer_layer_cfg(jsonb, integer),
  tab.bilayer_layers(jsonb), tab.bilayer_missed(jsonb, jsonb, numeric), tab.bilayer_entry(text, jsonb, jsonb, jsonb, jsonb, date, numeric, jsonb),
  tab.bilayer_plan_problem(jsonb) from public;

reset role;
