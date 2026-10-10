-- Tablets server, Phase 3 slice 3d (builder A): the calculations of the coating and finishing blocks, computed by the
-- database exactly as src/blocks/coating/calc.ts, common.ts and tb-20.ts compute them (tablets spec C-16, TB-18, TB-20;
-- D-S3-2; controls IN-37, PR-08, PR-29, DI-10, DI-29, INV-25; ADR 0012). The guard of tablets 0912 compares a new entry's
-- data with what these functions build and refuses it when it differs or when they refuse it.
--
--   tab.coat_fixed, tab.coat_round       q / 10^k with exactly k decimals; num / den rounded half away from zero (numeric
--                                        div is exact truncation, so the rounding is decided on the exact ratio)
--   tab.coat_sample                      a tablet sample (group total or every weight) of the MBR's count: its total in mg
--                                        (g converted exactly), the mean rounded half away from zero to 6 decimals
--   tab.coat_gain, tab.coat_gain_cmp     C-16 weight gain (%) from the coated total and count and the stored core mean,
--                                        4 decimals; the exact comparison with a minimum or maximum (no division)
--   tab.aql_letter_for, tab.aql_evaluate the sample-size code letter of a lot and the AQL evaluation of TB-20 from the
--                                        scheme's tables (tablets 0910), shaped as tb-20.ts evaluateAql
--   tab.aql_severity                     the switching rule over the product's earlier lots (tab.aql_lot_result): normal
--                                        until 2 of at most 5 consecutive lots are not accepted, then tightened until 5
--                                        consecutive lots are accepted; never reduced
--
-- Each returns NULL or {problem} where the block refuses. New functions are owned by ebmr_owner and private to the
-- owner; every function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- q / 10^k written with exactly k decimals (calc.ts fixedText).
create function tab.coat_fixed(p_q numeric, p_k integer) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select round(p_q / (10::numeric ^ p_k), p_k)::text
$$;

-- p_num / p_den rounded half away from zero to an integer (calc.ts roundHalfAway); p_den <> 0.
create function tab.coat_round(p_num numeric, p_den numeric) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select sign(p_num) * sign(p_den) * div(2 * abs(p_num) + abs(p_den), 2 * abs(p_den))
$$;

-- The canonical text of a decimal (no trailing fractional zeros; calc.ts plainText).
create function tab.coat_plain(p numeric) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select trim_scale(p)::text
$$;

-- A sample of tablet weights (common.ts sampleOf) in entry p_c, of p_count tablets: {data} as the block stores it before
-- the person, or {problem}.
create function tab.coat_sample(p_c jsonb, p_count text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_count numeric;
  v_total numeric;
  v_mg    numeric;
  v_base  jsonb;
begin
  if p_c ->> 'count' is distinct from p_count then
    return jsonb_build_object('problem', format('the sample is %s tablets as the MBR sets it, not %s (TB18-SAMPLE)', p_count, coalesce(p_c ->> 'count', '(none)')));
  end if;
  v_count := (p_c ->> 'count')::numeric;
  if p_c ->> 'weighing' = 'GROUP' then
    if jsonb_typeof(p_c -> 'total') is distinct from 'string' or p_c ? 'weights' then
      return jsonb_build_object('problem', 'a group weighing records one total and no single weights (TB18-SAMPLE)');
    end if;
    v_total := (p_c ->> 'total')::numeric;
    v_base := jsonb_build_object('total', p_c -> 'total');
  elsif p_c ->> 'weighing' = 'INDIVIDUAL' then
    if jsonb_typeof(p_c -> 'weights') is distinct from 'array' or p_c ? 'total' or jsonb_array_length(p_c -> 'weights') <> v_count then
      return jsonb_build_object('problem', format('weighing one by one records each of the %s tablet weights and no total (TB18-SAMPLE)', p_c ->> 'count'));
    end if;
    select sum(w::numeric) into v_total from jsonb_array_elements_text(p_c -> 'weights') w;
    v_base := jsonb_build_object('weights', p_c -> 'weights');
  else
    return jsonb_build_object('problem', 'a sample is weighed as a group or one by one (TB18-SAMPLE)');
  end if;
  v_mg := case p_c ->> 'unit' when 'mg' then v_total when 'g' then v_total * 1000 end;
  if v_mg is null then
    return jsonb_build_object('problem', 'a tablet sample is weighed in mg or g (TB18-SAMPLE)');
  end if;
  return jsonb_build_object('data', v_base || jsonb_build_object('instrument', p_c -> 'instrument', 'weighing', p_c -> 'weighing', 'count', p_c -> 'count', 'unit', p_c -> 'unit',
                                                                 'totalMg', tab.coat_plain(v_mg), 'meanMg', tab.coat_fixed(tab.coat_round(v_mg * 1000000, v_count), 6)));
end
$$;

-- C-16 (calc.ts weightGain): (coated total - n x core mean) x 100 / (n x core mean), 4 decimals.
create function tab.coat_gain(p_total_mg numeric, p_count numeric, p_core_mg numeric) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select tab.coat_fixed(tab.coat_round((p_total_mg - p_count * p_core_mg) * 100 * 10000, p_count * p_core_mg), 4)
$$;

-- The sign of (exact weight gain - p_percent), without dividing (calc.ts compareGain).
create function tab.coat_gain_cmp(p_total_mg numeric, p_count numeric, p_core_mg numeric, p_percent numeric) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select sign((p_total_mg - p_count * p_core_mg) * 100 - p_percent * p_count * p_core_mg)::integer
$$;

-- ---------------------------------------------------------------------------------------------
-- The attribute sampling scheme (aql.ts)

-- Table I: the letter for a lot of p_lot units at level p_level (I, II, III); NULL off the table.
create function tab.aql_letter_for(p_lot numeric, p_level text) returns text
language sql stable set search_path = pg_catalog, tab, pg_temp as $$
  select case p_level when 'I' then s.level_i when 'II' then s.level_ii when 'III' then s.level_iii end
    from tab.aql_sample_code s
   where s.code = 'AQL-SINGLE-SAMPLING' and s.version = '1' and p_lot >= s.lot_from and (s.lot_to is null or p_lot <= s.lot_to)
$$;

-- The AQL evaluation of a lot (tb-20.ts evaluateAql) of configuration p_cfg, severity p_severity, p_lot tablets, defects
-- found per class p_found ({CRITICAL, MAJOR, MINOR}: count text); NULL when the scheme has no plan for it.
create function tab.aql_evaluate(p_cfg jsonb, p_severity text, p_lot numeric, p_found jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_level  text := p_cfg -> 'aql' ->> 'level';
  v_letter text;
  ma       tab.aql_plan;
  mi       tab.aql_plan;
  v_n      numeric;
  v_crit   numeric := coalesce((p_found ->> 'CRITICAL')::numeric, 0);
  v_major  numeric := coalesce((p_found ->> 'MAJOR')::numeric, 0);
  v_minor  numeric := coalesce((p_found ->> 'MINOR')::numeric, 0);
  v_ok     boolean;
begin
  if v_level is null or p_cfg -> 'aql' ->> 'major' is null or p_cfg -> 'aql' ->> 'minor' is null then
    return null;
  end if;
  v_letter := tab.aql_letter_for(p_lot, v_level);
  select * into ma from tab.aql_plan p where p.code = 'AQL-SINGLE-SAMPLING' and p.version = '1' and p.severity = p_severity and p.letter = v_letter and p.aql = p_cfg -> 'aql' ->> 'major';
  select * into mi from tab.aql_plan p where p.code = 'AQL-SINGLE-SAMPLING' and p.version = '1' and p.severity = p_severity and p.letter = v_letter and p.aql = p_cfg -> 'aql' ->> 'minor';
  if v_letter is null or ma.code is null or mi.code is null then
    return null;
  end if;
  v_n := least(greatest(ma.sample_size, mi.sample_size), p_lot);
  v_ok := v_crit <= 0 and v_major <= ma.ac and v_minor <= mi.ac;
  return jsonb_build_object(
    'scheme', 'AQL-SINGLE-SAMPLING', 'schemeVersion', '1', 'severity', p_severity, 'level', v_level, 'lotSize', p_lot::text, 'letter', v_letter,
    'sampleSize', v_n::text,
    'classes', jsonb_build_object(
      'CRITICAL', jsonb_build_object('ac', '0', 're', '1', 'found', v_crit::text, 'accepted', v_crit <= 0),
      'MAJOR', jsonb_build_object('aql', ma.aql, 'letter', ma.plan_letter, 'n', ma.sample_size::text, 'ac', ma.ac::text, 're', ma.re::text, 'found', v_major::text, 'accepted', v_major <= ma.ac),
      'MINOR', jsonb_build_object('aql', mi.aql, 'letter', mi.plan_letter, 'n', mi.sample_size::text, 'ac', mi.ac::text, 're', mi.re::text, 'found', v_minor::text, 'accepted', v_minor <= mi.ac)),
    'result', case when v_ok then 'ACCEPTED' else 'REJECTED' end);
end
$$;

-- The inspection severity of the next lot of product p_product in installation p_installation (header): the product's
-- lots in the order judged.
create function tab.aql_severity(p_product text, p_installation text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  r        record;
  v_state  text := 'NORMAL';
  v_recent boolean[] := '{}';
  v_run    integer := 0;
begin
  for r in select l.accepted from tab.aql_lot_result l
            where l.product_code = p_product and l.installation = p_installation order by l.recorded_at, l.id loop
    if v_state = 'NORMAL' then
      v_recent := (v_recent || r.accepted)[greatest(1, cardinality(v_recent) - 3):];
      if (select count(*) from unnest(v_recent) a where not a) >= 2 then
        v_state := 'TIGHTENED';
        v_recent := '{}';
        v_run := 0;
      end if;
    else
      v_run := case when r.accepted then v_run + 1 else 0 end;
      if v_run >= 5 then
        v_state := 'NORMAL';
        v_recent := '{}';
        v_run := 0;
      end if;
    end if;
  end loop;
  return v_state;
end
$$;

revoke all on function tab.coat_fixed(numeric, integer), tab.coat_round(numeric, numeric), tab.coat_plain(numeric), tab.coat_sample(jsonb, text),
  tab.coat_gain(numeric, numeric, numeric), tab.coat_gain_cmp(numeric, numeric, numeric, numeric), tab.aql_letter_for(numeric, text),
  tab.aql_evaluate(jsonb, text, numeric, jsonb), tab.aql_severity(text, text) from public;
-- The screens show the severity the next lot will be inspected at (display; the guard decides).
grant execute on function tab.aql_severity(text, text) to ebmr_app;

reset role;
