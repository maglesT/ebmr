-- Recipe core, execution store (module C3): a limit exception is stored as the value and the MBR's limits give it
-- (review finding P25, round-2 verification item exec-sql-limit-exception-facts; PR-08, PR-49, DI-26, DI-33, INV-41;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- recipe.check_exception_changes (0298) derives from the command only the facts of an operator's exception
-- (OPERATOR_RAISED), and 0299 proves the time findings. The exception the engine raises when a value is outside a
-- limit tier (LIMIT_BREACH; YIELD_OUT_OF_LIMITS for a yield or reconciliation) was accepted with whatever facts the
-- application wrote. The round-2 verification recorded a blend time of 19 min, outside the internal action limit of
-- 12 to 18 min: the engine raises LIMIT_BREACH, severity ACTION, tier INTERNAL_ACTION, needing a deviation and stopping
-- the step and the steps after it until one is linked. The row stored it as an ALERT of tier ALERT that needs no
-- deviation and stops nothing, QA's honest ceremony then recorded NO_IMPACT, and the batch went on without a deviation
-- (PR-08, PR-49). Only the replay verification noticed.
--
-- The database now judges, as the engine does, every value a row judges against its limits, and derives the exception
-- each verdict raises (recipe.limit_verdicts, recipe.limit_exception_record):
--   * the values: a new data point (a value, not a voided attempt) of a parameter with limits, judged when it is stored,
--     unless it is the endpoint of an enclosing loop whose iteration is not decided yet (engine data.ts storePoint,
--     isLoopEndpointInProgress); the endpoint a loop's exit judges (raiseForEvaluationAtExit: the first valid attempt
--     of the iteration, of its last inner iteration when it is recorded in a loop inside it); a new computed value,
--     against the limits of its calculation and of every yield checkpoint whose result it is (evaluateDerived);
--   * the verdict (limits/evaluate.ts; @ebmr/expr rounding.ts): each reading compared with each tier, outer first
--     (REGISTERED, VALIDATED, INTERNAL_ACTION, ALERT), after rounding as the tier's rule says (USP: half up to the
--     decimals of the limit as written, the finer of the range's two bounds; Ph. Eur.: to the significant figures of
--     the bound, a bound of zero by its decimals), inclusive or strict; the worst reading of a series governs; the most
--     severe tier breached decides what the breach requires;
--   * the exception (exceptions.ts tierDraft, tx.ts raise): type, category OUT_OF_LIMIT, controls, tier, severity
--     (ALERT, ACTION or CRITICAL), the need of a deviation (ACTION, REGISTERED and VALIDATED; every yield), the QA-only,
--     registration, stage and release flags, the title (the subject, the value, the unit, the rounded value compared,
--     the tiers breached and what the breach requires), the source (step instance, step, frames, item, point or
--     computed value), the raiser (the row's person) and the block: for ACTION the steps after the measuring step until
--     a deviation is linked, and the measuring step too unless the MBR lets it continue; for REGISTERED and VALIDATED
--     both; its downstream anchor is the step's node (task:<step>) with the step's frames;
--   * the value judged records that verdict: its evaluation's requirement and tier breached (a data point), marked
--     failed when a tier is breached (exactly the verdict at a loop's exit), and naming the exception.
-- A row adds exactly the limit exceptions of its verdicts, each equal to the derived record apart from its time of
-- raising (raisedAt, raisedSeq); anything else is refused (EBMR-EXE-044). So an action-limit breach stored as an ALERT,
-- without its need of a deviation or its block, relabelled to another tier or type, left out, or added by a row that
-- judges no such value, is refused, and an exception that needs a deviation cannot be dispositioned NO_IMPACT
-- (check_disposition_state, 0270).
--
-- Stricter than the engine, stated so it is not over-read: the database compares a value with limits written in the
-- same unit only, or in one that differs from it only in UCUM annotations (factor 1); the engine converts a value in
-- any other unit of the same dimension, and the database has no unit conversion. A value of a parameter with limits
-- must be of the parameter's type (a number, a count, or its number of readings), and the step instance a verdict
-- reads is filed under its own key (its step and the context of its frames). Such a row is refused rather than
-- recorded with a verdict nobody proved.
-- What stays with the replay verification (ADR 0010): the computed value itself (the database judges the value the
-- state records; it does not re-run the calculation), the evaluation text of a point (its detail lines and language
-- version) and the evaluation of a computed value, and every other exception type: the flow findings
-- (DECISION_NOT_EVALUABLE, REPLICATE_COUNT_INVALID, LOOP_EXHAUSTED), ACCEPTANCE_CRITERION_FAILED, CALCULATION_FAILED,
-- the post-entry and repeat findings, and the blocks' own types; for those the database checks only that they are
-- raised open, by the row's person, told by their event and kept as raised (0270, 0280, 0299).
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility (STABLE), the search_path and the
-- privileges (none for PUBLIC) of recipe.check_exception_changes (0270, 0298). The new helpers are pure, private to the
-- owner and pin their search_path. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Rounding and comparison with one bound (@ebmr/expr rounding.ts)
-- ---------------------------------------------------------------------------------------------

-- Decimal places of a decimal as written ("95.0" -> 1, "105" -> 0; writtenDecimals).
create function recipe.written_decimals(p text) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when strpos(p, '.') = 0 then 0 else length(p) - strpos(p, '.') end
$$;

-- Significant figures of a decimal as written, every digit after the leading zeros counting ("140" -> 3, "0.10" -> 2);
-- NULL for zero, which has none (writtenSignificantFigures).
create function recipe.written_significant_figures(p text) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select nullif(length(ltrim(replace(replace(p, '-', ''), '.', ''), '0')), 0)
$$;

-- The base-10 exponent of the most significant digit (94.95 -> 1, 0.05 -> -2, 0 -> 0; Dec.exponent).
create function recipe.decimal_exponent(p numeric) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p = 0 then 0
              when abs(p) >= 1 then length(trunc(abs(p))::text) - 1
              else -(length(split_part(abs(p)::text, '.', 2)) - length(ltrim(split_part(abs(p)::text, '.', 2), '0')) + 1) end
$$;

-- Bound p_bound ({value, inclusive}) of a limit range compared with the full-precision value p_value, rounded as rule
-- p_rule says; p_other is the opposite bound of the range (compareToBound): {pass, rounded}, the rounded value written
-- to the precision used (displayAt). NULL when the bound, the opposite bound or the rule is not one the engine compares
-- with (the engine stops there; nothing then matches, so the row is refused).
create function recipe.limit_bound_check(p_value numeric, p_bound jsonb, p_other jsonb, p_side text, p_rule text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_b   text := case when jsonb_typeof(p_bound -> 'value') = 'string' then p_bound ->> 'value' end;
  v_o   text := case when jsonb_typeof(p_other -> 'value') = 'string' then p_other ->> 'value' end;
  v_inc boolean := (p_bound -> 'inclusive') is distinct from 'false'::jsonb;
  v_sf  integer;
  v_r   numeric;
  v_txt text;
  v_bn  numeric;
begin
  if p_value is null or jsonb_typeof(p_bound) is distinct from 'object' or v_b is null or v_b !~ '^-?[0-9]+(\.[0-9]+)?$'
     or (p_other is not null and (v_o is null or v_o !~ '^-?[0-9]+(\.[0-9]+)?$')) or p_side not in ('LOW', 'HIGH') then
    return null;
  end if;
  if p_rule = 'USP_HALF_UP_AT_LIMIT_DECIMALS' then
    -- Half up (away from zero) to the decimals of the limit as written, the finer of the two bounds.
    v_r := round(p_value, greatest(recipe.written_decimals(v_b), coalesce(recipe.written_decimals(v_o), 0)));
    v_txt := v_r::text;
  elsif p_rule = 'PH_EUR_SIG_FIGS' then
    v_sf := recipe.written_significant_figures(v_b);
    if v_sf is null then
      -- A limit of zero has no significant figures: its own decimal places are used.
      v_r := round(p_value, recipe.written_decimals(v_b));
      v_txt := v_r::text;
    else
      v_r := round(p_value, v_sf - 1 - recipe.decimal_exponent(p_value));
      v_txt := round(v_r, greatest(0, v_sf - 1 - recipe.decimal_exponent(v_r)))::text;
    end if;
  else
    return null;
  end if;
  v_bn := v_b::numeric;
  return jsonb_build_object('pass', case when p_side = 'LOW' then (case when v_inc then v_r >= v_bn else v_r > v_bn end)
                                         else (case when v_inc then v_r <= v_bn else v_r < v_bn end) end,
                            'rounded', v_txt);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The verdict on a value (limits/evaluate.ts evaluateLimits, engine data.ts evaluateValue)
-- ---------------------------------------------------------------------------------------------

-- One reading p_value (a decimal as written, in the unit of the limits) judged against limit specification p_spec:
-- {value, requirement, rank (0 none, 1 alert, 2 internal action, 3 registered or validated), breached (the most severe
-- tier breached), rounded (the value that tier compared), where (every tier breached, and which bound),
-- continueAllowed}. The tiers are taken outer first, so the first tier breached is the most severe. NULL when the
-- database cannot judge it as the engine does: a value, tier, bound or rounding rule the engine does not compare with.
create function recipe.limit_reading(p_spec jsonb, p_value text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_tiers   constant text[] := array['REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT'];
  v_ranks   constant integer[] := array[3, 3, 2, 1];
  v         numeric;
  r         jsonb;
  lo        jsonb;
  hi        jsonb;
  v_rank    integer := 0;
  v_tier    text;
  v_rounded text;
  v_where   text[] := '{}';
begin
  if jsonb_typeof(p_spec) is distinct from 'object' or jsonb_typeof(p_spec -> 'ranges') is distinct from 'array'
     or jsonb_typeof(p_spec -> 'unit') is distinct from 'string' or p_value is null or p_value !~ '^-?[0-9]+(\.[0-9]+)?$' then
    return null;
  end if;
  v := p_value::numeric;
  for r in select x from jsonb_array_elements(p_spec -> 'ranges') with ordinality a (x, n)
            order by array_position(v_tiers, case when jsonb_typeof(x) = 'object' then x ->> 'tier' end), n loop
    if jsonb_typeof(r) is distinct from 'object' or not coalesce((r ->> 'tier') = any (v_tiers), false)
       or (r ? 'low' and jsonb_typeof(r -> 'low') is distinct from 'object') or (r ? 'high' and jsonb_typeof(r -> 'high') is distinct from 'object') then
      return null;
    end if;
    lo := case when r ? 'low' then recipe.limit_bound_check(v, r -> 'low', r -> 'high', 'LOW', r ->> 'rounding') end;
    hi := case when r ? 'high' then recipe.limit_bound_check(v, r -> 'high', r -> 'low', 'HIGH', r ->> 'rounding') end;
    if (r ? 'low' and lo is null) or (r ? 'high' and hi is null) then
      return null;
    end if;
    if (lo -> 'pass') = 'false'::jsonb or (hi -> 'pass') = 'false'::jsonb then
      v_where := v_where || (regexp_replace(lower(r ->> 'tier'), '_', ' ')
                             || case when (lo -> 'pass') = 'false'::jsonb then ' low limit' else '' end
                             || case when (hi -> 'pass') = 'false'::jsonb then ' high limit' else '' end);
      if v_tier is null then
        v_tier := r ->> 'tier';
        v_rank := v_ranks[array_position(v_tiers, v_tier)];
        v_rounded := case when (lo -> 'pass') = 'false'::jsonb then lo ->> 'rounded' else hi ->> 'rounded' end;
      end if;
    end if;
  end loop;
  return jsonb_strip_nulls(jsonb_build_object(
    'value', p_value, 'rank', v_rank, 'breached', v_tier, 'rounded', v_rounded, 'where', array_to_string(v_where, '; '),
    'requirement', (array['NONE', 'REGISTER_ITEM', 'STOP_UNTIL_DEVIATION', 'REGISTRATION_RELEVANT_DEVIATION'])[v_rank + 1],
    'continueAllowed', v_rank = 2 and (p_spec -> 'actionBreach') = '"CONTINUE_CURRENT_STEP_WITH_DEVIATION"'::jsonb));
end
$$;

-- A unit without its annotations ("{tablets}" -> "1", "g{dry}" -> "g"): two units that differ only in annotations
-- measure the same, with the factor 1 (UCUM). The database converts nothing else.
create function recipe.unit_core(p text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(nullif(regexp_replace(p, '\{[^{}]*\}', '', 'g'), ''), '1')
$$;

-- The verdict on value p_value (the state's encoding of a data value) against limit specification p_spec: a number or
-- a count is one reading, a series is judged reading by reading and the worst reading governs (the first of the most
-- severe). A reading in the limits' own unit is compared as written; in a unit that differs from it only in
-- annotations, as the engine converts it (the canonical decimal, factor 1). NULL when the engine judges nothing (a
-- value that is not a number, a count or readings, or no reading); {"problem": ...} when the database cannot judge it
-- as the engine does: a reading in another unit (the engine converts it; the database has no unit conversion), or
-- limits it does not compare with (recipe.limit_reading).
create function recipe.limit_value(p_spec jsonb, p_value jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind     text := case when jsonb_typeof(p_value) = 'object' then p_value ->> 'kind' end;
  v_readings jsonb;
  v_unit     text;
  v_ev       jsonb;
  v_worst    jsonb;
  x          jsonb;
begin
  if v_kind = 'DECIMAL' then
    v_readings := jsonb_build_array(p_value -> 'value');
    v_unit := case when jsonb_typeof(p_value -> 'unit') = 'string' then p_value ->> 'unit' end;
  elsif v_kind = 'COUNT' then
    v_readings := jsonb_build_array(p_value -> 'value');
    v_unit := '1';
  elsif v_kind = 'SERIES' then
    v_readings := p_value -> 'values';
    v_unit := case when jsonb_typeof(p_value -> 'unit') = 'string' then p_value ->> 'unit' end;
  else
    return null;
  end if;
  if jsonb_typeof(v_readings) is distinct from 'array' then
    return jsonb_build_object('problem', 'its readings are malformed');
  end if;
  for x in select e from jsonb_array_elements(v_readings) with ordinality a (e, n) order by n loop
    if jsonb_typeof(x) is distinct from 'string' or (x #>> '{}') !~ '^-?[0-9]+(\.[0-9]+)?$' then
      return jsonb_build_object('problem', 'a reading is not a decimal number written as text');
    end if;
    if v_unit is null or jsonb_typeof(p_spec -> 'unit') is distinct from 'string' or recipe.unit_core(v_unit) <> recipe.unit_core(p_spec ->> 'unit') then
      return jsonb_build_object('problem', format('it is recorded in %s and its limits are written in %s; the database compares a value with its limits in their own unit only',
                                                  coalesce(v_unit, 'no unit'), coalesce(p_spec ->> 'unit', 'no unit')));
    end if;
    v_ev := recipe.limit_reading(p_spec, case when v_unit = p_spec ->> 'unit' then x #>> '{}' else trim_scale((x #>> '{}')::numeric)::text end);
    if v_ev is null then
      return jsonb_build_object('problem', 'its limits hold a tier, bound or rounding rule the engine does not compare with');
    end if;
    if v_worst is null or (v_ev ->> 'rank')::integer > (v_worst ->> 'rank')::integer then
      v_worst := v_ev;
    end if;
  end loop;
  return v_worst;
end
$$;

-- Why value p_value is not of the type of parameter p_param, as the engine accepts a value of a parameter with limits
-- (data.ts validateValue: its number of readings, else a number or a count); NULL when it is, or when the parameter
-- takes no number.
create function recipe.limit_value_type_problem(p_param jsonb, p_value jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  -- CASE orders the checks: a number of readings or a length is read only from a member of the right type.
  select case
    when q.r > 1 then
      case when jsonb_typeof(p_value) is distinct from 'object' or p_value ->> 'kind' is distinct from 'SERIES'
                or (case when jsonb_typeof(p_value -> 'values') = 'array' then jsonb_array_length(p_value -> 'values') end) is distinct from q.r
           then format('the parameter is captured as %s readings, and the value is not', q.r) end
    when p_param ->> 'valueType' in ('DECIMAL', 'COUNT')
         and (jsonb_typeof(p_value) is distinct from 'object' or p_value ->> 'kind' is distinct from p_param ->> 'valueType')
      then format('the parameter takes a %s, and the value is %s', lower(p_param ->> 'valueType'),
                  coalesce(lower(case when jsonb_typeof(p_value) = 'object' then p_value ->> 'kind' end), 'malformed'))
  end
    from (select case when jsonb_typeof(p_param -> 'readings') = 'number' then (p_param ->> 'readings')::numeric end as r) q
$$;

-- ---------------------------------------------------------------------------------------------
-- The exception a verdict raises (exceptions.ts tierDraft, tx.ts raise)
-- ---------------------------------------------------------------------------------------------

-- The exception the engine raises for verdict p_ev (recipe.limit_value) on the value p_ref ({"point": id} or
-- {"derived": id}) of kind p_kind (PARAMETER or CALCULATION: LIMIT_BREACH; YIELD: YIELD_OUT_OF_LIMITS), named
-- p_subject, of item p_item, judged against limits p_spec, in step instance p_inst whose node in the execution graph is
-- p_node, in the row of person p_by: every fact but its id and time of raising (raisedAt, raisedSeq). NULL when the
-- verdict breaches no tier (the engine raises nothing).
create function recipe.limit_exception_record(p_kind text, p_subject text, p_item text, p_spec jsonb, p_ev jsonb, p_inst jsonb, p_node text,
                                              p_ref jsonb, p_by text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_yield boolean := p_kind = 'YIELD';
  v_rank  integer := (p_ev ->> 'rank')::integer;
  v_base  text;
  v_rec   jsonb;
  v_step  boolean;
begin
  if jsonb_typeof(p_ev) is distinct from 'object' or p_ev ->> 'breached' is null or v_rank not in (1, 2, 3) or p_kind not in ('PARAMETER', 'CALCULATION', 'YIELD') then
    return null;
  end if;
  v_base := p_subject || ' ' || (p_ev ->> 'value') || ' ' || (p_spec ->> 'unit')
            || case when p_ev ->> 'rounded' is not null and p_ev ->> 'rounded' <> p_ev ->> 'value' then ' (compared as ' || (p_ev ->> 'rounded') || ')' else '' end
            || ' is outside its ' || regexp_replace(lower(p_ev ->> 'breached'), '_', ' ') || ' limit (' || (p_ev ->> 'where') || ')';
  v_rec := jsonb_build_object(
    'type', case when v_yield then 'YIELD_OUT_OF_LIMITS' else 'LIMIT_BREACH' end, 'category', 'OUT_OF_LIMIT',
    'controls', case when v_yield then '["PR-08", "PR-31", "PR-39", "IN-17"]'::jsonb else '["PR-08"]'::jsonb end,
    'tier', p_ev -> 'breached',
    'source', jsonb_build_object('stepKey', p_inst -> 'key', 'step', p_inst -> 'step', 'frames', p_inst -> 'frames', 'item', p_item) || p_ref,
    'raisedBy', p_by, 'status', 'OPEN');
  if v_rank = 1 then
    -- ALERT: an item in the exception register, nothing blocked (a yield needs its investigation and blocks release).
    return v_rec || jsonb_build_object(
      'title', v_base || ': registered for review', 'severity', 'ALERT', 'deviationRequired', v_yield, 'registrationRelevant', false,
      'qaOnly', false, 'stageSignOffBlocked', false, 'releaseBlocking', v_yield);
  end if;
  if v_rank = 2 then
    -- INTERNAL_ACTION: the steps after it wait until a deviation is linked, this step too unless the MBR lets it continue.
    v_step := (p_ev -> 'continueAllowed') is distinct from 'true'::jsonb;
    v_rec := v_rec || jsonb_build_object(
      'title', v_base || ': ' || case when v_step then 'this step and the steps after it wait' else 'the steps after it wait' end || ' until a deviation is linked',
      'severity', 'ACTION', 'deviationRequired', true, 'registrationRelevant', false, 'qaOnly', false, 'stageSignOffBlocked', false,
      'releaseBlocking', v_yield);
  else
    -- REGISTERED or VALIDATED: a registration-relevant deviation, QA only, stage sign-off and release blocked.
    v_step := true;
    v_rec := v_rec || jsonb_build_object(
      'title', v_base || ': a registration-relevant deviation is mandatory and only QA dispositions it',
      'severity', 'CRITICAL', 'deviationRequired', true, 'registrationRelevant', true, 'qaOnly', true, 'stageSignOffBlocked', true,
      'releaseBlocking', true);
  end if;
  return v_rec || jsonb_build_object('block', jsonb_build_object(
    'steps', case when v_step then jsonb_build_array(p_inst -> 'key') else '[]'::jsonb end, 'until', 'DEVIATION',
    'downstream', jsonb_build_object('node', p_node, 'frames', p_inst -> 'frames')));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The values a row judges, and their verdicts
-- ---------------------------------------------------------------------------------------------

-- The one member of list p_list whose id is p_id (an MBR parameter, calculation); NULL when none or several.
create function recipe.mbr_member(p_list jsonb, p_id text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when count(*) = 1 then (array_agg(m))[1] end
    from jsonb_array_elements(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end) m
   where jsonb_typeof(m) = 'object' and m ->> 'id' = p_id
$$;

-- The first p_n frames of p_frames.
create function recipe.frames_head(p_frames jsonb, p_n integer) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(f.v order by f.i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_frames) = 'array' then p_frames else '[]'::jsonb end) with ordinality f (v, i)
   where f.i <= p_n
$$;

-- The step instance p_key of state p_state, when it is one: filed under its own key, which is its step (p_step when
-- given) and the context of its frames (engine tx.ts stepKey), so the frames the verdict reads are the key's; else NULL.
create function recipe.limit_instance(p_state jsonb, p_key text, p_step text) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when jsonb_typeof(i) = 'object' and i ->> 'key' = p_key and jsonb_typeof(i -> 'step') = 'string'
                   and (p_step is null or i ->> 'step' = p_step) and jsonb_typeof(i -> 'frames') = 'array'
                   and p_key = (i ->> 'step') || '@' || recipe.ctx_key(i -> 'frames') then i end
    from (select case when jsonb_typeof(p_state -> 'steps') = 'object' then p_state -> 'steps' -> p_key end as i) q
$$;

-- The node of step p_step in the execution graph (task:<id> for a phase, hold:<id> for a hold point); NULL when the MBR
-- content p_content has no such step.
create function recipe.step_graph_node(p_content jsonb, p_step text) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case recipe.step_node(p_content, p_step) ->> 'kind' when 'phase' then 'task:' || p_step when 'holdPoint' then 'hold:' || p_step end
$$;

-- Whether item p_item, recorded in a step instance with frames p_frames, is the endpoint of an enclosing loop whose
-- iteration is not decided in decisions p_decisions (data.ts isLoopEndpointInProgress): it is then judged at the loop's
-- exit.
create function recipe.loop_endpoint_waiting(p_content jsonb, p_decisions jsonb, p_item text, p_frames jsonb) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(p_frames) = 'array' then p_frames else '[]'::jsonb end) with ordinality f (v, i)
     where recipe.flow_node_of(p_content, f.v ->> 'construct', 'loop') -> 'exit' ->> 'endpoint' = p_item
       and not coalesce(p_decisions ? ((f.v ->> 'construct') || '@' || recipe.ctx_key(recipe.frames_head(p_frames, f.i::integer))), false))
$$;

-- The values of item p_item a reader in loop iteration p_frames resolves (engine values.ts candidates, resolveAt): in
-- each step instance of that iteration, or of an iteration of a loop inside it, the first valid attempt holding a
-- value; with the indexes of its frames below p_frames (deeper) and whether every one of those frames is a loop's.
create function recipe.loop_exit_candidates(p_content jsonb, p_points jsonb, p_item text, p_frames jsonb)
returns table (point_key text, deeper numeric[], loops_only boolean)
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  -- Members are read through CASE, so a malformed point or frame list gives no candidate instead of an error.
  with pts as (
    select p.key, p.value, q.n,
           case when jsonb_typeof(p.value -> 'frames') = 'array' then p.value -> 'frames' end as frames,
           case when jsonb_typeof(p.value -> 'attempt') = 'number' then (p.value ->> 'attempt')::numeric end as attempt
      from (select case when jsonb_typeof(p_frames) = 'array' then jsonb_array_length(p_frames) end as n) q,
           jsonb_each(case when jsonb_typeof(p_points) = 'object' then p_points else '{}'::jsonb end) p
     where q.n is not null and jsonb_typeof(p.value) = 'object' and p.value ->> 'item' = p_item and p.value ->> 'kind' = 'VALUE'
       and p.value ->> 'status' = 'VALID' and p.value ? 'value'
  )
  select c.key,
         array(select case when jsonb_typeof(f.v -> 'index') = 'number' then (f.v ->> 'index')::numeric end
                 from jsonb_array_elements(c.frames) with ordinality f (v, i) where f.i > c.n order by f.i),
         not exists (select 1 from jsonb_array_elements(c.frames) with ordinality f (v, i)
                      where f.i > c.n and recipe.flow_node_of(p_content, f.v ->> 'construct', 'loop') is null)
    from pts c
   where c.frames is not null and c.attempt is not null and jsonb_array_length(c.frames) >= c.n
     and recipe.ctx_key(recipe.frames_head(c.frames, c.n::integer)) = recipe.ctx_key(p_frames)
     and not exists (select 1 from pts o where o.value ->> 'stepKey' = c.value ->> 'stepKey' and o.attempt < c.attempt)
$$;

-- Why data point p_point does not record verdict p_ev (a tier breached or not: p_breached) as the engine records it
-- (data.ts summarise, storePoint, raiseForEvaluationAtExit): its evaluation's requirement and tier breached, and its
-- failed mark (exactly the verdict when p_exact, at a loop's exit; else at least failed when a tier is breached, a
-- block may mark it failed too). NULL when it does.
create function recipe.limit_mark_problem(p_point jsonb, p_ev jsonb, p_breached boolean, p_exact boolean) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_point -> 'evaluation' ->> 'requirement' is distinct from p_ev ->> 'requirement'
      then format('its evaluation records the requirement %s, and its verdict requires %s', coalesce(p_point -> 'evaluation' ->> 'requirement', 'none'), p_ev ->> 'requirement')
    when (p_point -> 'evaluation' -> 'breached') is distinct from (p_ev -> 'breached')
      then format('its evaluation records %s as the tier breached, and its verdict %s', coalesce(p_point -> 'evaluation' ->> 'breached', 'none'), coalesce(p_ev ->> 'breached', 'none'))
    when p_exact and (p_point -> 'failed') is distinct from to_jsonb(p_breached)
      then format('it is marked failed %s, and its verdict at the loop''s exit is %s', coalesce(p_point ->> 'failed', 'nothing'), case when p_breached then 'a breach' else 'a pass' end)
    when not p_exact and p_breached and (p_point -> 'failed') is distinct from 'true'::jsonb
      then 'it is outside its limits and not marked failed'
  end
$$;

-- Every verdict on a value that the row which moved the state from p_prior to p_state gives, in the row of person p_by
-- (header): one JSON object per verdict, {ref (the value: {"point": id}, {"derived": id}, or {"decision": key} for a
-- loop's exit), what (the value, in words), want (the exception it raises, recipe.limit_exception_record, or null),
-- problem (why the state does not hold the verdict as the engine gives it, or null)}.
create function recipe.limit_verdicts(p_content jsonb, p_prior jsonb, p_state jsonb, p_by text) returns setof jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_p0      jsonb := case when jsonb_typeof(p_prior -> 'points') = 'object' then p_prior -> 'points' else '{}'::jsonb end;
  v_p1      jsonb := case when jsonb_typeof(p_state -> 'points') = 'object' then p_state -> 'points' else '{}'::jsonb end;
  v_d0      jsonb := case when jsonb_typeof(p_prior -> 'derived') = 'object' then p_prior -> 'derived' else '{}'::jsonb end;
  v_d1      jsonb := case when jsonb_typeof(p_state -> 'derived') = 'object' then p_state -> 'derived' else '{}'::jsonb end;
  v_c0      jsonb := case when jsonb_typeof(p_prior -> 'decisions') = 'object' then p_prior -> 'decisions' else '{}'::jsonb end;
  v_c1      jsonb := case when jsonb_typeof(p_state -> 'decisions') = 'object' then p_state -> 'decisions' else '{}'::jsonb end;
  v_params  jsonb := p_content -> 'parameters';
  v_judged  text[] := '{}';
  k         text;
  x         jsonb;
  s         record;
  v_ref     jsonb;
  v_what    text;
  v_param   jsonb;
  v_calc    jsonb;
  v_inst    jsonb;
  v_ev      jsonb;
  v_want    jsonb;
  v_problem text;
  v_dkey    text;
  v_loop    jsonb;
  v_dlen    integer;
  v_n       integer;
  v_failed  boolean;
begin
  -- 1. A value the row stores (data.ts storePoint): judged at once, or kept waiting for its loop's exit.
  for k, x in select e.key, e.value from jsonb_each(v_p1) e where not (v_p0 ? e.key) order by e.key loop
    if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'VALUE' then
      continue;
    end if;
    v_param := recipe.mbr_member(v_params, x ->> 'item');
    if jsonb_typeof(v_param -> 'limits') is distinct from 'object' then
      continue;
    end if;
    v_ref := jsonb_build_object('point', k);
    v_what := format('data point %s (%s of step %s)', k, x ->> 'item', coalesce(x ->> 'stepKey', '(none)'));
    v_want := null;
    v_inst := recipe.limit_instance(p_state, x ->> 'stepKey', x ->> 'step');
    v_problem := case when v_inst is null then 'the step instance it names is not in the state'
                      else recipe.limit_value_type_problem(v_param, x -> 'value') end;
    if v_problem is null then
      if recipe.loop_endpoint_waiting(p_content, v_c0, x ->> 'item', v_inst -> 'frames') then
        if x -> 'evaluation' ->> 'requirement' = 'ENDPOINT_IN_PROGRESS' then
          continue;
        end if;
        v_problem := 'it is the endpoint of a loop whose iteration is not decided yet, judged at the loop''s exit, and the state does not keep it waiting';
      else
        v_ev := recipe.limit_value(v_param -> 'limits', x -> 'value');
        if v_ev ? 'problem' then
          v_problem := v_ev ->> 'problem';
        elsif v_ev is not null then
          v_want := recipe.limit_exception_record('PARAMETER', (v_param ->> 'name') || ' (' || (x ->> 'item') || ')', x ->> 'item', v_param -> 'limits', v_ev,
                                                  v_inst, recipe.step_graph_node(p_content, v_inst ->> 'step'), v_ref, p_by);
          v_problem := recipe.limit_mark_problem(x, v_ev, v_want is not null, false);
        end if;
      end if;
    end if;
    return next jsonb_build_object('ref', v_ref, 'what', v_what, 'want', v_want, 'problem', v_problem);
  end loop;

  -- 2. The verdict on a loop endpoint at the loop's exit (data.ts raiseForEvaluationAtExit), given by the row that
  --    decides the exit (0303 lets one point change its evaluation there).
  for k, x in select e.key, e.value from jsonb_each(v_p1) e
               where jsonb_typeof(v_p0 -> e.key) = 'object' and v_p0 -> e.key -> 'evaluation' ->> 'requirement' = 'ENDPOINT_IN_PROGRESS'
                 and (e.value -> 'evaluation') is distinct from (v_p0 -> e.key -> 'evaluation')
               order by e.key loop
    v_ref := jsonb_build_object('point', k);
    v_what := format('loop endpoint %s (%s of step %s)', k, x ->> 'item', coalesce(x ->> 'stepKey', '(none)'));
    v_want := null;
    v_problem := null;
    v_param := recipe.mbr_member(v_params, x ->> 'item');
    v_inst := recipe.limit_instance(p_state, x ->> 'stepKey', x ->> 'step');
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(v_param -> 'limits') is distinct from 'object' or v_inst is null then
      v_problem := 'it has no limits, or no step instance, that the engine judges at a loop''s exit';
    else
      -- The enclosing loop it is the endpoint of whose exit (EXIT or EXHAUSTED) this row decides for its iteration.
      select count(*), (array_agg(q.dkey))[1], (array_agg(q.node))[1], (array_agg(q.i))[1] into v_n, v_dkey, v_loop, v_dlen
        from (select (f.v ->> 'construct') || '@' || recipe.ctx_key(recipe.frames_head(v_inst -> 'frames', f.i::integer)) as dkey,
                     recipe.flow_node_of(p_content, f.v ->> 'construct', 'loop') as node, f.i::integer as i
                from jsonb_array_elements(v_inst -> 'frames') with ordinality f (v, i)) q
       where q.node -> 'exit' ->> 'endpoint' = x ->> 'item' and not (v_c0 ? q.dkey) and v_c1 -> q.dkey ->> 'outcome' in ('EXIT', 'EXHAUSTED');
      if v_n is distinct from 1 then
        v_problem := 'no exit of a loop it is the endpoint of is decided in this row';
      elsif not exists (select 1 from recipe.loop_exit_candidates(p_content, v_p0, x ->> 'item', recipe.frames_head(v_inst -> 'frames', v_dlen)) c
                         where c.point_key = k and c.loops_only
                           and not exists (select 1 from recipe.loop_exit_candidates(p_content, v_p0, x ->> 'item', recipe.frames_head(v_inst -> 'frames', v_dlen)) o
                                            where o.point_key <> k and o.deeper >= c.deeper)) then
        v_problem := 'it is not the value the exit judges: the first valid attempt of the iteration, of its last inner iteration when it is recorded in a loop inside it';
      else
        v_judged := v_judged || v_dkey;
        v_ev := recipe.limit_value(v_param -> 'limits', x -> 'value');
        if v_ev is null then
          v_problem := 'its value is not a number, a count or readings, which the exit does not judge';
        elsif v_ev ? 'problem' then
          v_problem := v_ev ->> 'problem';
        else
          v_want := recipe.limit_exception_record('PARAMETER', (v_param ->> 'name') || ' (' || (v_param ->> 'id') || ') at the exit of ' || (v_loop ->> 'name'),
                                                  x ->> 'item', v_param -> 'limits', v_ev, v_inst, recipe.step_graph_node(p_content, v_inst ->> 'step'), v_ref, p_by);
          v_problem := recipe.limit_mark_problem(x, v_ev, v_want is not null, true);
        end if;
      end if;
    end if;
    return next jsonb_build_object('ref', v_ref, 'what', v_what, 'want', v_want, 'problem', v_problem);
  end loop;
  -- Every loop exit this row decides judges the endpoint of that iteration when it holds a value to judge.
  for k, x in select e.key, e.value from jsonb_each(v_c1) e
               where not (v_c0 ? e.key) and e.value ->> 'kind' = 'LOOP' and e.value ->> 'outcome' in ('EXIT', 'EXHAUSTED') order by e.key loop
    continue when k = any (v_judged);
    v_loop := recipe.flow_node_of(p_content, x ->> 'construct', 'loop');
    v_param := recipe.mbr_member(v_params, v_loop -> 'exit' ->> 'endpoint');
    continue when jsonb_typeof(v_param -> 'limits') is distinct from 'object';
    if exists (select 1 from recipe.loop_exit_candidates(p_content, v_p0, v_param ->> 'id', x -> 'frames') c
                where v_p0 -> c.point_key -> 'evaluation' ->> 'requirement' = 'ENDPOINT_IN_PROGRESS'
                  and v_p0 -> c.point_key -> 'value' ->> 'kind' in ('DECIMAL', 'COUNT', 'SERIES')) then
      return next jsonb_build_object(
        'ref', jsonb_build_object('decision', k), 'what', format('the exit of loop %s (%s)', x ->> 'construct', k), 'want', null,
        'problem', format('it judges the endpoint %s of that iteration against its limits, and the state gives none of its values that verdict', v_param ->> 'id'));
    end if;
  end loop;

  -- 3. A computed value (data.ts evaluateDerived): against the limits of its calculation, then of every yield
  --    checkpoint whose result it is.
  for k, x in select e.key, e.value from jsonb_each(v_d1) e where not (v_d0 ? e.key) order by e.key loop
    if jsonb_typeof(x) is distinct from 'object' then
      continue;
    end if;
    v_calc := recipe.mbr_member(p_content -> 'calculations', x ->> 'calculation');
    v_ref := jsonb_build_object('derived', k);
    v_inst := recipe.limit_instance(p_state, x ->> 'stepKey', null);
    v_failed := false;
    for s in select 'CALCULATION' as kind, v_calc -> 'limits' as spec, (v_calc ->> 'name') || ' (' || (v_calc ->> 'id') || ')' as subject,
                    v_calc ->> 'id' as item, 0::bigint as n
               where jsonb_typeof(v_calc -> 'limits') = 'object'
             union all
             select 'YIELD', g.v -> 'limits', (g.v ->> 'name') || ' (' || (g.v ->> 'id') || ')', x ->> 'calculation', g.n
               from jsonb_array_elements(case when jsonb_typeof(p_content -> 'yieldCheckpoints') = 'array' then p_content -> 'yieldCheckpoints' else '[]'::jsonb end)
                    with ordinality g (v, n)
              where jsonb_typeof(g.v) = 'object' and g.v ->> 'result' = x ->> 'calculation' and jsonb_typeof(g.v -> 'limits') = 'object'
             order by 5 loop
      v_what := format('computed value %s (%s of step %s, %s)', k, x ->> 'calculation', coalesce(x ->> 'stepKey', '(none)'), s.subject);
      v_want := null;
      v_problem := null;
      v_ev := recipe.limit_value(s.spec, x -> 'value');
      if v_inst is null then
        v_problem := 'the step instance it names is not in the state';
      elsif v_ev ? 'problem' then
        v_problem := v_ev ->> 'problem';
      elsif v_ev is not null then
        v_want := recipe.limit_exception_record(s.kind, s.subject, s.item, s.spec, v_ev, v_inst, recipe.step_graph_node(p_content, v_inst ->> 'step'), v_ref, p_by);
        v_failed := v_failed or v_want is not null;
      end if;
      return next jsonb_build_object('ref', v_ref, 'what', v_what, 'want', v_want, 'problem', v_problem);
    end loop;
    if v_failed and (x -> 'failed') is distinct from 'true'::jsonb then
      return next jsonb_build_object('ref', v_ref, 'what', format('computed value %s (%s of step %s)', k, x ->> 'calculation', coalesce(x ->> 'stepKey', '(none)')),
                                     'want', null, 'problem', 'it is outside its limits and not marked failed');
    end if;
  end loop;
  return;
end
$$;

-- Why the limit exceptions (LIMIT_BREACH, YIELD_OUT_OF_LIMITS) that the row moving the state from p_prior to p_state,
-- of person p_by, adds are not exactly the exceptions its verdicts raise (recipe.limit_verdicts): each one equal to a
-- verdict's record apart from its id and time of raising, named by the value it judges, and none left out. NULL when
-- they are. p_content is the batch's MBR content.
create function recipe.limit_exceptions_problem(p_content jsonb, p_prior jsonb, p_state jsonb, p_by text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_prior -> 'exceptions') = 'object' then p_prior -> 'exceptions' else '{}'::jsonb end;
  e1     jsonb := case when jsonb_typeof(p_state -> 'exceptions') = 'object' then p_state -> 'exceptions' else '{}'::jsonb end;
  v      jsonb;
  v_want jsonb[] := '{}';
  v_ref  jsonb[] := '{}';
  v_what text[] := '{}';
  v_used boolean[] := '{}';
  v_hit  integer;
  k      text;
  x      jsonb;
  y      jsonb;
begin
  for v in select recipe.limit_verdicts(p_content, p_prior, p_state, p_by) loop
    if v ->> 'problem' is not null then
      return format('%s is not recorded with the verdict the engine gives it: %s', v ->> 'what', v ->> 'problem');
    end if;
    if jsonb_typeof(v -> 'want') = 'object' then
      v_want := v_want || (v -> 'want');
      v_ref := v_ref || (v -> 'ref');
      v_what := v_what || (v ->> 'what');
      v_used := v_used || false;
    end if;
  end loop;
  for k, x in select e.key, e.value from jsonb_each(e1) e
               where not (e0 ? e.key) and jsonb_typeof(e.value) = 'object' and e.value ->> 'type' in ('LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS')
               order by e.key loop
    v_hit := null;
    for i in 1 .. coalesce(array_length(v_want, 1), 0) loop
      if not v_used[i] and x ->> 'id' = k and (x - 'id' - 'raisedAt' - 'raisedSeq') = v_want[i] then
        v_hit := i;
        exit;
      end if;
    end loop;
    if v_hit is null then
      return format('exception %s (%s, tier %s, severity %s) is not an exception a verdict of this row raises', k, x ->> 'type',
                    coalesce(x ->> 'tier', 'none'), coalesce(x ->> 'severity', 'none'));
    end if;
    v_used[v_hit] := true;
    y := case when v_ref[v_hit] ? 'point' then p_state -> 'points' -> (v_ref[v_hit] ->> 'point') else p_state -> 'derived' -> (v_ref[v_hit] ->> 'derived') end;
    if not coalesce(jsonb_typeof(y -> 'exceptions') = 'array' and (y -> 'exceptions') @> jsonb_build_array(k), false) then
      return format('%s does not name exception %s, which its verdict raises', v_what[v_hit], k);
    end if;
  end loop;
  for i in 1 .. coalesce(array_length(v_want, 1), 0) loop
    if not v_used[i] then
      return format('%s is outside its %s limit, and the state does not record the %s exception that verdict raises ("%s")', v_what[i],
                    regexp_replace(lower(v_want[i] ->> 'tier'), '_', ' '), v_want[i] ->> 'type', v_want[i] ->> 'title');
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- recipe.check_exception_changes (0298) with the limit verdicts
-- ---------------------------------------------------------------------------------------------

-- DI-26, INV-41, PR-49, PR-13, PR-08: what a row may do to the exceptions of the stored state p_prior. An exception
-- stays in the state (never removed) and as it was raised: its status and disposition change only through an accepted
-- DISPOSITION_EXCEPTION of that exception (checked in full by check_disposition_state), its deviation link only
-- through an accepted ATTACH_DEVIATION of that exception that links the command's reference (trimmed) by the
-- command's person to an open exception without one. An exception the row raises is open, without disposition or
-- link. An accepted RAISE_EXCEPTION raises exactly one operator's exception (OPERATOR_RAISED), with the facts the
-- engine derives from the command (recipe.operator_exception_record); no other row raises one. The limit exceptions
-- the row raises (LIMIT_BREACH, YIELD_OUT_OF_LIMITS) are exactly those the verdicts on the values it judges raise,
-- with the facts the engine derives from the value and the MBR's limits (recipe.limit_exceptions_problem).
create or replace function recipe.check_exception_changes(p_prior jsonb, p_state jsonb, p_kind text, p_cmd jsonb, p_accepted boolean) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := coalesce(p_prior -> 'exceptions', '{}'::jsonb);
  e1        jsonb := p_state -> 'exceptions';
  v_act     text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_ex      text := p_cmd ->> 'exception';
  v_ref     text := recipe.js_trim(p_cmd ->> 'deviationRef');
  v_raise   boolean;
  v_n       integer := 0;
  v_want    jsonb;
  v_cont    jsonb;
  v_loaded  boolean := false;
  v_problem text;
  k         text;
  x0        jsonb;
  x1        jsonb;
begin
  if jsonb_typeof(e0) is distinct from 'object' or jsonb_typeof(e1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  for k, x0 in select key, value from jsonb_each(e0) loop
    x1 := e1 -> k;
    if jsonb_typeof(x1) is distinct from 'object' then
      raise exception using errcode = 'P0001',
        message = format('The state no longer holds exception %s; an exception is never removed (DI-26, INV-41). [EBMR-EXE-044]', k);
    end if;
    if (x1 - 'status' - 'disposition' - 'deviation') is distinct from (x0 - 'status' - 'disposition' - 'deviation') then
      raise exception using errcode = 'P0001',
        message = format('The state changes exception %s as it was raised; an exception is kept as raised (DI-26, INV-41). [EBMR-EXE-044]', k);
    end if;
    if coalesce(x1 -> 'deviation', 'null'::jsonb) is distinct from coalesce(x0 -> 'deviation', 'null'::jsonb)
       and not coalesce(v_act = 'ATTACH_DEVIATION' and v_ex = k and coalesce(x0 -> 'deviation', 'null'::jsonb) = 'null'::jsonb
                         and x0 ->> 'status' = 'OPEN' and coalesce(v_ref, '') <> ''
                         and x1 -> 'deviation' ->> 'ref' = v_ref and x1 -> 'deviation' ->> 'linkedBy' = p_cmd -> 'actor' ->> 'id', false) then
      raise exception using errcode = 'P0001',
        message = format('The state changes the deviation link of exception %s, which this row does not link (PR-49, DI-26). [EBMR-EXE-044]', k);
    end if;
    if ((x1 -> 'status') is distinct from (x0 -> 'status') or (x1 -> 'disposition') is distinct from (x0 -> 'disposition'))
       and not coalesce(v_act = 'DISPOSITION_EXCEPTION' and v_ex = k, false) then
      raise exception using errcode = 'P0001',
        message = format('The state changes the status or disposition of exception %s without its own signed disposition (PR-49, DI-37, INV-41). [EBMR-EXE-044]', k);
    end if;
  end loop;
  for k, x1 in select key, value from jsonb_each(e1) where not (e0 ? key) loop
    if jsonb_typeof(x1) is distinct from 'object' or x1 ->> 'status' is distinct from 'OPEN' or x1 ? 'disposition' or x1 ? 'deviation' then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is raised by this row already dispositioned or linked; a new exception is open (DI-26, PR-49). [EBMR-EXE-044]', k);
    end if;
  end loop;
  -- The operator's exception is the one the command raised (PR-49, PR-13).
  v_raise := coalesce(v_act = 'RAISE_EXCEPTION', false);
  for k, x1 in select key, value from jsonb_each(e1) where not (e0 ? key) and value ->> 'type' = 'OPERATOR_RAISED' order by key loop
    v_n := v_n + 1;
    if not v_raise or v_n > 1 then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is an operator''s exception, which only an accepted RAISE_EXCEPTION raises, one per command; this %s row does not (PR-13, PR-49, DI-26). [EBMR-EXE-044]',
                         k, coalesce(p_kind, 'null'));
    end if;
    if (p_cmd -> 'severity') = '"ACTION"'::jsonb and p_cmd ? 'step' then
      select pk.content into v_cont from recipe.test_package pk where pk.content_hash = p_state ->> 'mbrHash' limit 1;
      v_loaded := true;
    end if;
    v_want := recipe.operator_exception_record(v_cont, p_cmd, k);
    if v_want is null or (x1 - 'raisedAt' - 'raisedSeq') is distinct from v_want then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is not the exception its command raised: its type, severity, need of a deviation, block, QA-only and release-blocking flags, title, source and raiser come from the command (PR-49, PR-13, DI-26). [EBMR-EXE-044]', k);
    end if;
  end loop;
  if v_raise and v_n = 0 then
    raise exception using errcode = 'P0001',
      message = 'The accepted RAISE_EXCEPTION of this row is not recorded in the state as the operator''s exception it raises (PR-13, PR-49, DI-26). [EBMR-EXE-044]';
  end if;
  -- The limit exceptions are those the verdicts on the values the row judges raise (PR-08, PR-49): judged whenever the
  -- row changes a data point or a computed value, or adds a limit exception.
  if (p_state -> 'points') is distinct from (p_prior -> 'points') or (p_state -> 'derived') is distinct from (p_prior -> 'derived')
     or exists (select 1 from jsonb_each(e1) e where not (e0 ? e.key) and e.value ->> 'type' in ('LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS')) then
    if not v_loaded then
      select pk.content into v_cont from recipe.test_package pk where pk.content_hash = p_state ->> 'mbrHash' limit 1;
    end if;
    v_problem := recipe.limit_exceptions_problem(v_cont, p_prior, p_state, p_cmd -> 'actor' ->> 'id');
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('The limit verdicts of this %s row are not recorded as the engine gives them: %s. A value outside a limit tier raises the exception its tier requires, with the type, tier, severity, need of a deviation, block, QA-only, registration, stage and release flags, title, source and raiser that the value and the MBR''s limits give it (PR-08, PR-49, DI-26). [EBMR-EXE-044]',
                         coalesce(p_kind, 'null'), v_problem);
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the new helpers are private to the owner (called only by the definer guard above). CREATE OR REPLACE kept
-- the privileges of recipe.check_exception_changes (none for PUBLIC).
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.written_decimals(text), recipe.written_significant_figures(text), recipe.decimal_exponent(numeric),
                       recipe.limit_bound_check(numeric, jsonb, jsonb, text, text), recipe.limit_reading(jsonb, text), recipe.unit_core(text),
                       recipe.limit_value(jsonb, jsonb), recipe.limit_value_type_problem(jsonb, jsonb),
                       recipe.limit_exception_record(text, text, text, jsonb, jsonb, jsonb, text, jsonb, text),
                       recipe.mbr_member(jsonb, text), recipe.frames_head(jsonb, integer), recipe.limit_instance(jsonb, text, text),
                       recipe.step_graph_node(jsonb, text), recipe.loop_endpoint_waiting(jsonb, jsonb, text, jsonb),
                       recipe.loop_exit_candidates(jsonb, jsonb, text, jsonb), recipe.limit_mark_problem(jsonb, jsonb, boolean, boolean),
                       recipe.limit_verdicts(jsonb, jsonb, jsonb, text), recipe.limit_exceptions_problem(jsonb, jsonb, jsonb, text)
  from public;

reset role;
