-- Tablets server, Phase 3 slice 3c (builder B): the calculations of the IPC blocks TB-11 to TB-15 in the database, the
-- twins of src/blocks/ipc/calc.ts and rule-sets.ts (tablets spec C-11 to C-15, C-17, E.1 to E.5; controls IN-34, IN-35,
-- PR-29, DI-10, DI-33). The guards of 0892 rebuild every IPC entry's evaluation with them and refuse an entry whose
-- stored evaluation differs, so the two sides decide exactly alike:
--   * a value relative to a mean is compared without dividing (|n.w - sum| x 100 against p x sum);
--   * a shown value is rounded half away from zero (round()), as calc.ts does (HALF_UP);
--   * a quotient or a square root that is shown is computed at 40 decimals or more before it is rounded;
--   * decimal text is canonical (trim_scale), as Dec writes it.
--   tab.ipc_rule_sets      the rule sets bound for a test: the batch's markets with India always, the in-house table where
--                          the MBR opts in, the tablet type, effective on a date; the latest version of each code; sorted
--                          by code (byte order, as the TypeScript sort)
--   tab.ipc_stats          C-13 statistics (mean 4 decimals, SD 4, RSD and the deviations of min and max 2)
--   tab.ipc_relative_tiers limits of a value +/- a percentage (action and alert)
--   tab.ipc_judge          PASS inside the alert limits, ALERT inside the action limits only, FAIL outside
--   tab.ipc_band, tab.ipc_outside, tab.ipc_uniformity   C-12 per rule set
--   tab.ipc_av             C-14 acceptance value per rule set (first or second stage)
--   tab.ipc_subdivision    subdivision of scored tablets per rule set
--   tab.ipc_friability_sample_problem   the friability sample rule
--   tab.ipc_dt_limits      the disintegration limits from the rule sets and the MBR's own times
--
-- New functions are owned by ebmr_owner and private to the owner; every function pins its search_path with pg_temp last
-- (ADR 0016). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- The decimals of a JSON array of decimal texts, in order (NULL when it is not such an array).
create function tab.ipc_nums(p jsonb) returns numeric[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'array' and not exists (select 1 from jsonb_array_elements(p) x where jsonb_typeof(x) <> 'string')
              then array(select (x.v #>> '{}')::numeric from jsonb_array_elements(p) with ordinality x (v, i) order by x.i) end
$$;

-- C-13 statistics of the values (at least one).
create function tab.ipc_stats(p numeric[]) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  n   numeric := cardinality(p);
  s   numeric;
  sq  numeric;
  mn  numeric;
  mx  numeric;
  sd  numeric;
  o   jsonb;
begin
  select sum(x), sum(x * x), min(x), max(x) into s, sq, mn, mx from unnest(p) x;
  o := jsonb_build_object('n', cardinality(p), 'sum', trim_scale(s)::text, 'mean', round(round(s, 40) / n, 4)::text,
                          'min', trim_scale(mn)::text, 'max', trim_scale(mx)::text,
                          'minDeviation', round(round((n * mn - s) * 100, 40) / s, 2)::text, 'maxDeviation', round(round((n * mx - s) * 100, 40) / s, 2)::text);
  if n > 1 then
    sd := sqrt(round(n * sq - s * s, 40) / (n * (n - 1)));
    o := o || jsonb_build_object('sd', round(sd, 4)::text, 'rsd', round(sd * n * 100 / s, 2)::text);
  end if;
  return o;
end
$$;

-- {min, max} of p_of +/- p_percent %, canonical.
create function tab.ipc_relative(p_of numeric, p_percent numeric) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('min', trim_scale(p_of * (1 - p_percent / 100))::text, 'max', trim_scale(p_of * (1 + p_percent / 100))::text)
$$;

-- Action limits (and alert limits) of p_of +/- the tolerance {action, alert?} in %.
create function tab.ipc_relative_tiers(p_of numeric, p_tol jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select jsonb_build_object('action', tab.ipc_relative(p_of, coalesce((p_tol ->> 'action')::numeric, 0)))
         || case when jsonb_typeof(p_tol -> 'alert') = 'string' then jsonb_build_object('alert', tab.ipc_relative(p_of, (p_tol ->> 'alert')::numeric)) else '{}'::jsonb end
$$;

-- Whether p_v lies outside the bounds {min?, max?} (inclusive).
create function tab.ipc_beyond(p_v numeric, p_b jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_typeof(p_b) = 'object'
         and ((jsonb_typeof(p_b -> 'min') = 'string' and p_v < (p_b ->> 'min')::numeric) or (jsonb_typeof(p_b -> 'max') = 'string' and p_v > (p_b ->> 'max')::numeric))
$$;

create function tab.ipc_judge(p_v numeric, p_t jsonb) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select case when tab.ipc_beyond(p_v, p_t -> 'action') then 'FAIL' when tab.ipc_beyond(p_v, p_t -> 'alert') then 'ALERT' else 'PASS' end
$$;

create function tab.ipc_worst(p text[]) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when 'FAIL' = any (p) then 'FAIL' when 'ALERT' = any (p) then 'ALERT' else 'PASS' end
$$;

-- The tiers of a configuration member {action: {min?, max?}, alert?} as calc.ts reads them (NULL without action).
create function tab.ipc_tiers(p jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'object' and jsonb_typeof(p -> 'action') = 'object' then
    jsonb_build_object('action', jsonb_strip_nulls(jsonb_build_object('min', case when jsonb_typeof(p -> 'action' -> 'min') = 'string' then p -> 'action' -> 'min' end,
                                                                     'max', case when jsonb_typeof(p -> 'action' -> 'max') = 'string' then p -> 'action' -> 'max' end)))
    || case when jsonb_typeof(p -> 'alert') = 'object' then
         jsonb_build_object('alert', jsonb_strip_nulls(jsonb_build_object('min', case when jsonb_typeof(p -> 'alert' -> 'min') = 'string' then p -> 'alert' -> 'min' end,
                                                                         'max', case when jsonb_typeof(p -> 'alert' -> 'max') = 'string' then p -> 'alert' -> 'max' end)))
       else '{}'::jsonb end
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Rule sets (S-8, S-10; IN-34)

create function tab.ipc_rule_sets(p_test text, p_markets jsonb, p_type text, p_date date, p_opt_in boolean) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'version', r.version, 'params', r.params) order by r.code collate "C"), '[]'::jsonb)
    from (select distinct on (c.code) c.*
            from tab.compendial_rule_set c
           where c.test = p_test and p_type is not null and p_type = any (c.tablet_types)
             and (c.markets && (array(select jsonb_array_elements_text(case when jsonb_typeof(p_markets) = 'array' then p_markets else '[]'::jsonb end)) || array['IN'])
                  or (coalesce(p_opt_in, false) and c.pharmacopoeia = 'IN_HOUSE'))
             and c.effective_from <= p_date and (c.effective_to is null or c.effective_to > p_date)
           order by c.code, c.version desc) r
$$;

-- Review 3c finding 5: the batch's markets (IN always) that neither a rule set bound for the test and tablet type nor a
-- not-applicable record covers, sorted (rule-sets.ts uncoveredMarkets).
create function tab.ipc_uncovered(p_test text, p_markets jsonb, p_type text, p_date date) returns text[]
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(array_agg(m order by m collate "C"), '{}')
    from (select distinct m from unnest(array(select jsonb_array_elements_text(case when jsonb_typeof(p_markets) = 'array' then p_markets else '[]'::jsonb end)) || array['IN']) m) x
   where not exists (select 1 from jsonb_array_elements(tab.ipc_rule_sets(p_test, jsonb_build_array(x.m), p_type, p_date, false)) s
                      join tab.compendial_rule_set r on r.code = s ->> 'code' and r.version = (s ->> 'version')::integer where x.m = any (r.markets))
     and not exists (select 1 from tab.compendial_not_applicable n where n.test = p_test and n.market = x.m and n.effective_from <= p_date)
$$;

-- The procedure keys the bound rule sets of a test must agree on (rule-sets.ts PROCEDURE_KEYS).
create function tab.ipc_procedure_keys(p_test text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_test
    when 'UNIFORMITY_OF_WEIGHT' then array['units']
    when 'WEIGHT_VARIATION' then array['firstUnits', 'totalUnits']
    when 'SUBDIVISION' then array['units']
    when 'FRIABILITY' then array['rotations', 'rpmMin', 'rpmMax', 'targetSampleGrams', 'heavyUnitMg', 'heavyUnitCount', 'repeatRuns', 'lossDecimals']
    when 'DISINTEGRATION' then array['units', 'staging']
  end
$$;

-- Why rule sets p_sets cannot be used for a check (common.ts ruleSetRefusal): {problem} naming <code>-NO-RULE-SET or
-- <code>-RULE-SETS-DIFFER; NULL when they can.
create function tab.ipc_rule_set_problem(p_test text, p_sets jsonb, p_markets jsonb, p_type text, p_date date, p_code text) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_open   text[] := tab.ipc_uncovered(p_test, p_markets, p_type, p_date);
  v_differ text[];
begin
  if jsonb_array_length(p_sets) = 0 or cardinality(v_open) > 0 then
    return jsonb_build_object('problem', format('no compendial rule set covers %s tablets for market %s of the batch, and no record says none applies (%s-NO-RULE-SET)',
                                                coalesce(p_type, '(none)'), coalesce(nullif(array_to_string(v_open, ', '), ''), 'IN'), p_code));
  end if;
  v_differ := array(select k from unnest(tab.ipc_procedure_keys(p_test)) with ordinality u (k, i)
                     where (select count(distinct coalesce(s -> 'params' -> k, 'null'::jsonb)) from jsonb_array_elements(p_sets) s) > 1 order by u.i);
  if cardinality(v_differ) > 0 then
    return jsonb_build_object('problem', format('the rule sets bound for this check give different procedures (%s) (%s-RULE-SETS-DIFFER)', array_to_string(v_differ, ', '), p_code));
  end if;
  return null;
end
$$;

-- The rule sets an earlier entry recorded ([{code, version}]) with their parameters, in order.
create function tab.ipc_recorded(p_refs jsonb) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'version', r.version, 'params', r.params) order by x.i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_refs) = 'array' then p_refs else '[]'::jsonb end) with ordinality x (v, i)
    join tab.compendial_rule_set r on r.code = x.v ->> 'code' and r.version = (x.v ->> 'version')::integer
$$;

-- [{code, version}] of rule sets.
create function tab.ipc_refs(p_sets jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', s -> 'code', 'version', s -> 'version') order by i), '[]'::jsonb)
    from jsonb_array_elements(p_sets) with ordinality x (s, i)
$$;

-- C-12: the band (its text) of a uniformity rule set for the average of p_n values summing to p_sum (exact).
create function tab.ipc_band(p_params jsonb, p_sum numeric, p_n numeric) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  b   jsonb;
  lim numeric;
begin
  for b in select x.v from jsonb_array_elements(p_params -> 'bands') with ordinality x (v, i) order by x.i loop
    if not (b ? 'upToMg') then
      return b ->> 'percent';
    end if;
    lim := (b ->> 'upToMg')::numeric * p_n;
    if ((b -> 'inclusive') = 'true'::jsonb and p_sum <= lim) or ((b -> 'inclusive') is distinct from 'true'::jsonb and p_sum < lim) then
      return b ->> 'percent';
    end if;
  end loop;
  return null;
end
$$;

-- Values outside the average +/- p_percent %: |n.w - sum| x 100 > percent x sum.
create function tab.ipc_outside(p_ws numeric[], p_sum numeric, p_percent numeric) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select count(*)::integer from unnest(p_ws) w where abs(cardinality(p_ws) * w - p_sum) * 100 > p_percent * p_sum
$$;

-- C-12 per rule set: [{ruleSet, version, percent, outside, outsideDouble, pass}].
create function tab.ipc_uniformity(p_ws numeric[], p_sets jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('ruleSet', z.code, 'version', z.version, 'percent', z.band, 'outside', z.o1, 'outsideDouble', z.o2,
                                               'pass', z.o1 <= (z.params ->> 'maxOutside')::integer and z.o2 <= (z.params ->> 'maxOutsideDouble')::integer) order by z.i), '[]'::jsonb)
    from (select x.i, x.s -> 'code' as code, x.s -> 'version' as version, x.s -> 'params' as params, y.band,
                 tab.ipc_outside(p_ws, y.total, y.band::numeric) as o1, tab.ipc_outside(p_ws, y.total, y.band::numeric * 2) as o2
            from jsonb_array_elements(p_sets) with ordinality x (s, i),
                 lateral (select (select sum(w) from unnest(p_ws) w) as total) t,
                 lateral (select tab.ipc_band(x.s -> 'params', t.total, cardinality(p_ws)) as band, t.total) y) z
$$;

-- C-14 reference value M.
create function tab.ipc_reference(p_params jsonb, p_x numeric, p_t numeric) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_x < (p_params ->> 'referenceLow')::numeric then (p_params ->> 'referenceLow')::numeric
    when p_x > (case when p_t <= (p_params ->> 'referenceHigh')::numeric then (p_params ->> 'referenceHigh')::numeric else p_t end)
      then case when p_t <= (p_params ->> 'referenceHigh')::numeric then (p_params ->> 'referenceHigh')::numeric else p_t end
    else p_x end
$$;

-- C-14 for one rule set p_set {code, version, params}: contents w x A / mean(w), mean content A, s = A x SD(w) / mean(w),
-- AV = |M - A| + k x s rounded to the rule set's decimals; at the second stage no unit outside M x (1 +/- unit limit %).
create function tab.ipc_av(p_ws numeric[], p_assay numeric, p_target numeric, p_set jsonb, p_second boolean) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  p     jsonb := p_set -> 'params';
  n     numeric := cardinality(p_ws);
  s     numeric;
  sq    numeric;
  m     numeric;
  k     text := p ->> case when p_second then 'secondK' else 'firstK' end;
  sv    numeric;
  av    text;
  pass  boolean;
  u     numeric;
  v_out integer;
  o     jsonb;
begin
  select sum(x), sum(x * x) into s, sq from unnest(p_ws) x;
  m := tab.ipc_reference(p, p_assay, p_target);
  sv := round(p_assay * sqrt(round(n * sq - s * s, 40) / (n * (n - 1))) * n, 40) / s;
  av := round(abs(m - p_assay) + k::numeric * sv, (p ->> 'avDecimals')::integer)::text;
  pass := av::numeric <= (p ->> 'acceptanceLimit')::numeric;
  o := jsonb_build_object('ruleSet', p_set -> 'code', 'version', p_set -> 'version', 'reference', trim_scale(m)::text, 'k', k, 'av', av);
  if p_second then
    u := (p ->> 'unitLimitPercent')::numeric / 100;
    select count(*)::integer into v_out from unnest(p_ws) w where n * w * p_assay < (1 - u) * m * s or n * w * p_assay > (1 + u) * m * s;
    o := o || jsonb_build_object('outsideUnitLimit', v_out);
    pass := pass and v_out = 0;
  end if;
  return o || jsonb_build_object('pass', pass);
end
$$;

-- Subdivision per rule set: [{ruleSet, version, outsideInner, outsideOuter, pass}].
create function tab.ipc_subdivision(p_ws numeric[], p_sets jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('ruleSet', z.code, 'version', z.version, 'outsideInner', z.o1, 'outsideOuter', z.o2,
                                               'pass', z.o1 <= (z.params ->> 'maxOutsideInner')::integer and z.o2 <= (z.params ->> 'maxOutsideOuter')::integer) order by z.i), '[]'::jsonb)
    from (select x.i, x.s -> 'code' as code, x.s -> 'version' as version, x.s -> 'params' as params,
                 tab.ipc_outside(p_ws, t.total, (x.s -> 'params' ->> 'innerPercent')::numeric) as o1,
                 tab.ipc_outside(p_ws, t.total, (x.s -> 'params' ->> 'outerPercent')::numeric) as o2
            from jsonb_array_elements(p_sets) with ordinality x (s, i),
                 lateral (select (select sum(w) from unnest(p_ws) w) as total) t) z
$$;

-- Why a friability sample breaks the rule set's sample rule (whole tablets nearest to 6.5 g up to 650 mg, else 10).
create function tab.ipc_friability_sample_problem(p_params jsonb, p_tablets numeric, p_initial numeric) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_initial * 1000 > (p_params ->> 'heavyUnitMg')::numeric * p_tablets then
      case when p_tablets <> (p_params ->> 'heavyUnitCount')::numeric then format('tablets above %s mg are tested %s at a time, not %s', p_params ->> 'heavyUnitMg', p_params ->> 'heavyUnitCount', p_tablets) end
    when abs(p_initial - (p_params ->> 'targetSampleGrams')::numeric) * 2 * p_tablets > p_initial then
      format('%s tablets weighing %s g are not the whole number of tablets nearest to %s g', p_tablets, trim_scale(p_initial), p_params ->> 'targetSampleGrams')
  end
$$;

-- The disintegration limits for tablet type p_type from the rule sets (the shortest time, the narrowest temperature
-- range, the longest acid stage) and the MBR's own times in seconds: {seconds?, acidSeconds?, tempMin, tempMax, units,
-- staging}; NULL when no rule set covers the type.
create function tab.ipc_dt_limits(p_sets jsonb, p_type text, p_mbr numeric, p_mbr_acid numeric) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_seconds numeric := p_mbr;
  v_acid    numeric;
  v_min     numeric;
  v_max     numeric;
  v_first   jsonb;
  t         jsonb;
  s         jsonb;
begin
  for s in select x.v from jsonb_array_elements(p_sets) with ordinality x (v, i) order by x.i loop
    t := s -> 'params' -> 'types' -> p_type;
    if jsonb_typeof(t) is distinct from 'object' then
      continue;
    end if;
    v_first := coalesce(v_first, s -> 'params');
    if t ? 'minutes' and (v_seconds is null or (t ->> 'minutes')::numeric * 60 < v_seconds) then
      v_seconds := (t ->> 'minutes')::numeric * 60;
    end if;
    if t ? 'acidMinutes' and (v_acid is null or (t ->> 'acidMinutes')::numeric * 60 > v_acid) then
      v_acid := (t ->> 'acidMinutes')::numeric * 60;
    end if;
    if v_min is null or (t ->> 'tempMin')::numeric > v_min then
      v_min := (t ->> 'tempMin')::numeric;
    end if;
    if v_max is null or (t ->> 'tempMax')::numeric < v_max then
      v_max := (t ->> 'tempMax')::numeric;
    end if;
  end loop;
  if v_first is null then
    return null;
  end if;
  if p_mbr_acid is not null then
    v_acid := p_mbr_acid;
  end if;
  return jsonb_build_object('tempMin', trim_scale(v_min)::text, 'tempMax', trim_scale(v_max)::text, 'units', v_first -> 'units', 'staging', v_first -> 'staging')
         || case when v_seconds is not null then jsonb_build_object('seconds', trim_scale(v_seconds)::text) else '{}'::jsonb end
         || case when v_acid is not null then jsonb_build_object('acidSeconds', trim_scale(v_acid)::text) else '{}'::jsonb end;
end
$$;

revoke all on function tab.ipc_nums(jsonb), tab.ipc_stats(numeric[]), tab.ipc_relative(numeric, numeric), tab.ipc_relative_tiers(numeric, jsonb),
  tab.ipc_beyond(numeric, jsonb), tab.ipc_judge(numeric, jsonb), tab.ipc_worst(text[]), tab.ipc_tiers(jsonb),
  tab.ipc_rule_sets(text, jsonb, text, date, boolean), tab.ipc_refs(jsonb), tab.ipc_uncovered(text, jsonb, text, date), tab.ipc_procedure_keys(text),
  tab.ipc_rule_set_problem(text, jsonb, jsonb, text, date, text), tab.ipc_recorded(jsonb), tab.ipc_band(jsonb, numeric, numeric),
  tab.ipc_outside(numeric[], numeric, numeric), tab.ipc_uniformity(numeric[], jsonb), tab.ipc_reference(jsonb, numeric, numeric),
  tab.ipc_av(numeric[], numeric, numeric, jsonb, boolean), tab.ipc_subdivision(numeric[], jsonb),
  tab.ipc_friability_sample_problem(jsonb, numeric, numeric), tab.ipc_dt_limits(jsonb, text, numeric, numeric) from public;

reset role;
